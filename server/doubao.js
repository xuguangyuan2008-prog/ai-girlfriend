import { randomUUID } from 'node:crypto'
import { gunzipSync, gzipSync } from 'node:zlib'
import { WebSocket, WebSocketServer } from 'ws'
import { character } from './character.js'

/**
 * 豆包端到端实时语音大模型的中转。
 *
 * 豆包用 WebSocket + 自定义二进制帧，鉴权信息放在请求头里，浏览器原生 WebSocket 设置不了请求头，
 * 所以浏览器先连到这里（/api/doubao），由服务端再连豆包，并把协议翻译成简单的格式：
 *   浏览器 → 服务端：二进制 = 16kHz 单声道 int16 PCM；文本 = {"type":"text","text":"..."}
 *   服务端 → 浏览器：二进制 = 24kHz 单声道 int16 PCM；文本 = 统一的 JSON 事件（见 handleServerFrame）
 */

const DOUBAO_URL = process.env.DOUBAO_WS_URL || 'wss://openspeech.bytedance.com/api/v3/realtime/dialogue'

export const doubaoConfigured = () =>
  Boolean(process.env.DOUBAO_API_KEY || (process.env.DOUBAO_APP_ID && process.env.DOUBAO_ACCESS_KEY))

// ---------- 二进制帧 ----------
// header 4 字节：版本(4bit)|头长度(4bit)  消息类型(4bit)|标志(4bit)  序列化(4bit)|压缩(4bit)  保留(8bit)
const MSG_FULL_CLIENT = 0b0001
const MSG_AUDIO_ONLY_CLIENT = 0b0010
const MSG_FULL_SERVER = 0b1001
const MSG_AUDIO_ONLY_SERVER = 0b1011
const MSG_ERROR = 0b1111
const FLAG_HAS_SEQUENCE = 0b0010
const FLAG_HAS_EVENT = 0b0100
const SERIAL_NONE = 0b0000
const SERIAL_JSON = 0b0001
const COMPRESS_GZIP = 0b0001

// 客户端事件
const E = {
  StartConnection: 1,
  FinishConnection: 2,
  StartSession: 100,
  FinishSession: 102,
  TaskRequest: 200, // 上行音频
  ChatTextQuery: 501, // 文字提问
}

// 服务端事件
const S = {
  ConnectionStarted: 50,
  ConnectionFailed: 51,
  SessionStarted: 150,
  SessionFinished: 152,
  SessionFailed: 153,
  TTSSentenceStart: 350,
  TTSResponse: 352,
  TTSEnded: 359,
  ASRInfo: 450, // 检测到用户开口，客户端应立即停止播放（打断）
  ASRResponse: 451,
  ASREnded: 459,
  ChatResponse: 550,
  ChatEnded: 559,
  DialogCommonError: 599,
}

function u32(n) {
  const b = Buffer.alloc(4)
  b.writeUInt32BE(n)
  return b
}

function encodeFrame({ event, sessionId, payload, audio = false }) {
  const header = Buffer.from([
    0x11, // 版本 1，头长度 1×4 字节
    ((audio ? MSG_AUDIO_ONLY_CLIENT : MSG_FULL_CLIENT) << 4) | FLAG_HAS_EVENT,
    ((audio ? SERIAL_NONE : SERIAL_JSON) << 4) | COMPRESS_GZIP,
    0x00,
  ])
  const body = gzipSync(audio ? payload : Buffer.from(JSON.stringify(payload)))
  const parts = [header, u32(event)]
  if (sessionId !== undefined) {
    const sid = Buffer.from(sessionId)
    parts.push(u32(sid.length), sid)
  }
  parts.push(u32(body.length), body)
  return Buffer.concat(parts)
}

function decodeFrame(buf) {
  const headerSize = (buf[0] & 0x0f) * 4
  const type = buf[1] >> 4
  const flags = buf[1] & 0x0f
  const serial = buf[2] >> 4
  const compress = buf[2] & 0x0f
  let p = headerSize
  const out = { type }

  if (type === MSG_ERROR) {
    out.code = buf.readUInt32BE(p)
    p += 4
  } else if (type === MSG_FULL_SERVER || type === MSG_AUDIO_ONLY_SERVER) {
    if (flags & FLAG_HAS_SEQUENCE) p += 4
    if (flags & FLAG_HAS_EVENT) {
      out.event = buf.readUInt32BE(p)
      p += 4
    }
    const sidLen = buf.readInt32BE(p)
    p += 4 + Math.max(0, sidLen)
  } else {
    return out
  }

  const size = buf.readUInt32BE(p)
  p += 4
  let payload = buf.subarray(p, p + size)
  if (compress === COMPRESS_GZIP) payload = gunzipSync(payload)
  if (serial === SERIAL_JSON) {
    try {
      out.payload = JSON.parse(payload.toString('utf8'))
    } catch {
      out.payload = payload.toString('utf8')
    }
  } else {
    out.payload = payload
  }
  return out
}

// ---------- 会话 ----------
function upstreamHeaders() {
  const connectId = randomUUID()
  const headers = {
    'X-Api-Resource-Id': process.env.DOUBAO_RESOURCE_ID || 'volc.speech.dialog',
    'X-Api-Connect-Id': connectId,
  }
  if (process.env.DOUBAO_API_KEY) {
    headers['X-Api-Key'] = process.env.DOUBAO_API_KEY
  } else {
    headers['X-Api-App-ID'] = process.env.DOUBAO_APP_ID
    headers['X-Api-Access-Key'] = process.env.DOUBAO_ACCESS_KEY
    headers['X-Api-App-Key'] = 'PlgvMymc7f3tQnJ6' // 官方文档中的固定值
  }
  return headers
}

// SC / SC2.0 的官方克隆音色（ICL_ / saturn_ 开头）在服务端已经配好了角色描述，不需要也不应该再传人设
const hasBuiltInCharacter = (speaker) => /^(ICL_|saturn_)/.test(speaker)

function startSessionPayload(sessionId) {
  const speaker = character.doubaoSpeaker
  const extra = {
    strict_audit: false,
    // 页面有静音按钮：静音时不上传音频，靠 keep_alive 避免音频流超时
    input_mod: 'keep_alive',
  }
  if (process.env.DOUBAO_MODEL) extra.model = process.env.DOUBAO_MODEL

  const dialog = { dialog_id: sessionId, extra }
  if (!hasBuiltInCharacter(speaker)) {
    // O / O2.0 版本的人设字段
    dialog.bot_name = character.name
    dialog.system_role = character.instructions
    dialog.speaking_style = character.speakingStyle
  }

  return {
    asr: {
      extra: { end_smooth_window_ms: Number(process.env.DOUBAO_END_SMOOTH_MS) || 800 },
    },
    tts: {
      speaker,
      // 单声道 24kHz 16bit 小端（默认是 OGG Opus，不方便直接播放）
      audio_config: { channel: 1, format: 'pcm_s16le', sample_rate: 24000 },
    },
    dialog,
  }
}

function bridge(client) {
  const sessionId = randomUUID()
  const send = (msg) => client.readyState === WebSocket.OPEN && client.send(JSON.stringify(msg))
  const fail = (message) => {
    console.error('[doubao]', message)
    send({ type: 'error', message })
    client.close()
  }

  if (!doubaoConfigured()) return fail('豆包未配置：请在 .env 中设置 DOUBAO_APP_ID 和 DOUBAO_ACCESS_KEY')

  const upstream = new WebSocket(DOUBAO_URL, { headers: upstreamHeaders(), handshakeTimeout: 10_000 })
  let sessionReady = false
  const startTimeout = setTimeout(() => sessionReady || fail('豆包会话启动超时'), 15_000)

  upstream.on('unexpected-response', (_req, res) => {
    let body = ''
    res.on('data', (c) => (body += c))
    res.on('end', () => fail(`连接豆包失败 (${res.statusCode})：${body || '请检查 APP ID / Access Key 以及是否已开通端到端实时语音'}`))
  })
  upstream.on('error', (err) => fail(`豆包连接出错：${err.message}`))
  upstream.on('close', () => client.close())

  upstream.on('open', () => {
    upstream.send(encodeFrame({ event: E.StartConnection, payload: {} }))
  })

  upstream.on('message', (data) => {
    let frame
    try {
      frame = decodeFrame(data)
    } catch (err) {
      return console.error('[doubao] 无法解析的帧', err)
    }
    if (frame.type === MSG_ERROR) {
      return send({ type: 'error', message: `豆包错误 ${frame.code}：${JSON.stringify(frame.payload)}` })
    }
    const p = frame.payload
    switch (frame.event) {
      case S.ConnectionStarted:
        upstream.send(encodeFrame({ event: E.StartSession, sessionId, payload: startSessionPayload(sessionId) }))
        break
      case S.ConnectionFailed:
      case S.SessionFailed:
        fail(`豆包会话失败：${JSON.stringify(p)}`)
        break
      case S.SessionStarted:
        sessionReady = true
        clearTimeout(startTimeout)
        send({ type: 'ready', model: process.env.DOUBAO_MODEL || 'doubao-realtime' })
        break
      case S.SessionFinished:
        client.close()
        break
      case S.ASRInfo:
        send({ type: 'user.speech_started' })
        break
      case S.ASRResponse: {
        const r = p?.results?.[0]
        const text = r?.alternatives?.[0]?.text ?? r?.text
        if (r && !r.is_interim && text) send({ type: 'user.transcript', text })
        break
      }
      case S.ASREnded:
        send({ type: 'user.speech_stopped' })
        break
      case S.ChatResponse:
        if (p?.content) send({ type: 'assistant.text_delta', delta: p.content })
        break
      case S.ChatEnded:
        send({ type: 'assistant.text_done' })
        break
      case S.TTSSentenceStart:
        if (p?.text) send({ type: 'assistant.sentence', text: p.text })
        break
      case S.TTSResponse:
        if (client.readyState === WebSocket.OPEN) client.send(frame.payload, { binary: true })
        break
      case S.TTSEnded:
        send({ type: 'assistant.audio_done' })
        break
      case S.DialogCommonError:
        send({ type: 'error', message: `豆包错误：${p?.message ?? JSON.stringify(p)}` })
        break
    }
  })

  client.on('message', (data, isBinary) => {
    if (!sessionReady || upstream.readyState !== WebSocket.OPEN) return
    if (isBinary) {
      upstream.send(encodeFrame({ event: E.TaskRequest, sessionId, payload: data, audio: true }))
      return
    }
    let msg
    try {
      msg = JSON.parse(data.toString())
    } catch {
      return
    }
    if (msg.type === 'text' && msg.text) {
      upstream.send(encodeFrame({ event: E.ChatTextQuery, sessionId, payload: { content: msg.text } }))
    }
  })

  client.on('close', () => {
    clearTimeout(startTimeout)
    if (upstream.readyState === WebSocket.OPEN) {
      if (sessionReady) upstream.send(encodeFrame({ event: E.FinishSession, sessionId, payload: {} }))
      upstream.send(encodeFrame({ event: E.FinishConnection, payload: {} }))
      setTimeout(() => upstream.close(), 500)
    } else if (upstream.readyState === WebSocket.CONNECTING) {
      upstream.terminate()
    }
  })
}

/**
 * 挂到 HTTP 服务器上，处理 /api/doubao 的 WebSocket 升级。
 * rejectOthers：服务器上没有别的 WebSocket 服务时设为 true，其它路径的升级请求直接断开，免得连接一直挂着
 * （开发时 Vite 的热更新也走 WebSocket，所以不能设）。
 */
export function attachDoubao(httpServer, { rejectOthers = false } = {}) {
  const wss = new WebSocketServer({ noServer: true })
  httpServer.on('upgrade', (req, socket, head) => {
    if (new URL(req.url, 'http://localhost').pathname === '/api/doubao') {
      wss.handleUpgrade(req, socket, head, (ws) => bridge(ws))
    } else if (rejectOthers) {
      socket.destroy()
    }
  })
}

export const _test = { encodeFrame, decodeFrame }
