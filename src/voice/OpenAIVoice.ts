import { DIRECTOR_PROMPT } from '../../shared/cues.js'
import { parseCue } from './cues'
import { Emitter, type Cue, type VoiceSession } from './types'

/**
 * OpenAI Realtime API（WebRTC）。
 * 音频走 WebRTC 媒体通道（自带回声消除和抖动缓冲），事件走 DataChannel。
 * 服务端 VAD 负责判断用户何时开口/说完，用户插话时自动打断角色。
 */

// Realtime 事件字段很多，这里只按需取用
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type ServerEvent = { type: string; [key: string]: any }

export class OpenAIVoice extends Emitter implements VoiceSession {
  readonly provider = 'openai'
  readonly sentenceTiming = false
  model = ''
  voiceNode: AudioNode | null = null

  private reasoning = false
  private pc: RTCPeerConnection | null = null
  private dc: RTCDataChannel | null = null
  private mic: MediaStream | null = null
  private audioEl = new Audio()
  private responseId: string | null = null
  private seq = 0
  private pendingCues = new Map<string, (cue: Cue | null) => void>()

  constructor() {
    super()
    this.audioEl.autoplay = true
  }

  async connect(ctx: AudioContext) {
    this.mic = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    })

    const res = await fetch('/api/session', { method: 'POST' })
    const session = await res.json()
    if (!res.ok) throw new Error(session.error ?? `获取会话失败 (${res.status})`)
    this.model = session.model
    this.reasoning = session.reasoning

    const pc = new RTCPeerConnection()
    this.pc = pc

    const remoteReady = new Promise<void>((resolve) => {
      pc.ontrack = (e) => {
        // Chrome 需要把远端流挂到 <audio> 上，WebAudio 才能分析到声音
        this.audioEl.srcObject = e.streams[0]
        // iOS Safari 不一定理会 autoplay；录音授权后允许手动播放
        this.audioEl.play().catch(() => {})
        this.voiceNode = ctx.createMediaStreamSource(e.streams[0])
        resolve()
      }
    })

    pc.addTrack(this.mic.getAudioTracks()[0], this.mic)

    const dc = pc.createDataChannel('oai-events')
    this.dc = dc
    dc.onmessage = (e) => this.handle(JSON.parse(e.data))
    const dcOpen = new Promise<void>((resolve) => (dc.onopen = () => resolve()))

    const offer = await pc.createOffer()
    await pc.setLocalDescription(offer)
    const sdpRes = await fetch('https://api.openai.com/v1/realtime/calls', {
      method: 'POST',
      body: offer.sdp,
      headers: {
        Authorization: `Bearer ${session.clientSecret}`,
        'Content-Type': 'application/sdp',
      },
    })
    if (!sdpRes.ok) throw new Error(`WebRTC 握手失败 (${sdpRes.status}): ${await sdpRes.text()}`)
    await pc.setRemoteDescription({ type: 'answer', sdp: await sdpRes.text() })

    pc.onconnectionstatechange = () => {
      if (pc.connectionState === 'failed' || pc.connectionState === 'disconnected') {
        this.emit({ type: 'disconnected' })
      }
    }

    await Promise.all([dcOpen, remoteReady])
  }

  disconnect() {
    this.dc?.close()
    this.pc?.close()
    this.mic?.getTracks().forEach((t) => t.stop())
    this.audioEl.srcObject = null
    this.voiceNode?.disconnect()
    this.pc = this.dc = this.mic = this.voiceNode = null
    this.pendingCues.forEach((resolve) => resolve(null))
    this.pendingCues.clear()
  }

  sendText(text: string) {
    this.send({
      type: 'conversation.item.create',
      item: { type: 'message', role: 'user', content: [{ type: 'input_text', text }] },
    })
    this.send({ type: 'response.create' })
  }

  setMicEnabled(enabled: boolean) {
    this.mic?.getAudioTracks().forEach((t) => (t.enabled = enabled))
  }

  /**
   * 用「带外响应」（conversation: 'none'）标注表情：和正在说的话并行运行，
   * 不写入对话历史。语音模式下不能让模型在台词里写 [happy]，因为会被念出来。
   */
  classify(text: string): Promise<Cue | null> {
    const seq = String(++this.seq)
    const result = new Promise<Cue | null>((resolve) => {
      this.pendingCues.set(seq, resolve)
      setTimeout(() => this.pendingCues.delete(seq) && resolve(null), 5000)
    })
    this.send({
      type: 'response.create',
      response: {
        conversation: 'none',
        output_modalities: ['text'],
        metadata: { purpose: 'emotion', seq },
        instructions: DIRECTOR_PROMPT,
        input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text }] }],
        max_output_tokens: 300,
        ...(this.reasoning ? { reasoning: { effort: 'minimal' } } : {}),
      },
    })
    return result
  }

  private send(event: object) {
    if (this.dc?.readyState === 'open') this.dc.send(JSON.stringify(event))
  }

  private handle(e: ServerEvent) {
    switch (e.type) {
      case 'input_audio_buffer.speech_started':
        return this.emit({ type: 'user.speech_started' })
      case 'input_audio_buffer.speech_stopped':
        return this.emit({ type: 'user.speech_stopped' })
      case 'conversation.item.input_audio_transcription.completed':
        if (e.transcript?.trim()) this.emit({ type: 'user.transcript', text: e.transcript.trim() })
        return
      case 'response.created':
        if (e.response?.metadata?.purpose === 'emotion') return
        this.responseId = e.response.id
        return this.emit({ type: 'assistant.response_started', id: e.response.id })
      case 'response.output_audio_transcript.delta':
        if (e.response_id === this.responseId) this.emit({ type: 'assistant.text_delta', id: e.response_id, delta: e.delta })
        return
      case 'response.output_audio_transcript.done':
        if (e.response_id === this.responseId) this.emit({ type: 'assistant.text_done', id: e.response_id })
        return
      case 'output_audio_buffer.started':
        return this.emit({ type: 'assistant.audio_started' })
      case 'output_audio_buffer.stopped':
        return this.emit({ type: 'assistant.audio_stopped', interrupted: false })
      case 'output_audio_buffer.cleared':
        return this.emit({ type: 'assistant.audio_stopped', interrupted: true })
      case 'response.done': {
        const meta = e.response?.metadata
        if (meta?.purpose !== 'emotion') return
        const resolve = this.pendingCues.get(meta.seq)
        this.pendingCues.delete(meta.seq)
        const output: string = (e.response.output ?? [])
          .flatMap((item: ServerEvent) => item.content ?? [])
          .map((c: ServerEvent) => c.text ?? c.transcript ?? '')
          .join('')
        resolve?.(parseCue(output))
        return
      }
      case 'error':
        console.error('Realtime error', e.error)
        return this.emit({ type: 'error', message: e.error?.message ?? '未知错误' })
    }
  }
}
