import type { Avatar } from '../avatar/Avatar'
import { EMOTIONS, GESTURES, isEmotion, isGesture, type Emotion, type Gesture } from '../avatar/types'
import type { RealtimeClient, ServerEvent } from './RealtimeClient'

/**
 * 表情导演：把角色的台词按句切开，用 Realtime 的「带外响应」（conversation: 'none'）
 * 并行地让模型给每句话标注表情和手势，再按估算的朗读时间点触发。
 *
 * 为什么不让模型在台词里直接输出 [happy] 这类标签？
 * 因为语音模式下标签会被念出来。带外响应不写入对话历史，也不阻塞正在说的话。
 */
export interface Cue {
  emotion: Emotion
  gesture: Gesture | 'none'
  text: string
}

const PROMPT = `你是虚拟角色的表情导演。用户消息是角色马上要说出口的一句台词，请为这句台词选择表情和动作。
只输出一行 JSON，不要任何其它内容，格式：{"emotion":"...","gesture":"..."}
emotion 只能是：${Object.keys(EMOTIONS).join(', ')}
gesture 只能是：none, ${GESTURES.join(', ')}
动作要克制，大多数句子用 none。参考：打招呼/告别→wave，同意/肯定→nod，否定/拒绝→shake，疑问/好奇→tilt，无奈/不知道→shrug，思考/回忆→think，害羞/被夸→shy，兴奋/庆祝→cheer。`

/** 粗略估算念完一段文字需要几秒，用来让表情跟上语音 */
function speechSeconds(text: string) {
  let s = 0
  for (const ch of text) {
    if (/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u.test(ch)) s += 0.22
    else if (/[。！？!?…~～]/.test(ch)) s += 0.3
    else if (/[，,、；;：:]/.test(ch)) s += 0.15
    else if (/\S/.test(ch)) s += 0.06
  }
  return s
}

/** 找到第一个可以切句的位置，没有则返回 -1 */
function findSplit(text: string) {
  const end = text.search(/[。！？!?…~～\n]/)
  if (end >= 0) return end
  // 长句在逗号处提前切，让表情更早出现
  if (text.length >= 16) {
    const comma = text.slice(6).search(/[，,；;]/)
    if (comma >= 0) return comma + 6
  }
  return -1
}

interface Request {
  responseId: string
  offsetSec: number
  text: string
}

export class EmotionDirector {
  onCue: ((cue: Cue) => void) | null = null

  private responseId: string | null = null
  private buffer = ''
  private textSec = 0
  private audioStart: number | null = null
  private seq = 0
  private requests = new Map<string, Request>()
  private waiting: { offsetSec: number; cue: Cue }[] = []
  private timers: number[] = []
  private resetTimer = 0
  private lastGesture: { name: Gesture | null; at: number } = { name: null, at: -Infinity }

  constructor(
    private client: RealtimeClient,
    private avatar: Avatar,
  ) {
    client.on('input_audio_buffer.speech_started', () => {
      this.cancelScheduled()
      clearTimeout(this.resetTimer)
      avatar.setMode('listening')
    })
    client.on('input_audio_buffer.speech_stopped', () => avatar.setMode('thinking'))

    client.on('response.created', (e) => {
      if (e.response?.metadata?.purpose === 'emotion') return
      this.responseId = e.response.id
      this.buffer = ''
      this.textSec = 0
      this.audioStart = null
      this.cancelScheduled()
    })
    client.on('response.output_audio_transcript.delta', (e) => {
      if (e.response_id !== this.responseId) return
      this.buffer += e.delta
      this.flush(false)
    })
    client.on('response.output_audio_transcript.done', (e) => {
      if (e.response_id === this.responseId) this.flush(true)
    })

    client.on('output_audio_buffer.started', () => {
      clearTimeout(this.resetTimer)
      this.audioStart = performance.now()
      avatar.setMode('speaking')
      for (const w of this.waiting) this.schedule(w.offsetSec, w.cue)
      this.waiting = []
    })
    const onAudioEnd = () => {
      avatar.setMode('idle')
      clearTimeout(this.resetTimer)
      this.resetTimer = window.setTimeout(() => avatar.setEmotion('neutral'), 3000)
    }
    client.on('output_audio_buffer.stopped', onAudioEnd)
    client.on('output_audio_buffer.cleared', () => {
      this.cancelScheduled()
      onAudioEnd()
    })

    client.on('response.done', (e) => this.onResponseDone(e))
  }

  private flush(final: boolean) {
    let idx: number
    while ((idx = findSplit(this.buffer)) >= 0) {
      this.classify(this.buffer.slice(0, idx + 1))
      this.buffer = this.buffer.slice(idx + 1)
    }
    if (final && this.buffer.trim()) {
      this.classify(this.buffer)
      this.buffer = ''
    }
  }

  private classify(sentence: string) {
    const offsetSec = this.textSec
    this.textSec += speechSeconds(sentence)
    const text = sentence.trim()
    if (text.replace(/[\p{P}\s]/gu, '').length < 2 || !this.responseId) return

    const seq = String(++this.seq)
    this.requests.set(seq, { responseId: this.responseId, offsetSec, text })
    this.client.send({
      type: 'response.create',
      response: {
        conversation: 'none',
        output_modalities: ['text'],
        metadata: { purpose: 'emotion', seq },
        instructions: PROMPT,
        input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text }] }],
        max_output_tokens: 300,
        ...(this.client.session?.reasoning ? { reasoning: { effort: 'minimal' } } : {}),
      },
    })
  }

  private onResponseDone(e: ServerEvent) {
    const meta = e.response?.metadata
    if (meta?.purpose !== 'emotion') return
    const req = this.requests.get(meta.seq)
    this.requests.delete(meta.seq)
    // 已经被打断或换了新回复，丢弃过期结果
    if (!req || req.responseId !== this.responseId) return

    const output: string = (e.response.output ?? [])
      .flatMap((item: ServerEvent) => item.content ?? [])
      .map((c: ServerEvent) => c.text ?? c.transcript ?? '')
      .join('')
    const match = output.match(/\{[\s\S]*?\}/)
    if (!match) return
    let parsed: { emotion?: unknown; gesture?: unknown }
    try {
      parsed = JSON.parse(match[0])
    } catch {
      return
    }
    const cue: Cue = {
      emotion: isEmotion(parsed.emotion) ? parsed.emotion : 'neutral',
      gesture: isGesture(parsed.gesture) ? parsed.gesture : 'none',
      text: req.text,
    }
    if (this.audioStart === null) this.waiting.push({ offsetSec: req.offsetSec, cue })
    else this.schedule(req.offsetSec, cue)
  }

  private schedule(offsetSec: number, cue: Cue) {
    const delay = this.audioStart! + offsetSec * 1000 - performance.now()
    this.timers.push(window.setTimeout(() => this.apply(cue), Math.max(0, delay)))
  }

  private apply(cue: Cue) {
    this.avatar.setEmotion(cue.emotion)
    const now = performance.now()
    const { name, at } = this.lastGesture
    // 手势别太密，也别连续重复同一个
    if (cue.gesture !== 'none' && now - at > 2500 && !(cue.gesture === name && now - at < 8000)) {
      this.avatar.playGesture(cue.gesture)
      this.lastGesture = { name: cue.gesture, at: now }
    }
    this.onCue?.(cue)
  }

  private cancelScheduled() {
    this.timers.forEach(clearTimeout)
    this.timers = []
    this.waiting = []
  }
}
