/**
 * OpenAI Realtime API 的 WebRTC 客户端。
 * 音频走 WebRTC 媒体通道（自带回声消除和抖动缓冲），事件走 DataChannel。
 * 服务端 VAD 负责判断用户何时开口/说完，用户插话时自动打断角色。
 */
export interface SessionInfo {
  clientSecret: string
  model: string
  reasoning: boolean
  characterName: string
}

// Realtime 事件字段很多，这里只按需取用
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type ServerEvent = { type: string; [key: string]: any }
type Listener = (event: ServerEvent) => void

export class RealtimeClient {
  session: SessionInfo | null = null
  remoteStream: MediaStream | null = null

  private pc: RTCPeerConnection | null = null
  private dc: RTCDataChannel | null = null
  private mic: MediaStream | null = null
  private audioEl = new Audio()
  private listeners = new Map<string, Set<Listener>>()

  constructor() {
    this.audioEl.autoplay = true
  }

  /** 订阅事件，type 传 '*' 收所有事件 */
  on(type: string, fn: Listener) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set())
    this.listeners.get(type)!.add(fn)
    return () => this.listeners.get(type)?.delete(fn)
  }

  async connect(): Promise<SessionInfo> {
    this.mic = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    })

    const res = await fetch('/api/session', { method: 'POST' })
    const body = await res.json()
    if (!res.ok) throw new Error(body.error ?? `获取会话失败 (${res.status})`)
    const session = body as SessionInfo
    this.session = session

    const pc = new RTCPeerConnection()
    this.pc = pc

    const remoteReady = new Promise<MediaStream>((resolve) => {
      pc.ontrack = (e) => {
        // Chrome 需要把远端流挂到 <audio> 上，WebAudio 才能分析到声音
        this.audioEl.srcObject = e.streams[0]
        // iOS Safari 不一定理会 autoplay；录音授权后允许手动播放
        this.audioEl.play().catch(() => {})
        this.remoteStream = e.streams[0]
        resolve(e.streams[0])
      }
    })

    pc.addTrack(this.mic.getAudioTracks()[0], this.mic)

    const dc = pc.createDataChannel('oai-events')
    this.dc = dc
    dc.onmessage = (e) => this.emit(JSON.parse(e.data))
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
        this.emit({ type: 'client.disconnected' })
      }
    }

    await Promise.all([dcOpen, remoteReady])
    return session
  }

  send(event: object) {
    if (this.dc?.readyState === 'open') this.dc.send(JSON.stringify(event))
  }

  /** 发一句文字给角色（不用麦克风也能聊） */
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

  disconnect() {
    this.dc?.close()
    this.pc?.close()
    this.mic?.getTracks().forEach((t) => t.stop())
    this.audioEl.srcObject = null
    this.pc = this.dc = this.mic = this.remoteStream = null
    this.session = null
  }

  private emit(event: ServerEvent) {
    this.listeners.get(event.type)?.forEach((fn) => fn(event))
    this.listeners.get('*')?.forEach((fn) => fn(event))
  }
}
