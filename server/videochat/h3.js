import { createWriteStream, existsSync } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { videoConfig } from './config.js'

/**
 * MiniMax H3 客户端：调用部署在 GPU 上的 SGLang 服务（/v1/videos）。
 *
 * 用 ref2va 任务：
 *   - 参考图 <Picture 1> + 声音样本 <Audio 1>：保证每段视频长相、声音一致
 *   - 关键帧：第一帧和最后一帧都钉在同一张定妆照上，所有片段首尾相接、和待机视频无缝切换
 */

/** 估算念完一句话要几秒（中文约 0.22 秒/字） */
export function speechSeconds(text) {
  let s = 0
  for (const ch of text) {
    if (/[\p{Script=Han}]/u.test(ch)) s += 0.22
    else if (/[。！？!?…~～]/.test(ch)) s += 0.3
    else if (/[，,、；;：:]/.test(ch)) s += 0.15
    else if (/\S/.test(ch)) s += 0.06
  }
  return s
}

/** 台词时长 + 开口前和说完后的留白，向上取到最近的时长档 */
export function pickDuration(line, buckets = videoConfig.durationBuckets) {
  const needed = speechSeconds(line) + 0.8 + 1.0
  return buckets.find((b) => b >= needed) ?? buckets.at(-1)
}

/**
 * withVoice=false 用于生成不说话的待机视频，不带声音参考。
 * 注意：参考图在服务端一律放大到短边 2048 再编码，竖图比方图多出约 80% 的 token，
 * 所以 portrait 最好用正方形的脸部特写。
 */
export function buildRequest({ prompt, durationSeconds, seed = videoConfig.seed, withVoice = true }) {
  const { anchor, portrait, voice } = videoConfig.assets
  const body = {
    prompt,
    task: 'ref2va',
    // 顺序有语义：决定提示词里 <Picture 1> / <Audio 1> 的编号
    conditions: [
      { type: 'image', uri: portrait, role: 'reference' },
      ...(withVoice ? [{ type: 'audio', uri: voice, role: 'reference' }] : []),
      { type: 'image', uri: anchor, role: 'keyframe', frame_index: 0 },
      { type: 'image', uri: anchor, role: 'keyframe', frame_index: -1 },
    ],
    target: {
      short_edge: videoConfig.shortEdge,
      aspect_ratio: videoConfig.aspectRatio,
      duration_seconds: durationSeconds,
    },
    seed,
    num_inference_steps: videoConfig.steps,
  }
  if (videoConfig.quality) body.quality = videoConfig.quality
  return body
}

function headers(json = true) {
  const h = {}
  if (json) h['Content-Type'] = 'application/json'
  if (videoConfig.apiKey) h.Authorization = `Bearer ${videoConfig.apiKey}`
  return h
}

const sleep = (ms, signal) =>
  new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms)
    signal?.addEventListener('abort', () => {
      clearTimeout(t)
      reject(signal.reason ?? new Error('aborted'))
    })
  })

/**
 * 生成一段视频并下载到本地 mediaDir。
 * 返回 { file, url, seconds, inferenceSeconds, totalSeconds }；mock 模式下 url 可能为 null。
 */
export async function generateClip({ prompt, durationSeconds, seed, withVoice, signal, onStatus }) {
  const started = Date.now()
  if (videoConfig.backend === 'mock') return mockClip({ durationSeconds, started, signal })

  const base = videoConfig.baseUrl
  if (!base) throw new Error('H3_BASE_URL 未设置')

  const createRes = await fetch(`${base}/v1/videos`, {
    method: 'POST',
    headers: headers(),
    body: JSON.stringify(buildRequest({ prompt, durationSeconds, seed, withVoice })),
    signal,
  })
  if (!createRes.ok) throw new Error(`H3 提交失败 (${createRes.status})：${await createRes.text()}`)
  let job = await createRes.json()

  while (job.status !== 'completed') {
    if (job.status === 'failed') throw new Error(`H3 生成失败：${JSON.stringify(job.error ?? job)}`)
    onStatus?.({ status: job.status, progress: job.progress ?? 0 })
    await sleep(400, signal)
    const res = await fetch(`${base}/v1/videos/${job.id}`, { headers: headers(false), signal })
    if (!res.ok) throw new Error(`H3 查询失败 (${res.status})：${await res.text()}`)
    job = await res.json()
  }

  const content = await fetch(`${base}/v1/videos/${job.id}/content`, { headers: headers(false), signal })
  if (!content.ok || !content.body) throw new Error(`H3 下载失败 (${content.status})`)
  await mkdir(videoConfig.mediaDir, { recursive: true })
  const name = `${job.id.replace(/[^\w-]/g, '')}.mp4`
  const file = join(videoConfig.mediaDir, name)
  await pipeline(Readable.fromWeb(content.body), createWriteStream(file))

  return {
    file,
    url: `/media/${name}`,
    seconds: durationSeconds,
    inferenceSeconds: job.inference_time_s ?? null,
    totalSeconds: (Date.now() - started) / 1000,
  }
}

/** 本地调试：模拟生成耗时，有 public/video/mock-reply.mp4 就用它当回复视频 */
async function mockClip({ durationSeconds, started, signal }) {
  await sleep(Number(process.env.H3_MOCK_DELAY_MS) || 2000, signal)
  const mock = 'public/video/mock-reply.mp4'
  return {
    file: null,
    url: existsSync(mock) ? '/video/mock-reply.mp4' : null,
    seconds: durationSeconds,
    inferenceSeconds: null,
    totalSeconds: (Date.now() - started) / 1000,
  }
}
