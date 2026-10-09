import './style.css'

/**
 * 视频聊天：发一句话，她回一段视频。
 * 等待时循环播放待机视频；回复视频的首尾帧和待机视频是同一张定妆照，切换时几乎看不出接缝。
 */

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T
const ui = {
  poster: $<HTMLImageElement>('poster'),
  idle: $<HTMLVideoElement>('idle'),
  reply: $<HTMLVideoElement>('reply'),
  charName: $('charName'),
  status: $('status'),
  subtitle: $('subtitle'),
  tapToPlay: $<HTMLButtonElement>('tapToPlay'),
  log: $<HTMLUListElement>('log'),
  composer: $<HTMLFormElement>('composer'),
  input: $<HTMLInputElement>('input'),
  send: $<HTMLButtonElement>('send'),
}

interface Config {
  characterName: string
  backend: string
  writer: string
  idleUrl: string
  posterUrl: string
}

type ChatEvent =
  | { type: 'thinking' }
  | { type: 'reply'; line: string; emotion: string; action: string; durationSeconds: number; writerSeconds: number }
  | { type: 'queued'; position: number }
  | { type: 'rendering' }
  | { type: 'progress'; elapsed: number }
  | { type: 'video'; url: string | null; seconds: number; inferenceSeconds: number | null; elapsed: number }
  | { type: 'error'; message: string }
  | { type: 'done' }

// ---------- 小工具 ----------
const storage = {
  get(key: string) {
    try {
      return localStorage.getItem(key)
    } catch {
      return null
    }
  },
  set(key: string, value: string) {
    try {
      localStorage.setItem(key, value)
    } catch {
      // 隐私模式等情况下不可用，忽略
    }
  },
}

const sessionId =
  storage.get('videoChatSession') ??
  (() => {
    const id = crypto.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`
    storage.set('videoChatSession', id)
    return id
  })()

/** 记住「生成 1 秒视频要等几秒」，用来显示预计等待时间 */
const eta = {
  ratio: Number(storage.get('videoChatEtaRatio')) || 0,
  record(waitSeconds: number, clipSeconds: number) {
    const r = waitSeconds / clipSeconds
    this.ratio = this.ratio ? this.ratio * 0.6 + r * 0.4 : r
    storage.set('videoChatEtaRatio', String(this.ratio))
  },
  estimate(clipSeconds: number) {
    return this.ratio ? Math.round(this.ratio * clipSeconds) : null
  },
}

function setStatus(text: string | null) {
  ui.status.hidden = !text
  if (text) ui.status.textContent = text
}

function addLog(role: 'user' | 'assistant', text: string) {
  const li = document.createElement('li')
  li.className = role
  li.textContent = text
  ui.log.append(li)
  while (ui.log.children.length > 3) ui.log.firstElementChild!.remove()
}

// ---------- 画面 ----------
let config: Config | null = null

async function init() {
  config = await fetch('/api/video-chat/config').then((r) => r.json())
  ui.charName.textContent = config!.characterName
  ui.poster.src = config!.posterUrl
  ui.poster.onload = () => (ui.poster.hidden = false)
  ui.idle.src = config!.idleUrl
  ui.idle.onerror = () => (ui.idle.hidden = true) // 还没生成待机视频时，显示定妆照
  ui.idle.play().catch(() => {})
  if (config!.backend === 'mock') setStatus('本地调试模式：不会真的生成视频（未配置 H3_BASE_URL）')
}

/**
 * iOS / Chrome 只允许在用户操作时开始有声播放。
 * 在第一次点击发送时「解锁」回复视频元素，之后生成好的视频才能自动带声音播放。
 */
let unlocked = false
function unlockAudio() {
  if (unlocked) return
  unlocked = true
  const v = ui.reply
  v.muted = true
  v.src = config?.idleUrl ?? ''
  v.play()
    .then(() => {
      v.pause()
      v.muted = false
    })
    .catch(() => (v.muted = false))
}

/** 等视频能播了再切换，避免切过去是黑屏 */
function loadVideo(v: HTMLVideoElement, url: string) {
  return new Promise<void>((resolve, reject) => {
    v.src = url
    v.oncanplay = () => resolve()
    v.onerror = () => reject(new Error('视频加载失败'))
    v.load()
  })
}

async function playReply(url: string | null, line: string, seconds: number) {
  ui.subtitle.textContent = line
  ui.subtitle.hidden = false
  // 她说话时只看字幕，聊天记录先收起来，播完再把这句加进去
  ui.log.classList.add('away')
  try {
    await playClip(url, seconds)
  } finally {
    ui.subtitle.hidden = true
    ui.log.classList.remove('away')
    addLog('assistant', line)
  }
}

async function playClip(url: string | null, seconds: number) {
  if (!url) {
    // 本地调试没有视频：只显示字幕
    await new Promise((r) => setTimeout(r, seconds * 1000))
    return
  }

  await loadVideo(ui.reply, url)
  ui.reply.muted = false
  ui.reply.currentTime = 0
  try {
    await ui.reply.play()
  } catch {
    // 浏览器拦截了自动播放：让用户点一下
    ui.tapToPlay.hidden = false
    await new Promise<void>((resolve) => {
      ui.tapToPlay.onclick = () => {
        ui.tapToPlay.hidden = true
        ui.reply.play().then(resolve, resolve)
      }
    })
  }
  ui.reply.classList.add('on')
  ui.idle.pause()

  await new Promise<void>((resolve) => (ui.reply.onended = () => resolve()))
  // 回复视频最后一帧就是定妆照：待机视频从头开始播，接上
  ui.idle.currentTime = 0
  ui.idle.play().catch(() => {})
  ui.reply.classList.remove('on')
}

// ---------- 发送 ----------
async function* readEvents(res: Response): AsyncGenerator<ChatEvent> {
  const reader = res.body!.pipeThrough(new TextDecoderStream()).getReader()
  let buffer = ''
  while (true) {
    const { value, done } = await reader.read()
    if (done) return
    buffer += value
    let idx: number
    while ((idx = buffer.indexOf('\n\n')) >= 0) {
      const chunk = buffer.slice(0, idx)
      buffer = buffer.slice(idx + 2)
      const data = chunk
        .split('\n')
        .filter((l) => l.startsWith('data:'))
        .map((l) => l.slice(5).trim())
        .join('')
      if (data) yield JSON.parse(data)
    }
  }
}

let busy = false

ui.composer.onsubmit = async (e) => {
  e.preventDefault()
  const text = ui.input.value.trim()
  if (!text || busy) return
  unlockAudio()
  busy = true
  ui.send.disabled = true
  ui.input.value = ''
  addLog('user', text)

  let line = ''
  let clipSeconds = 0
  let renderStart = 0
  try {
    const res = await fetch('/api/video-chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId, text }),
    })
    if (!res.ok || !res.body) throw new Error((await res.json().catch(() => null))?.error ?? `请求失败 (${res.status})`)

    for await (const ev of readEvents(res)) {
      switch (ev.type) {
        case 'thinking':
          setStatus('她在想怎么回你…')
          break
        case 'reply':
          line = ev.line
          clipSeconds = ev.durationSeconds
          break
        case 'queued':
          setStatus(`排队中，前面还有 ${ev.position} 个`)
          break
        case 'rendering':
          renderStart = performance.now()
          setStatus('她在录视频…')
          break
        case 'progress': {
          if (!renderStart) break
          const waited = Math.round((performance.now() - renderStart) / 1000)
          const total = eta.estimate(clipSeconds)
          setStatus(total ? `她在录视频… ${waited}s / 约 ${total}s` : `她在录视频… ${waited}s`)
          break
        }
        case 'video':
          if (renderStart && ev.url) eta.record((performance.now() - renderStart) / 1000, ev.seconds)
          setStatus(null)
          await playReply(ev.url, line, ev.seconds)
          break
        case 'error':
          throw new Error(ev.message)
      }
    }
  } catch (err) {
    setStatus(`出错了：${(err as Error).message}`)
    setTimeout(() => setStatus(null), 6000)
  } finally {
    busy = false
    ui.send.disabled = false
  }
}

init().catch((err) => setStatus(`无法连接服务器：${err.message}`))
