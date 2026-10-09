import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { character } from '../character.js'
import { videoConfig } from './config.js'
import { generateClip, pickDuration } from './h3.js'
import { h3Prompt } from './prompt.js'
import { writeReply, writerConfigured } from './writer.js'

/**
 * 视频聊天：用户发一句话 → 台词编剧写回复 → H3 拍成视频 → 推给前端。
 * 进度用 SSE（text/event-stream）推送，前端可以实时显示「在想」「在录视频」。
 */

const MAX_HISTORY = 20 // 保留最近 20 条消息作为上下文
const sessions = new Map() // sessionId → { history, busy, touched }

function session(id) {
  let s = sessions.get(id)
  if (!s) {
    s = { history: [], busy: false, touched: Date.now() }
    sessions.set(id, s)
  }
  s.touched = Date.now()
  // 简单清理：超过 6 小时没动的会话
  for (const [key, value] of sessions) if (Date.now() - value.touched > 6 * 3600_000) sessions.delete(key)
  return s
}

// ---------- GPU 排队：一张卡同一时间只跑有限个任务 ----------
let running = 0
const waiting = []

async function withGpuSlot(onQueued, fn) {
  if (running >= videoConfig.concurrency) {
    await new Promise((resolve) => {
      waiting.push(resolve)
      onQueued(waiting.length)
    })
  }
  running++
  try {
    return await fn()
  } finally {
    running--
    waiting.shift()?.()
  }
}

export function videoChatConfig() {
  return {
    characterName: character.name,
    backend: videoConfig.backend,
    writer: writerConfigured() ? 'llm' : 'mock',
    idleUrl: videoConfig.idleUrl,
    posterUrl: videoConfig.posterUrl,
  }
}

/** POST /api/video-chat  body: { sessionId, text } → SSE */
export async function handleVideoChat(req, res, body) {
  const text = typeof body.text === 'string' ? body.text.trim() : ''
  const sessionId = typeof body.sessionId === 'string' ? body.sessionId.slice(0, 64) : ''
  if (!text || text.length > 500 || !sessionId) {
    res.statusCode = 400
    res.setHeader('Content-Type', 'application/json')
    return res.end(JSON.stringify({ error: 'sessionId 和 text 必填，text 不超过 500 字' }))
  }

  const s = session(sessionId)
  if (s.busy) {
    res.statusCode = 409
    res.setHeader('Content-Type', 'application/json')
    return res.end(JSON.stringify({ error: '上一条还在处理中' }))
  }
  s.busy = true

  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no', // 关掉 nginx 缓冲，否则进度会攒着一起到
  })
  const send = (event) => res.write(`data: ${JSON.stringify(event)}\n\n`)
  const abort = new AbortController()
  res.on('close', () => abort.abort(new Error('客户端已断开')))
  const t0 = Date.now()

  try {
    s.history.push({ role: 'user', content: text })
    send({ type: 'thinking' })

    const reply = await writeReply(s.history.slice(-MAX_HISTORY))
    s.history.push({ role: 'assistant', content: JSON.stringify(reply) })
    if (s.history.length > MAX_HISTORY) s.history.splice(0, s.history.length - MAX_HISTORY)

    const durationSeconds = pickDuration(reply.line)
    send({ type: 'reply', ...reply, durationSeconds, writerSeconds: (Date.now() - t0) / 1000 })

    // 生成期间每秒推一次心跳，前端显示已等待时间，也防止代理掐断空闲连接
    const heartbeat = setInterval(() => send({ type: 'progress', elapsed: (Date.now() - t0) / 1000 }), 1000)
    try {
      const clip = await withGpuSlot(
        (position) => send({ type: 'queued', position }),
        () => {
          send({ type: 'rendering' })
          return generateClip({ prompt: h3Prompt(reply), durationSeconds, signal: abort.signal })
        },
      )
      send({ type: 'video', ...clip, file: undefined, elapsed: (Date.now() - t0) / 1000 })
      console.log(
        `[video-chat] ${durationSeconds}s clip, total ${((Date.now() - t0) / 1000).toFixed(1)}s` +
          (clip.inferenceSeconds ? `, inference ${clip.inferenceSeconds.toFixed(1)}s` : ''),
      )
    } finally {
      clearInterval(heartbeat)
    }
  } catch (err) {
    if (!abort.signal.aborted) {
      console.error('[video-chat]', err)
      send({ type: 'error', message: err.message })
    }
  } finally {
    s.busy = false
    send({ type: 'done' })
    res.end()
  }
}

/** GET /media/<file>.mp4：支持 Range 请求（Safari 播放视频必须） */
export async function serveMedia(req, res, path) {
  const name = basename(decodeURIComponent(path.slice('/media/'.length)))
  if (!/^[\w-]+\.mp4$/.test(name)) {
    res.statusCode = 404
    return res.end()
  }
  const file = join(videoConfig.mediaDir, name)
  let info
  try {
    info = await stat(file)
  } catch {
    res.statusCode = 404
    return res.end()
  }
  res.setHeader('Content-Type', 'video/mp4')
  res.setHeader('Accept-Ranges', 'bytes')
  res.setHeader('Cache-Control', 'public, max-age=31536000, immutable')
  const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range ?? '')
  if (range && (range[1] || range[2])) {
    let start = range[1] ? Number(range[1]) : info.size - Number(range[2])
    let end = range[1] && range[2] ? Number(range[2]) : info.size - 1
    start = Math.max(0, start)
    end = Math.min(end, info.size - 1)
    if (start > end) {
      res.statusCode = 416
      res.setHeader('Content-Range', `bytes */${info.size}`)
      return res.end()
    }
    res.statusCode = 206
    res.setHeader('Content-Range', `bytes ${start}-${end}/${info.size}`)
    res.setHeader('Content-Length', end - start + 1)
    return createReadStream(file, { start, end }).pipe(res)
  }
  res.setHeader('Content-Length', info.size)
  createReadStream(file).pipe(res)
}
