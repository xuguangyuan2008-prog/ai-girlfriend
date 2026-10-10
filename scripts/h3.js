// MiniMax H3 命令行工具：生成待机视频、预热、单条测试、压测。
// 在 Web 服务器（或本机）上运行，通过 H3_BASE_URL 调用 GPU 上的 SGLang 服务。
//
//   npm run h3 -- idle [--seconds 6]             生成待机循环视频 → public/video/idle.mp4
//   npm run h3 -- warmup                          按每个时长档发一次请求，触发 torch.compile
//   npm run h3 -- say "你好呀，今天过得怎么样？" [--emotion happy] [--action 挥挥手]
//   npm run h3 -- consistency                    同一种子、不同台词生成 4 段，拼成对比图，看长相/场景会不会漂
//   npm run h3 -- bench [--durations 4,6,8] [--edges 768,480] [--steps 8,12] [--shifts 12,6] [--repeat 2]
//   （--steps / --shifts 只对 ref 模式有效，FastH3 固定 5 个 sigma 点）
//   每组参数的视频保存在 media/，文件名打印在输出里，速度之外也要看画质和声音
import { execFileSync } from 'node:child_process'
import { copyFile, mkdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { dirname } from 'node:path'
import { parseArgs } from 'node:util'

if (existsSync('.env')) process.loadEnvFile('.env')

const { videoConfig } = await import('../server/videochat/config.js')
const { generateClip, pickDuration } = await import('../server/videochat/h3.js')
const { h3Prompt, idlePrompt } = await import('../server/videochat/prompt.js')

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    seconds: { type: 'string' },
    out: { type: 'string' },
    emotion: { type: 'string' },
    action: { type: 'string' },
    durations: { type: 'string' },
    steps: { type: 'string' },
    edges: { type: 'string' },
    shifts: { type: 'string' },
    repeat: { type: 'string' },
  },
})
const [command, ...rest] = positionals

if (videoConfig.backend !== 'sglang') {
  console.error('请先在 .env 里设置 H3_BASE_URL（GPU 上 SGLang 服务的地址）')
  process.exit(1)
}

const fmt = (n) => (n == null ? '-' : n.toFixed(1))

async function clip(label, opts) {
  process.stdout.write(`${label} … `)
  const r = await generateClip(opts)
  console.log(`总计 ${fmt(r.totalSeconds)}s（推理 ${fmt(r.inferenceSeconds)}s）→ ${r.url}`)
  return r
}

const SAMPLE_LINES = {
  4: '嗯嗯，我在呢。',
  6: '哈哈，真的假的？快跟我说说！',
  8: '哇，听起来好好玩啊，下次也带我一起去嘛。',
  10: '嗯…让我想想啊，其实我觉得你已经做得很好了，别太累啦。',
  12: '你知道吗，我今天一直在想你上次说的那件事，后来到底怎么样了呀？',
  15: '哎呀，你这么一说我也饿了，我们周末一起去吃那家火锅好不好，我请客，不许跟我抢哦。',
}

switch (command) {
  case 'idle': {
    const seconds = Number(values.seconds) || 6
    const out = values.out || 'public/video/idle.mp4'
    const r = await clip(`待机视频 ${seconds}s`, { prompt: idlePrompt(), durationSeconds: seconds, withVoice: false })
    await mkdir(dirname(out), { recursive: true })
    await copyFile(r.file, out)
    console.log(`已保存到 ${out}`)
    break
  }

  case 'warmup': {
    for (const d of videoConfig.durationBuckets) {
      const line = SAMPLE_LINES[d] ?? SAMPLE_LINES[6]
      await clip(`预热 ${d}s`, { prompt: h3Prompt({ line, emotion: 'happy' }), durationSeconds: d })
    }
    break
  }

  case 'say': {
    const line = rest.join(' ') || SAMPLE_LINES[6]
    const reply = { line, emotion: values.emotion || 'happy', action: values.action || '' }
    const d = pickDuration(line)
    console.log(`提示词：${h3Prompt(reply)}`)
    await clip(`生成 ${d}s`, { prompt: h3Prompt(reply), durationSeconds: d })
    break
  }

  case 'consistency': {
    const tests = [
      { line: '哈哈，真的假的？快跟我说说！', emotion: 'surprised' },
      { line: '嗯…其实我今天也有点想你。', emotion: 'shy' },
      { line: '你又熬夜了是不是？快去睡觉！', emotion: 'pouty' },
      { line: '没事的，有我陪着你呢。', emotion: 'tender' },
    ]
    const files = []
    for (const t of tests) {
      const r = await clip(`「${t.line}」`, { prompt: h3Prompt({ ...t, action: '' }), durationSeconds: pickDuration(t.line) })
      files.push(r.file)
    }
    // 每段取第 2 秒的画面，横向拼成一张图（需要本机有 ffmpeg）
    try {
      const out = `${videoConfig.mediaDir}/consistency.png`
      const inputs = files.flatMap((f) => ['-ss', '2', '-i', f])
      const filter = files.map((_, i) => `[${i}:v]scale=-2:640,select=eq(n\\,0)[v${i}]`).join(';') +
        `;${files.map((_, i) => `[v${i}]`).join('')}hstack=inputs=${files.length}`
      execFileSync('ffmpeg', ['-y', '-loglevel', 'error', ...inputs, '-filter_complex', filter, '-frames:v', '1', out])
      console.log(`对比图：${out}（同时听一下这 4 段的声音是不是同一个人）`)
    } catch {
      console.log('没有 ffmpeg，跳过拼图；直接打开上面 4 个视频对比')
    }
    break
  }

  case 'bench': {
    const durations = (values.durations || '4,6,8').split(',').map(Number)
    const edges = (values.edges || String(videoConfig.shortEdge)).split(',').map(Number)
    const ref = videoConfig.mode === 'ref'
    const stepsList = ref ? (values.steps || String(videoConfig.steps)).split(',').map(Number) : [5]
    // 空字符串表示用服务端默认（12）
    const shiftList = ref && values.shifts ? values.shifts.split(',') : [process.env.H3_FLOW_SHIFT ?? '']
    const repeat = Number(values.repeat) || 2
    const rows = []
    for (const edge of edges)
    for (const steps of stepsList)
    for (const shift of shiftList) {
      process.env.H3_STEPS = String(steps)
      process.env.H3_SHORT_EDGE = String(edge)
      process.env.H3_FLOW_SHIFT = shift
      for (const d of durations) {
        const line = SAMPLE_LINES[d] ?? SAMPLE_LINES[6]
        const times = []
        for (let i = 0; i < repeat; i++) {
          // 第一次可能包含编译时间，单独列出
          const r = await clip(`${edge}p steps=${steps} shift=${shift || '默认'} ${d}s #${i + 1}`, {
            prompt: h3Prompt({ line, emotion: 'happy' }),
            durationSeconds: d,
            seed: 1000 + i,
          })
          times.push(r)
        }
        const warm = times.slice(1).length ? times.slice(1) : times
        const avg = warm.reduce((s, r) => s + r.totalSeconds, 0) / warm.length
        rows.push({ edge, steps, shift: shift || '默认', seconds: d, first: times[0].totalSeconds, avg, ratio: avg / d })
      }
    }
    console.log('\n短边  步数  偏移   时长   首次     稳定平均   等待/视频时长')
    for (const r of rows) {
      console.log(
        `${String(r.edge).padStart(4)}  ${String(r.steps).padStart(4)}  ${String(r.shift).padStart(4)}  ${String(r.seconds).padStart(3)}s  ${fmt(r.first).padStart(6)}s  ${fmt(r.avg).padStart(8)}s  ${r.ratio.toFixed(2).padStart(8)}x`,
      )
    }
    console.log(`\n模式：${videoConfig.mode}；画幅 ${videoConfig.aspectRatio}；时长档：${videoConfig.durationBuckets.join('/')}s`)
    break
  }

  default:
    console.log('用法：npm run h3 -- <idle|warmup|say|bench> [选项]，详见 scripts/h3.js 开头的说明')
    process.exit(command ? 1 : 0)
}
