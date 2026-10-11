// AutoDL 一键配置：在你自己的电脑上运行，通过 SSH 操作 AutoDL 实例。
//
//   npm run autodl -- login "ssh -p 12345 root@connect.xxx.seetacloud.com"   第一次：保存连接、配置免密登录（输一次密码）
//   npm run autodl -- setup [--shutdown]  上传脚本，在实例上装依赖、下载模型；--shutdown 表示结束后让实例自动关机
//   npm run autodl -- setup-stop          停止正在进行的安装（重新运行 setup 会接着下）
//   npm run autodl -- assets ./my-assets  上传 anchor.png / portrait.png / voice.wav
//   npm run autodl -- start               启动 H3 服务，等到就绪（需要有卡模式开机）
//   npm run autodl -- tunnel              建立 SSH 隧道，把实例的 30000 端口映射到本机（保持运行）
//   npm run autodl -- status              查看 GPU、磁盘、服务状态
//   npm run autodl -- logs                实时查看服务日志
//   npm run autodl -- stop                停止 H3 服务
//
// 需要本机有 ssh / scp / ssh-keygen（macOS、Linux、Windows 10 以上都自带）。
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync, appendFileSync, copyFileSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const CONFIG = '.autodl.json'
const DATA = process.env.DATA || '/root/autodl-tmp'
const PORT = Number(process.env.H3_PORT) || 30000 // 实例上 H3 服务的端口
const LOCAL_PORT = Number(process.env.LOCAL_PORT) || PORT // 本机隧道端口，30000 被占用时可以改
const ASSETS = ['anchor.png', 'portrait.png', 'voice.wav']

const [command, ...args] = process.argv.slice(2)
const die = (msg) => {
  console.error(`\n✗ ${msg}`)
  process.exit(1)
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// ---------- 连接 ----------
function loadConn() {
  if (!existsSync(CONFIG)) die('还没有登录信息，先运行：npm run autodl -- login "<AutoDL 控制台里的登录指令>"')
  return JSON.parse(readFileSync(CONFIG, 'utf8'))
}

/** 解析 AutoDL 的登录指令，如：ssh -p 12345 root@connect.westb.seetacloud.com */
function parseLogin(text) {
  const port = /-p\s+(\d+)/.exec(text)?.[1]
  const target = /(\S+)@([\w.-]+)/.exec(text)
  if (!port || !target) return null
  return { user: target[1], host: target[2], port: Number(port) }
}

const sshOpts = (c) => ['-p', String(c.port), '-o', 'StrictHostKeyChecking=accept-new', '-o', 'ServerAliveInterval=30']

/** 在实例上执行命令，输出直接显示 */
function remote(c, cmd, { capture = false, batch = true } = {}) {
  const opts = [...sshOpts(c), ...(batch ? ['-o', 'BatchMode=yes'] : []), `${c.user}@${c.host}`, cmd]
  const r = spawnSync('ssh', opts, { stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit', encoding: 'utf8' })
  if (r.error) die(`无法运行 ssh：${r.error.message}`)
  return r
}

function upload(c, files, dest) {
  const r = spawnSync('scp', ['-P', String(c.port), '-o', 'StrictHostKeyChecking=accept-new', '-o', 'BatchMode=yes', ...files, `${c.user}@${c.host}:${dest}`], {
    stdio: 'inherit',
  })
  if (r.status !== 0) die('上传失败')
}

/** 把 H3 相关的配置写进本地 .env（只补缺的，不覆盖已有的） */
function ensureEnv() {
  if (!existsSync('.env')) copyFileSync('.env.example', '.env')
  const env = readFileSync('.env', 'utf8')
  const want = { H3_BASE_URL: `http://localhost:${LOCAL_PORT}`, H3_ASSET_DIR: `${DATA}/assets` }
  const missing = Object.entries(want).filter(([k]) => !new RegExp(`^${k}=`, 'm').test(env))
  if (missing.length) {
    appendFileSync('.env', `\n# AutoDL（npm run autodl 自动添加）\n${missing.map(([k, v]) => `${k}=${v}`).join('\n')}\n`)
    console.log(`已在 .env 里添加：${missing.map(([k]) => k).join(', ')}`)
  }
}

/** 等实例上的 H3 服务能响应 */
async function waitReady(c, timeoutMin = 25) {
  const started = Date.now()
  let lastLine = ''
  while (Date.now() - started < timeoutMin * 60_000) {
    const r = remote(
      c,
      `curl -s -o /dev/null -w '%{http_code}' localhost:${PORT}/v1/models; echo; ` +
        `[ -f ${DATA}/logs/serve.pid ] && kill -0 $(cat ${DATA}/logs/serve.pid) 2>/dev/null && echo running || echo stopped; tail -n 1 ${DATA}/logs/serve.log 2>/dev/null`,
      { capture: true },
    )
    const [code, state, ...log] = (r.stdout || '').split('\n')
    if (code === '200') return true
    if (state === 'stopped') {
      console.log('\n服务进程已退出，最后的日志：')
      remote(c, `tail -n 30 ${DATA}/logs/serve.log`)
      return false
    }
    const line = log.join(' ').trim().slice(0, 120)
    if (line && line !== lastLine) {
      console.log(`  [${Math.round((Date.now() - started) / 1000)}s] ${line}`)
      lastLine = line
    }
    await sleep(10_000)
  }
  console.log(`\n${timeoutMin} 分钟内没有就绪，用 npm run autodl -- logs 看看日志`)
  return false
}

// ---------- 命令 ----------
switch (command) {
  case 'login': {
    const conn = parseLogin(args.join(' '))
    if (!conn) die('看不懂这条登录指令，应该类似：ssh -p 12345 root@connect.westb.seetacloud.com')

    // 本机没有 SSH 密钥就生成一个，然后把公钥放到实例上，之后的操作都不用再输密码
    const sshDir = join(homedir(), '.ssh')
    const key = ['id_ed25519', 'id_rsa'].map((k) => join(sshDir, k)).find((k) => existsSync(`${k}.pub`))
    let pubPath = key ? `${key}.pub` : null
    if (!pubPath) {
      mkdirSync(sshDir, { recursive: true })
      const k = join(sshDir, 'id_ed25519')
      const r = spawnSync('ssh-keygen', ['-t', 'ed25519', '-N', '', '-f', k, '-q'], { stdio: 'inherit' })
      if (r.status !== 0) die('生成 SSH 密钥失败')
      pubPath = `${k}.pub`
    }
    const pub = readFileSync(pubPath, 'utf8').trim()

    console.log('把本机公钥添加到实例上，请输入 AutoDL 控制台里显示的密码：')
    const r = spawnSync(
      'ssh',
      [...sshOpts(conn), `${conn.user}@${conn.host}`, 'mkdir -p ~/.ssh && chmod 700 ~/.ssh && cat >> ~/.ssh/authorized_keys && chmod 600 ~/.ssh/authorized_keys'],
      { input: `${pub}\n`, stdio: ['pipe', 'inherit', 'inherit'] },
    )
    if (r.status !== 0) die('登录失败，检查登录指令和密码，并确认实例已经开机')
    if (remote(conn, 'true', { capture: true }).status !== 0) die('免密登录没有生效')

    writeFileSync(CONFIG, JSON.stringify(conn, null, 2))
    ensureEnv()
    console.log(`\n✓ 已连接 ${conn.user}@${conn.host}:${conn.port}，以后不用再输密码。下一步：npm run autodl -- setup`)
    break
  }

  case 'setup': {
    const c = loadConn()
    const setupPid = `${DATA}/logs/setup.pid`
    // 上一次安装还在跑：不能重新上传（会改写正在执行的脚本），直接接着看日志
    let pid = remote(c, `p=$(cat ${setupPid} 2>/dev/null) && kill -0 "$p" 2>/dev/null && echo "$p"`, { capture: true }).stdout.trim()
    if (pid) {
      console.log(`安装已经在实例后台运行（PID ${pid}），接着显示进度。按 Ctrl+C 只是不看了，安装会继续。\n`)
    } else {
      remote(c, `mkdir -p ${DATA}/logs ${DATA}/assets`)
      upload(c, ['gpu/serve.sh', 'gpu/autodl.sh'], `${DATA}/`)
      // Windows 上的 Git 可能把换行转成 CRLF，bash 不认，上传后统一转回 LF
      remote(c, `sed -i 's/\\r$//' ${DATA}/serve.sh ${DATA}/autodl.sh`)
      // 在实例上后台运行，SSH 断开也不影响；这里只是跟着看日志，按 Ctrl+C 不会中断安装
      const env = ['NEED_GB', 'HF_ENDPOINT', 'PIP_INDEX_URL', 'MODEL_SOURCE', 'DL_WORKERS'].filter((k) => process.env[k]).map((k) => `${k}=${process.env[k]}`)
      if (args.includes('--shutdown')) env.push('AUTO_SHUTDOWN=1')
      const extra = env.join(' ')
      // setsid：安装自成一个进程组，setup-stop 能连同 pip / 下载进程一起停掉
      const r = remote(c, `cd ${DATA} || exit 1; ${extra} setsid nohup bash autodl.sh > logs/setup.log 2>&1 < /dev/null & echo $! | tee ${setupPid}`, { capture: true })
      pid = r.stdout.trim()
      console.log(`安装和下载已在实例后台运行（PID ${pid}），下载约 144GB，需要较长时间。`)
      if (args.includes('--shutdown')) console.log('结束后（不论成功失败）实例会自动关机。')
    }
    console.log(`这里实时显示进度，按 Ctrl+C 只是不看了，安装会继续；之后可以再运行 npm run autodl -- setup-log 接着看。\n`)
    remote(c, `tail --pid=${pid} -n +1 -f ${DATA}/logs/setup.log`)
    remote(c, `tail -n 8 ${DATA}/logs/setup.log`, { capture: true }).stdout.includes('准备完成')
      ? console.log('\n✓ 准备完成。下一步：上传素材 npm run autodl -- assets <素材目录>，然后有卡模式开机，npm run autodl -- start')
      : console.log('\n安装没有完成，看上面的报错。修好后重新运行 npm run autodl -- setup 会断点续传。')
    break
  }

  case 'setup-stop': {
    const c = loadConn()
    // KILL 而不是 TERM：不触发 --shutdown 的自动关机。旧版本启动的安装没有独立进程组，再按名字补一刀（[p] 之类的写法防止匹配到这条命令自己；各模式的字面文字也不能互相匹配）
    remote(c, `p=$(cat ${DATA}/logs/setup.pid 2>/dev/null); [ -n "$p" ] && kill -KILL -- -$p 2>/dev/null; ` +
      `pkill -KILL -f '^bash autodl[.]sh'; pkill -KILL -f '[p]ip install'; ` +
      `pkill -KILL -f '[m]odelscope download'; pkill -KILL -f '[h]f download'; rm -f ${DATA}/logs/setup.pid; echo 已停止安装`)
    break
  }

  case 'setup-log': {
    const c = loadConn()
    remote(c, `tail -n 50 -f ${DATA}/logs/setup.log`)
    break
  }

  case 'assets': {
    const c = loadConn()
    const dir = args[0] || 'assets'
    const files = ASSETS.map((f) => join(dir, f))
    const missing = files.filter((f) => !existsSync(f))
    if (missing.length) die(`缺少素材：${missing.join(', ')}\n需要 anchor.png（9:16 定妆照）、portrait.png（正方形脸部特写）、voice.wav（6~10 秒人声）`)
    remote(c, `mkdir -p ${DATA}/assets`)
    upload(c, files, `${DATA}/assets/`)
    console.log(`✓ 素材已上传到 ${DATA}/assets/`)
    break
  }

  case 'start': {
    const c = loadConn()
    const gpu = remote(c, 'nvidia-smi --query-gpu=name,memory.total --format=csv,noheader 2>/dev/null', { capture: true })
    if (!gpu.stdout.trim()) die('实例上没有 GPU，可能是无卡模式开机。请在控制台关机后用正常模式开机')
    console.log(`GPU：${gpu.stdout.trim()}`)
    const assets = remote(c, `ls ${ASSETS.map((f) => `${DATA}/assets/${f}`).join(' ')}`, { capture: true })
    if (assets.status !== 0) die('实例上缺少素材，先运行 npm run autodl -- assets <素材目录>')
    if (remote(c, `test -x ${DATA}/start.sh`, { capture: true }).status !== 0) die('还没有完成准备，先运行 npm run autodl -- setup')

    if (remote(c, `curl -s -o /dev/null -w '%{http_code}' localhost:${PORT}/v1/models`, { capture: true }).stdout === '200') {
      console.log('✓ 服务已经在运行了')
    } else {
      const extra = ['OFFLOAD_TEXT', 'QUANT', 'LORA', 'MODE'].filter((k) => process.env[k]).map((k) => `${k}=${process.env[k]}`).join(' ')
      remote(c, `${extra} bash ${DATA}/start.sh`)
      console.log('等待服务就绪（第一次要加载权重、量化、编译，可能要 5~15 分钟）…')
      if (!(await waitReady(c))) process.exit(1)
      console.log('\n✓ H3 服务已就绪')
    }
    console.log('下一步：另开一个终端运行 npm run autodl -- tunnel，保持运行；再运行 npm run h3 -- say "你好呀"')
    break
  }

  case 'tunnel': {
    const c = loadConn()
    ensureEnv()
    console.log(`建立隧道：本机 localhost:${LOCAL_PORT} → 实例 ${PORT}（保持这个窗口打开，Ctrl+C 断开）`)
    const child = spawn(
      'ssh',
      [...sshOpts(c), '-o', 'BatchMode=yes', '-o', 'ExitOnForwardFailure=yes', '-N', '-L', `${LOCAL_PORT}:127.0.0.1:${PORT}`, `${c.user}@${c.host}`],
      { stdio: 'inherit' },
    )
    child.on('exit', (code) => process.exit(code ?? 0))
    await sleep(3000)
    try {
      const res = await fetch(`http://localhost:${LOCAL_PORT}/v1/models`)
      console.log(res.ok ? '✓ 隧道已通，H3 服务可以访问' : `隧道已建立，但服务返回 ${res.status}，可能还没启动完`)
    } catch {
      console.log('隧道已建立，但服务还连不上：确认已经运行 npm run autodl -- start 并且就绪')
    }
    break
  }

  case 'status': {
    const c = loadConn()
    remote(
      c,
      `echo "== GPU"; nvidia-smi --query-gpu=name,memory.used,memory.total,utilization.gpu --format=csv,noheader 2>/dev/null || echo "无 GPU（无卡模式）"; ` +
        `echo "== 系统盘 / 数据盘"; df -h / ${DATA} | tail -2; du -sh ${DATA}/models ${DATA}/venv 2>/dev/null; ` +
        `echo "== 素材"; ls -la ${DATA}/assets 2>/dev/null | tail -n +2; ` +
        `echo "== 服务"; [ -f ${DATA}/logs/serve.pid ] && kill -0 $(cat ${DATA}/logs/serve.pid) 2>/dev/null && echo "进程运行中" || echo "未运行"; ` +
        `code=$(curl -s -o /dev/null -w '%{http_code}' localhost:${PORT}/v1/models); [ "$code" = 200 ] && echo "接口可用" || echo "接口不可用（$code）"; ` +
        `echo "== 最近日志"; tail -n 5 ${DATA}/logs/serve.log 2>/dev/null || tail -n 5 ${DATA}/logs/setup.log 2>/dev/null`,
    )
    break
  }

  case 'logs': {
    const c = loadConn()
    remote(c, `tail -n 50 -f ${DATA}/logs/serve.log`)
    break
  }

  case 'stop': {
    const c = loadConn()
    remote(c, `bash ${DATA}/stop.sh`)
    console.log('提醒：不用的时候在 AutoDL 控制台关机，避免继续计费')
    break
  }

  default:
    console.log(readFileSync(new URL(import.meta.url), 'utf8').split('\n').slice(0, 12).join('\n'))
    process.exit(command ? 1 : 0)
}
