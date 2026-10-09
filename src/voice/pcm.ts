/**
 * 自己处理 PCM 音频的服务（豆包等 WebSocket 协议）需要的两个工具：
 * - MicCapture：麦克风 → 16kHz 单声道 int16，每 20ms 一块
 * - PcmPlayer：int16 PCM 块 → 无缝排队播放，可随时清空（打断）
 */

// AudioWorklet 代码必须是独立模块，这里内联成 Blob，省得单独放文件
const WORKLET = `
class Downsampler extends AudioWorkletProcessor {
  constructor(options) {
    super()
    this.ratio = sampleRate / options.processorOptions.targetRate
    this.chunk = options.processorOptions.chunkSamples
    this.buf = new Int16Array(this.chunk)
    this.n = 0
    this.phase = 0
    this.acc = 0
    this.cnt = 0
  }
  process(inputs) {
    const ch = inputs[0] && inputs[0][0]
    if (!ch) return true
    for (let i = 0; i < ch.length; i++) {
      // 简单的盒式滤波降采样：把每 ratio 个样本取平均
      this.acc += ch[i]
      this.cnt++
      this.phase += 1
      if (this.phase >= this.ratio) {
        this.phase -= this.ratio
        const v = Math.max(-1, Math.min(1, this.acc / this.cnt))
        this.acc = 0
        this.cnt = 0
        this.buf[this.n++] = v < 0 ? v * 0x8000 : v * 0x7fff
        if (this.n === this.chunk) {
          this.port.postMessage(this.buf.buffer, [this.buf.buffer])
          this.buf = new Int16Array(this.chunk)
          this.n = 0
        }
      }
    }
    return true
  }
}
registerProcessor('downsampler', Downsampler)
`

export class MicCapture {
  private stream: MediaStream | null = null
  private node: AudioWorkletNode | null = null
  private source: MediaStreamAudioSourceNode | null = null
  private sink: GainNode | null = null
  enabled = true

  constructor(
    private ctx: AudioContext,
    private onChunk: (pcm: ArrayBuffer) => void,
    private targetRate = 16000,
    private chunkMs = 20,
  ) {}

  async start() {
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 },
    })
    const url = URL.createObjectURL(new Blob([WORKLET], { type: 'text/javascript' }))
    try {
      await this.ctx.audioWorklet.addModule(url)
    } finally {
      URL.revokeObjectURL(url)
    }
    this.source = this.ctx.createMediaStreamSource(this.stream)
    this.node = new AudioWorkletNode(this.ctx, 'downsampler', {
      processorOptions: {
        targetRate: this.targetRate,
        chunkSamples: (this.targetRate * this.chunkMs) / 1000,
      },
    })
    this.node.port.onmessage = (e: MessageEvent<ArrayBuffer>) => {
      // 静音时发全零，保持音频流连续，避免服务端超时断开
      this.onChunk(this.enabled ? e.data : new ArrayBuffer(e.data.byteLength))
    }
    // 接到一个音量为 0 的节点上，保证 worklet 持续被调度
    this.sink = this.ctx.createGain()
    this.sink.gain.value = 0
    this.source.connect(this.node).connect(this.sink).connect(this.ctx.destination)
  }

  stop() {
    this.source?.disconnect()
    this.node?.disconnect()
    this.sink?.disconnect()
    this.stream?.getTracks().forEach((t) => t.stop())
    this.stream = this.node = this.source = this.sink = null
  }
}

export class PcmPlayer {
  /** 所有播放的声音都经过这里，可以接分析器做口型 */
  readonly output: GainNode
  onStart: (() => void) | null = null
  onDrain: (() => void) | null = null

  private next = 0
  private sources = new Set<AudioBufferSourceNode>()

  constructor(
    private ctx: AudioContext,
    private sampleRate = 24000,
  ) {
    this.output = ctx.createGain()
    this.output.connect(ctx.destination)
  }

  get playing() {
    return this.sources.size > 0
  }

  /** 已排队的音频预计在何时（performance.now() 毫秒）播完 */
  get queueEndsAt() {
    return performance.now() + Math.max(0, this.next - this.ctx.currentTime) * 1000
  }

  push(pcm: ArrayBuffer) {
    const int16 = new Int16Array(pcm)
    if (!int16.length) return
    const f32 = new Float32Array(int16.length)
    for (let i = 0; i < int16.length; i++) f32[i] = int16[i] / 0x8000
    const buffer = this.ctx.createBuffer(1, f32.length, this.sampleRate)
    buffer.copyToChannel(f32, 0)

    const src = this.ctx.createBufferSource()
    src.buffer = buffer
    src.connect(this.output)
    const wasIdle = !this.playing
    // 刚开始或断流后重新开始时，留一点缓冲吸收网络抖动
    const now = this.ctx.currentTime
    if (this.next < now + 0.02) this.next = now + 0.06
    src.start(this.next)
    this.next += buffer.duration
    this.sources.add(src)
    src.onended = () => {
      this.sources.delete(src)
      if (!this.playing) this.onDrain?.()
    }
    if (wasIdle) this.onStart?.()
  }

  /** 立即停止并清空队列（用户插话时） */
  clear() {
    for (const src of this.sources) {
      src.onended = null
      src.stop()
    }
    this.sources.clear()
    this.next = 0
  }

  dispose() {
    this.clear()
    this.output.disconnect()
  }
}
