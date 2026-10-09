import type { Emotion, Gesture } from '../avatar/types'

/**
 * 统一的语音会话接口。OpenAI、豆包等不同的实时语音服务都翻译成这里的事件，
 * 表情导演和界面只依赖这一层。
 */
export type VoiceEvent =
  | { type: 'user.speech_started' }
  | { type: 'user.speech_stopped' }
  | { type: 'user.transcript'; text: string }
  /** 角色开始新一轮回复 */
  | { type: 'assistant.response_started'; id: string }
  /** 回复的文字流（字幕用，通常比声音早到） */
  | { type: 'assistant.text_delta'; id: string; delta: string }
  | { type: 'assistant.text_done'; id: string }
  /** 一句话即将开始播放；at 是预计开始播放的 performance.now() 时间 */
  | { type: 'assistant.sentence'; id: string; text: string; at: number }
  | { type: 'assistant.audio_started' }
  | { type: 'assistant.audio_stopped'; interrupted: boolean }
  | { type: 'error'; message: string }
  | { type: 'disconnected' }

export type VoiceEventType = VoiceEvent['type']
export type VoiceEventOf<T extends VoiceEventType> = Extract<VoiceEvent, { type: T }>

export interface Cue {
  emotion: Emotion
  gesture: Gesture | 'none'
}

export interface VoiceSession {
  readonly provider: string
  /** 连接成功后可用：显示用的模型名 */
  readonly model: string
  /**
   * true：会话自己发出带精确时间的 assistant.sentence 事件；
   * false：导演需要根据文字流和音频开始时间自行估算
   */
  readonly sentenceTiming: boolean
  /** 角色声音所在的音频节点，用来做口型 */
  readonly voiceNode: AudioNode | null

  connect(ctx: AudioContext): Promise<void>
  disconnect(): void
  sendText(text: string): void
  setMicEnabled(enabled: boolean): void
  /** 给一句台词标注表情和手势，失败返回 null */
  classify(text: string): Promise<Cue | null>
  on<T extends VoiceEventType>(type: T, fn: (event: VoiceEventOf<T>) => void): () => void
}

/** 简单的类型安全事件分发，供各实现复用 */
export class Emitter {
  private listeners = new Map<string, Set<(e: VoiceEvent) => void>>()

  on<T extends VoiceEventType>(type: T, fn: (event: VoiceEventOf<T>) => void) {
    const set = this.listeners.get(type) ?? new Set()
    this.listeners.set(type, set)
    set.add(fn as (e: VoiceEvent) => void)
    return () => set.delete(fn as (e: VoiceEvent) => void)
  }

  emit(event: VoiceEvent) {
    this.listeners.get(event.type)?.forEach((fn) => fn(event))
  }
}
