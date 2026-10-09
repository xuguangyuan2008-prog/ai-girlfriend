// 视频聊天模式的配置。所有值都可以用环境变量覆盖，见 .env.example。
const env = process.env

const num = (v, fallback) => (v === undefined || v === '' ? fallback : Number(v))

export const videoConfig = {
  /** sglang：连接租用 GPU 上的 SGLang 服务；mock：本地调试，不生成视频 */
  get backend() {
    return env.H3_BACKEND || (env.H3_BASE_URL ? 'sglang' : 'mock')
  },
  get baseUrl() {
    return (env.H3_BASE_URL || '').replace(/\/$/, '')
  },
  /** GPU 服务前面如果加了鉴权网关，填这里（Bearer） */
  get apiKey() {
    return env.H3_API_KEY || ''
  },

  /**
   * fast：社区蒸馏的 FastH3（4 次前向 + 稀疏注意力，约快 14 倍）。只支持文生视频，
   *       不能传参考图 / 声音 / 首尾帧，长相和声音靠固定的文字描述 + 固定种子维持。
   * ref： 基础版 H3 的 ref2va，参考图 + 声音样本 + 首尾帧钉住定妆照，一致性最好，但没有蒸馏、慢很多。
   * 要和 GPU 上启动的模型对应（gpu/serve.sh 的 MODE）。
   */
  get mode() {
    return env.H3_MODE === 'ref' ? 'ref' : 'fast'
  },

  // ---- 生成参数：决定速度的主要旋钮 ----
  get steps() {
    // FastH3 固定 5 个 sigma 点（4 次前向），改了会被服务端拒绝
    if (this.mode === 'fast') return 5
    return num(env.H3_STEPS, 30)
  },
  get shortEdge() {
    return num(env.H3_SHORT_EDGE, 768) // 768 是官方验证过的；480 约快 2 倍以上，画质需实测
  },
  get aspectRatio() {
    return env.H3_ASPECT_RATIO || '9:16'
  },
  /** 固定种子：同样的输入得到同样的结果，方便对比调参 */
  get seed() {
    return num(env.H3_SEED, 42)
  },
  /** 'high' 会启用 Cache-DiT 跳步，只适用于 ref 模式（FastH3 不支持） */
  get quality() {
    return this.mode === 'ref' ? env.H3_QUALITY || undefined : undefined
  },
  /**
   * 时长分档（秒）。torch.compile 按张量形状编译，固定几档可以在启动时预热、请求时复用，
   * 避免每次时长不同都重新编译。H3 支持 4~15 秒。
   */
  get durationBuckets() {
    return (env.H3_DURATION_BUCKETS || '4,6,8,10,12,15').split(',').map(Number)
  },
  /** 同时生成的任务数；一张卡一般只跑 1 个 */
  get concurrency() {
    return num(env.H3_CONCURRENCY, 1)
  },

  // ---- 固定场景素材（仅 ref 模式）：GPU 服务器上的路径（或 data:/http(s): URI） ----
  get assets() {
    const dir = env.H3_ASSET_DIR || '/workspace/assets'
    return {
      /** 定妆照：每段视频的第一帧和最后一帧，决定构图、背景、光线 */
      anchor: env.H3_ANCHOR_URI || `${dir}/anchor.png`,
      /** 角色参考图（可以和定妆照相同），保证长相一致 */
      portrait: env.H3_PORTRAIT_URI || `${dir}/portrait.png`,
      /** 声音样本：10~20 秒干净的人声，保证每段视频声音一致 */
      voice: env.H3_VOICE_URI || `${dir}/voice.wav`,
    }
  },

  /** 生成的视频存放目录（Web 服务器本地），通过 /media/ 访问 */
  get mediaDir() {
    return env.MEDIA_DIR || 'media'
  },
  /** 等待时循环播放的待机视频，放在 public/video/ 下 */
  get idleUrl() {
    return env.VIDEO_IDLE_URL || '/video/idle.mp4'
  },
  /** 没有待机视频时显示的定妆照 */
  get posterUrl() {
    return env.VIDEO_POSTER_URL || '/video/anchor.png'
  },
}
