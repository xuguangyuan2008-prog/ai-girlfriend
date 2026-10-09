import type { Avatar } from '../avatar/Avatar'
import type { Gesture } from '../avatar/types'
import type { Cue, VoiceSession } from '../voice/types'

/**
 * 表情导演：把角色的台词按句标注表情和手势，在这句话开始发声时触发。
 *
 * 两种时间来源：
 * - 会话自带句子时间（豆包）：直接用 assistant.sentence 事件里的 at
 * - 只有文字流（OpenAI）：自己按标点切句，用「音频开始时间 + 前文估算朗读时长」推算
 */
export interface DirectorCue extends Cue {
  text: string
}

/** 粗略估算念完一段文字需要几秒 */
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

const isSpeakable = (text: string) => text.replace(/[\p{P}\s]/gu, '').length >= 2

export class EmotionDirector {
  onCue: ((cue: DirectorCue) => void) | null = null

  private responseId: string | null = null
  // 估算模式的状态
  private buffer = ''
  private textSec = 0
  private audioStart: number | null = null
  private waiting: { offsetSec: number; cue: DirectorCue }[] = []

  private timers: number[] = []
  private resetTimer = 0
  private lastGesture: { name: Gesture | null; at: number } = { name: null, at: -Infinity }

  constructor(
    private voice: VoiceSession,
    private avatar: Avatar,
  ) {
    voice.on('user.speech_started', () => {
      this.cancelScheduled()
      avatar.setMode('listening')
      // 认真听的时候收起上一句的表情
      clearTimeout(this.resetTimer)
      this.resetTimer = window.setTimeout(() => avatar.setEmotion('neutral'), 1200)
    })
    voice.on('user.speech_stopped', () => avatar.setMode('thinking'))

    voice.on('assistant.response_started', (e) => {
      this.responseId = e.id
      this.buffer = ''
      this.textSec = 0
      this.audioStart = null
      this.cancelScheduled()
    })

    voice.on('assistant.sentence', (e) => {
      if (!isSpeakable(e.text)) return
      this.label(e.id, e.text, (cue) => this.scheduleAt(e.at, cue))
    })

    if (!voice.sentenceTiming) {
      voice.on('assistant.text_delta', (e) => {
        if (e.id !== this.responseId) return
        this.buffer += e.delta
        this.flush(false)
      })
      voice.on('assistant.text_done', (e) => {
        if (e.id === this.responseId) this.flush(true)
      })
    }

    voice.on('assistant.audio_started', () => {
      clearTimeout(this.resetTimer)
      this.audioStart = performance.now()
      avatar.setMode('speaking')
      for (const w of this.waiting) this.scheduleAt(this.audioStart + w.offsetSec * 1000, w.cue)
      this.waiting = []
    })
    voice.on('assistant.audio_stopped', (e) => {
      if (e.interrupted) this.cancelScheduled()
      avatar.setMode('idle')
      clearTimeout(this.resetTimer)
      this.resetTimer = window.setTimeout(() => avatar.setEmotion('neutral'), 3000)
    })
  }

  /** 估算模式：把文字流切成句子 */
  private flush(final: boolean) {
    let idx: number
    while ((idx = findSplit(this.buffer)) >= 0) {
      this.estimate(this.buffer.slice(0, idx + 1))
      this.buffer = this.buffer.slice(idx + 1)
    }
    if (final && this.buffer.trim()) {
      this.estimate(this.buffer)
      this.buffer = ''
    }
  }

  private estimate(sentence: string) {
    const offsetSec = this.textSec
    this.textSec += speechSeconds(sentence)
    const id = this.responseId
    if (!id || !isSpeakable(sentence)) return
    this.label(id, sentence, (cue) => {
      if (this.audioStart === null) this.waiting.push({ offsetSec, cue })
      else this.scheduleAt(this.audioStart + offsetSec * 1000, cue)
    })
  }

  private async label(id: string, text: string, then: (cue: DirectorCue) => void) {
    const cue = await this.voice.classify(text.trim())
    // 已经被打断或换了新回复，丢弃过期结果
    if (!cue || id !== this.responseId) return
    then({ ...cue, text: text.trim() })
  }

  private scheduleAt(at: number, cue: DirectorCue) {
    const delay = Math.max(0, at - performance.now())
    this.timers.push(window.setTimeout(() => this.apply(cue), delay))
  }

  private apply(cue: DirectorCue) {
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
