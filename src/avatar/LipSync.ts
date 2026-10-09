/**
 * 从音频流里实时估算口型。
 * 音量决定张嘴幅度，频谱重心粗略区分 a / i / u / e / o，足够骗过眼睛。
 */
export interface Visemes {
  aa: number
  ih: number
  ou: number
  ee: number
  oh: number
}

export const SILENT: Visemes = { aa: 0, ih: 0, ou: 0, ee: 0, oh: 0 }

export class LipSync {
  private analyser: AnalyserNode
  private time: Float32Array<ArrayBuffer>
  private freq: Float32Array<ArrayBuffer>
  private binHz: number
  private level = 0
  private shape: Visemes = { ...SILENT }

  constructor(ctx: AudioContext, stream: MediaStream) {
    this.analyser = ctx.createAnalyser()
    this.analyser.fftSize = 1024
    this.analyser.smoothingTimeConstant = 0.5
    // 只分析，不接到 destination；声音由 <audio> 元素播放
    ctx.createMediaStreamSource(stream).connect(this.analyser)
    this.time = new Float32Array(this.analyser.fftSize)
    this.freq = new Float32Array(this.analyser.frequencyBinCount)
    this.binHz = ctx.sampleRate / this.analyser.fftSize
  }

  update(dt: number): Visemes {
    this.analyser.getFloatTimeDomainData(this.time)
    let sum = 0
    for (const v of this.time) sum += v * v
    const rms = Math.sqrt(sum / this.time.length)

    // 噪声门 + 映射到 0~1
    const target = Math.min(1, Math.max(0, (rms - 0.01) * 9))
    // 张嘴快、闭嘴稍慢，看起来更自然
    const k = target > this.level ? 1 - Math.exp(-dt * 30) : 1 - Math.exp(-dt * 14)
    this.level += (target - this.level) * k

    if (this.level < 0.02) {
      this.shape = { ...SILENT }
      return this.shape
    }

    // 频谱重心：低 → u/o，中 → a，高 → i/e
    this.analyser.getFloatFrequencyData(this.freq)
    let num = 0
    let den = 0
    const lo = Math.floor(150 / this.binHz)
    const hi = Math.floor(4000 / this.binHz)
    for (let i = lo; i < hi; i++) {
      const mag = Math.pow(10, this.freq[i] / 20)
      num += mag * i * this.binHz
      den += mag
    }
    const centroid = den > 0 ? num / den : 1000

    const l = this.level
    const s: Visemes = { ...SILENT }
    if (centroid < 900) {
      s.ou = l * 0.5
      s.oh = l * 0.6
      s.aa = l * 0.3
    } else if (centroid < 1600) {
      s.aa = l * 0.9
      s.oh = l * 0.2
    } else if (centroid < 2200) {
      s.ee = l * 0.6
      s.aa = l * 0.4
    } else {
      s.ih = l * 0.6
      s.ee = l * 0.3
    }
    // 平滑形状切换，避免嘴型抖动
    const m = 1 - Math.exp(-dt * 18)
    for (const key of Object.keys(s) as (keyof Visemes)[]) {
      this.shape[key] += (s[key] - this.shape[key]) * m
    }
    return this.shape
  }

  get volume() {
    return this.level
  }
}
