import { DIRECTOR_PROMPT } from '../shared/cues.js'

/**
 * 给一句台词标注表情和手势。用于没有「带外响应」能力的语音模型（如豆包）。
 * 调用任意 OpenAI 兼容的 Chat Completions 接口，默认是火山方舟。
 * 没配置时返回 501，前端会退回到本地关键词规则。
 */
export const emotionConfigured = () =>
  Boolean(process.env.EMOTION_API_KEY && process.env.EMOTION_MODEL)

export async function classifyEmotion(text) {
  const base = (process.env.EMOTION_API_BASE || 'https://ark.cn-beijing.volces.com/api/v3').replace(/\/$/, '')
  const isArk = base.includes('volces.com')
  const res = await fetch(`${base}/chat/completions`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.EMOTION_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: process.env.EMOTION_MODEL,
      messages: [
        { role: 'system', content: DIRECTOR_PROMPT },
        { role: 'user', content: text },
      ],
      // 方舟上的深度思考模型默认会先思考，关掉以降低延迟
      ...(isArk ? { thinking: { type: 'disabled' }, max_tokens: 60 } : {}),
    }),
  })
  if (!res.ok) throw new Error(`表情标注请求失败 (${res.status}): ${await res.text()}`)
  const data = await res.json()
  return data.choices?.[0]?.message?.content ?? ''
}
