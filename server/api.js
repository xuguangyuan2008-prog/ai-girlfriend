import { character } from './character.js'
import { attachDoubao, doubaoConfigured } from './doubao.js'
import { classifyEmotion, emotionConfigured } from './emotion.js'
import { createOpenAISession, openaiConfigured } from './openai.js'
import { handleVideoChat, serveMedia, videoChatConfig } from './videochat/index.js'

export { attachDoubao }

function json(res, status, body) {
  res.statusCode = status
  res.setHeader('Content-Type', 'application/json')
  res.end(JSON.stringify(body))
}

async function readJson(req) {
  let raw = ''
  for await (const chunk of req) {
    raw += chunk
    if (raw.length > 10_000) throw new Error('请求体过大')
  }
  return raw ? JSON.parse(raw) : {}
}

const routes = {
  /** 前端启动时查询：有哪些语音服务可用、默认用哪个 */
  'GET /api/config': () => {
    const providers = []
    if (openaiConfigured()) providers.push('openai')
    if (doubaoConfigured()) providers.push('doubao')
    const preferred = process.env.VOICE_PROVIDER
    return {
      characterName: character.name,
      providers,
      defaultProvider: providers.includes(preferred) ? preferred : providers[0] ?? null,
      emotionApi: emotionConfigured(),
    }
  },

  /** OpenAI：换取短时效 client secret，浏览器拿它直连 */
  'POST /api/session': () => createOpenAISession(),

  /** 视频聊天模式的前端配置 */
  'GET /api/video-chat/config': () => videoChatConfig(),

  /** 给一句台词标注表情（豆包等不支持带外响应的模型用） */
  'POST /api/emotion': async (req) => {
    if (!emotionConfigured()) return [501, { error: '未配置 EMOTION_API_KEY / EMOTION_MODEL' }]
    const { text } = await readJson(req)
    if (typeof text !== 'string' || !text.trim() || text.length > 500) return [400, { error: 'text 无效' }]
    return { raw: await classifyEmotion(text) }
  },
}

/** Connect / Express 通用中间件 */
export async function apiMiddleware(req, res, next) {
  const path = new URL(req.url, 'http://localhost').pathname

  // 这两个要自己写响应（SSE 流 / 视频文件），不走下面的 JSON 路由
  if (req.method === 'GET' && path.startsWith('/media/')) return serveMedia(req, res, path)
  if (req.method === 'POST' && path === '/api/video-chat') {
    try {
      return await handleVideoChat(req, res, await readJson(req))
    } catch (err) {
      return json(res, 400, { error: err.message })
    }
  }

  const route = routes[`${req.method} ${path}`]
  if (!route) return next()
  try {
    const result = await route(req)
    if (Array.isArray(result)) json(res, result[0], result[1])
    else json(res, 200, result)
  } catch (err) {
    console.error(err)
    json(res, 500, { error: err.message })
  }
}
