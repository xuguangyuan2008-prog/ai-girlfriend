import { EMOTIONS, writerSystemPrompt } from './prompt.js'

/**
 * 台词编剧：根据对话历史写出角色这一轮要说的话，以及表情和动作。
 * 调用任意 OpenAI 兼容的 Chat Completions 接口，默认火山方舟（豆包）。
 * 没配置时用一个固定回复，方便本地调试整条流程。
 */
export const writerConfigured = () => Boolean(process.env.CHAT_API_KEY && process.env.CHAT_MODEL)

const MAX_LINE_CHARS = 60

export async function writeReply(history) {
  if (!writerConfigured()) return mockReply(history)

  const base = (process.env.CHAT_API_BASE || 'https://ark.cn-beijing.volces.com/api/v3').replace(/\/$/, '')
  const isArk = base.includes('volces.com')
  const res = await fetch(`${base}/chat/completions`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.CHAT_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: process.env.CHAT_MODEL,
      messages: [{ role: 'system', content: writerSystemPrompt() }, ...history],
      temperature: 0.9,
      // 方舟上的深度思考模型默认会先思考，关掉以降低延迟
      ...(isArk ? { thinking: { type: 'disabled' }, max_tokens: 200 } : {}),
    }),
  })
  if (!res.ok) throw new Error(`台词生成失败 (${res.status}): ${await res.text()}`)
  const data = await res.json()
  return parseReply(data.choices?.[0]?.message?.content ?? '')
}

/** 容错解析：模型偶尔会包代码块或多说几句 */
export function parseReply(raw) {
  const match = raw.match(/\{[\s\S]*\}/)
  let parsed = {}
  if (match) {
    try {
      parsed = JSON.parse(match[0])
    } catch {
      parsed = {}
    }
  }
  // 解析失败时把整段文字当台词
  let line = String(parsed.line ?? (match ? '' : raw)).trim()
  line = line.replace(/[（(][^）)]*[）)]/g, '').replace(/\s+/g, ' ').trim()
  if (!line) line = '嗯？刚刚没听清，你再说一遍嘛。'
  if ([...line].length > MAX_LINE_CHARS) line = [...line].slice(0, MAX_LINE_CHARS).join('')
  return {
    line,
    emotion: parsed.emotion in EMOTIONS ? parsed.emotion : 'neutral',
    action: typeof parsed.action === 'string' ? parsed.action.trim().slice(0, 30) : '',
  }
}

function mockReply(history) {
  const last = history.at(-1)?.content ?? ''
  return {
    line: `（本地调试）你刚刚说「${[...last].slice(0, 12).join('')}」，我听到啦！`,
    emotion: 'happy',
    action: '',
  }
}
