import { keywordCue, parseCue } from './cues'
import { MicCapture, PcmPlayer } from './pcm'
import { Emitter, type Cue, type VoiceSession } from './types'

/**
 * 豆包端到端实时语音大模型。
 * 豆包的鉴权需要自定义请求头，浏览器连不了，所以经由服务端 /api/doubao 中转（见 server/doubao.js）。
 * 音频自己采集、自己播放：上行 16kHz int16 PCM，下行 24kHz int16 PCM。
 *
 * 豆包会在每句话开始合成时发 TTSSentenceStart，而播放队列在我们手里，
 * 所以能算出这句话真正开始发声的时间，表情可以精确对上。
 */
export class DoubaoVoice extends Emitter implements VoiceSession {
  readonly provider = 'doubao'
  readonly sentenceTiming = true
  model = ''

  private ws: WebSocket | null = null
  private mic: MicCapture | null = null
  private player: PcmPlayer | null = null
  private turn = 0
  private responseId: string | null = null
  private ttsDone = false
  /** 是否已经发过 audio_started 而还没发 audio_stopped */
  private speaking = false
  /** 用户插话后，丢弃上一轮残留的音频，直到用户说完 */
  private dropAudio = false
  private emotionApi: boolean | null = null

  get voiceNode() {
    return this.player?.output ?? null
  }

  async connect(ctx: AudioContext) {
    const player = new PcmPlayer(ctx, 24000)
    this.player = player
    player.onStart = () => {
      if (this.speaking) return // 网络抖动造成的断流又续上了
      this.speaking = true
      this.emit({ type: 'assistant.audio_started' })
    }
    player.onDrain = () => {
      // 网络抖动造成的短暂断流不算说完，等服务端确认 TTS 结束
      if (this.ttsDone) this.stopSpeaking(false)
    }

    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:'
    const ws = new WebSocket(`${proto}//${location.host}/api/doubao`)
    ws.binaryType = 'arraybuffer'
    this.ws = ws

    await new Promise<void>((resolve, reject) => {
      ws.onmessage = (e) => {
        if (typeof e.data !== 'string') return this.onAudio(e.data)
        const msg = JSON.parse(e.data)
        if (msg.type === 'ready') {
          this.model = msg.model
          resolve()
        } else if (msg.type === 'error') {
          reject(new Error(msg.message))
        }
        this.handle(msg)
      }
      ws.onclose = () => {
        reject(new Error('与服务器的连接已断开'))
        this.emit({ type: 'disconnected' })
      }
    })

    this.mic = new MicCapture(ctx, (pcm) => {
      if (ws.readyState === WebSocket.OPEN) ws.send(pcm)
    })
    await this.mic.start()
  }

  disconnect() {
    if (this.ws) this.ws.onclose = null
    this.ws?.close()
    this.mic?.stop()
    this.player?.dispose()
    this.ws = this.mic = this.player = null
  }

  sendText(text: string) {
    this.player?.clear()
    this.ws?.send(JSON.stringify({ type: 'text', text }))
  }

  setMicEnabled(enabled: boolean) {
    if (this.mic) this.mic.enabled = enabled
  }

  /** 豆包没有带外响应：优先调服务端 /api/emotion（方舟等文本模型），没配置就用关键词 */
  async classify(text: string): Promise<Cue | null> {
    if (this.emotionApi !== false) {
      try {
        const res = await fetch('/api/emotion', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ text }),
        })
        if (res.status === 501) this.emotionApi = false
        else if (res.ok) {
          this.emotionApi = true
          const cue = parseCue((await res.json()).raw ?? '')
          if (cue) return cue
        }
      } catch (err) {
        console.warn('表情标注失败，改用关键词', err)
      }
    }
    return keywordCue(text)
  }

  private stopSpeaking(interrupted: boolean) {
    if (!this.speaking) return
    this.speaking = false
    this.emit({ type: 'assistant.audio_stopped', interrupted })
  }

  private ensureResponse() {
    if (!this.responseId) {
      this.responseId = `doubao-${++this.turn}`
      this.ttsDone = false
      this.emit({ type: 'assistant.response_started', id: this.responseId })
    }
    return this.responseId
  }

  private onAudio(pcm: ArrayBuffer) {
    if (this.dropAudio) return
    this.ensureResponse()
    this.player?.push(pcm)
  }

  private handle(msg: { type: string; [key: string]: string }) {
    switch (msg.type) {
      case 'user.speech_started': {
        // 打断：立刻停止播放
        this.dropAudio = true
        this.player?.clear()
        this.responseId = null
        this.stopSpeaking(true)
        return this.emit({ type: 'user.speech_started' })
      }
      case 'user.speech_stopped':
        this.dropAudio = false
        return this.emit({ type: 'user.speech_stopped' })
      case 'user.transcript':
        return this.emit({ type: 'user.transcript', text: msg.text })
      case 'assistant.text_delta':
        if (this.dropAudio) return
        return this.emit({ type: 'assistant.text_delta', id: this.ensureResponse(), delta: msg.delta })
      case 'assistant.text_done':
        if (this.responseId) this.emit({ type: 'assistant.text_done', id: this.responseId })
        return
      case 'assistant.sentence': {
        if (this.dropAudio) return
        const id = this.ensureResponse()
        // 这句话的音频会排在当前队列之后播放
        const at = this.player?.playing ? this.player.queueEndsAt : performance.now() + 100
        return this.emit({ type: 'assistant.sentence', id, text: msg.text, at })
      }
      case 'assistant.audio_done':
        // 被打断的那一轮的结束信号，忽略
        if (this.dropAudio) return
        this.ttsDone = true
        this.responseId = null
        if (!this.player?.playing) this.stopSpeaking(false)
        return
      case 'error':
        return this.emit({ type: 'error', message: msg.message })
    }
  }
}
