import { character } from './character.js'

// 推理型 Realtime 模型（gpt-realtime-2 系列）才接受 reasoning 参数
const isReasoningModel = (model) => /^gpt-realtime-2/.test(model)

export const openaiConfigured = () => Boolean(process.env.OPENAI_API_KEY)

/**
 * 用服务端的 API Key 换一个短时效的 client secret，浏览器拿它直接和 OpenAI 建立 WebRTC 连接。
 * 这样真正的 API Key 永远不会下发到前端。
 */
export async function createOpenAISession() {
  const apiKey = process.env.OPENAI_API_KEY
  if (!apiKey) throw new Error('OPENAI_API_KEY 未设置，请在 .env 中配置')
  const model = process.env.OPENAI_REALTIME_MODEL || 'gpt-realtime-2.1'

  const session = {
    type: 'realtime',
    model,
    instructions: character.instructions,
    output_modalities: ['audio'],
    audio: {
      input: {
        noise_reduction: { type: 'near_field' },
        transcription: {
          model: process.env.OPENAI_TRANSCRIBE_MODEL || 'gpt-4o-mini-transcribe',
          language: 'zh',
        },
        // semantic_vad 根据语义判断用户是否说完，比纯静音检测更不容易抢话
        turn_detection: {
          type: 'semantic_vad',
          eagerness: 'auto',
          create_response: true,
          interrupt_response: true,
        },
      },
      output: { voice: character.openaiVoice },
    },
  }
  if (isReasoningModel(model)) session.reasoning = { effort: 'low' }

  const res = await fetch('https://api.openai.com/v1/realtime/client_secrets', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ session }),
  })
  if (!res.ok) {
    throw new Error(`创建 Realtime 会话失败 (${res.status}): ${await res.text()}`)
  }
  const data = await res.json()
  return {
    clientSecret: data.value,
    expiresAt: data.expires_at,
    model,
    reasoning: isReasoningModel(model),
  }
}
