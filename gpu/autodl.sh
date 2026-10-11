#!/usr/bin/env bash
# AutoDL 一键准备：装依赖 → 只下载 H3 的 Ref2VA 分区和 8 步 LoRA → 生成启动脚本。
# 建议在「无卡模式」开机时运行（便宜），下载中断了重新运行会断点续传。
#
#   bash autodl.sh
set -euo pipefail

# AUTO_SHUTDOWN=1：脚本结束（不论成功失败）后让实例关机，有卡模式下载完不空转计费。AutoDL 实例里执行 shutdown 就是关机
if [[ ${AUTO_SHUTDOWN:-0} == 1 ]]; then
  trap 'echo "== 安装脚本已结束，60 秒后自动关机"; sleep 60; shutdown' EXIT
fi

# 后台 SSH 执行时不会读 ~/.bashrc，AutoDL 镜像里 conda 的 Python 不在 PATH 上；优先用它（自带 venv）
for d in /root/miniconda3/bin /root/anaconda3/bin /opt/conda/bin; do
  if [[ -x $d/python3 ]]; then export PATH=$d:$PATH; break; fi
done
command -v python3 >/dev/null || { echo "找不到 python3，请换 AutoDL 的 PyTorch 基础镜像"; exit 1; }

DATA=${DATA:-/root/autodl-tmp}                       # AutoDL 数据盘，系统盘只有 30GB，不要往那里放模型
MODELS=$DATA/models
# 模型下载源：modelscope（魔搭，默认）或 hf（Hugging Face）。AutoDL 上实测魔搭快得多
MODEL_SOURCE=${MODEL_SOURCE:-modelscope}
export HF_ENDPOINT=${HF_ENDPOINT:-https://hf-mirror.com}   # 用 hf 时走国内镜像
export HF_HOME=$DATA/hf MODELSCOPE_CACHE=$DATA/cache/modelscope   # 缓存也放数据盘
DL_WORKERS=${DL_WORKERS:-8}                          # 并行下载的文件数
# 魔搭默认每个文件只用一条连接（AutoDL 上单连接只有 0.4~1.5MB/s），大于 500MB 的文件改成 16 路分段并行下载
export MODELSCOPE_DOWNLOAD_PARALLELS=${MODELSCOPE_DOWNLOAD_PARALLELS:-16}
NEED_GB=${NEED_GB:-170}

echo "== 1/5 检查数据盘空间"
avail=$(df -BG --output=avail "$DATA" | tail -1 | tr -dc 0-9)
have=$(du -s -BG "$MODELS" 2>/dev/null | cut -f1 | tr -dc 0-9 || true)
if (( avail + ${have:-0} < NEED_GB )); then
  echo "数据盘剩余 ${avail}GB，已下载 ${have:-0}GB，至少需要约 ${NEED_GB}GB。"
  echo "请在 AutoDL 控制台「更多 → 扩容数据盘」扩到 200GB 以上再运行。"
  exit 1
fi

echo "== 2/5 安装 ffmpeg 和 SGLang（会顺带安装 torch，体积较大）"
if ! command -v ffmpeg >/dev/null; then apt-get update -qq && apt-get install -y -qq ffmpeg; fi
# 装进数据盘上的独立虚拟环境：系统盘只有 30GB，镜像自带的包（比如 ComfyUI 镜像）也可能和 SGLang 冲突
VENV=$DATA/venv
export PIP_CACHE_DIR=$DATA/cache/pip TMPDIR=$DATA/tmp
mkdir -p "$PIP_CACHE_DIR" "$TMPDIR"
make_venv() { rm -rf "$VENV"; python3 -m venv "$VENV" >/dev/null 2>&1 && [[ -x $VENV/bin/pip ]]; }
if [[ ! -x $VENV/bin/pip ]]; then   # 上次没建完整（比如缺 ensurepip）也会重建
  python3 -c 'import sys; sys.exit(sys.version_info < (3, 10))' || { echo "需要 Python 3.10 以上，当前是 $(python3 -V)，请换 PyTorch 基础镜像"; exit 1; }
  pyver=$(python3 -c 'import sys; print(f"{sys.version_info[0]}.{sys.version_info[1]}")')
  if ! make_venv; then
    echo "系统 Python 缺少 venv 组件，安装 python${pyver}-venv"
    { apt-get update -qq && apt-get install -y -qq "python${pyver}-venv"; } || true
    if ! make_venv; then
      echo "改用 virtualenv 创建虚拟环境"
      rm -rf "$VENV"
      python3 -m pip install -q virtualenv && python3 -m virtualenv "$VENV"
    fi
  fi
fi
# shellcheck disable=SC1091
source "$VENV/bin/activate"
# 选 PyPI 镜像：各测几秒下载速度，用最快的（AutoDL 上各镜像差别很大）。PIP_INDEX_URL 可直接指定
pick_mirror() {
  python3 - <<'PY'
import re, subprocess, sys, urllib.parse as p, urllib.request as u
cands = ['https://mirrors.aliyun.com/pypi/simple/', 'https://pypi.tuna.tsinghua.edu.cn/simple/',
         'https://mirrors.cloud.tencent.com/pypi/simple/', 'https://repo.huaweicloud.com/repository/pypi/simple/',
         'https://mirrors.bfsu.edu.cn/pypi/web/simple/', 'https://pypi.org/simple/']
best = (-1.0, cands[0])
for c in cands:
    speed = 0.0
    try:
        idx = c + 'mistral-common/'   # 用一个不太热门、6.6MB 的包测，更接近实际安装时的情况
        links = [x for x in re.findall(r'href="([^"]+)"', u.urlopen(idx, timeout=8).read().decode())
                 if 'mistral_common-1.12.0-py3-none-any.whl' in x]
        url = p.urljoin(idx, links[0].split('#')[0])
        out = subprocess.run(['curl', '-sL', '-o', '/dev/null', '-m', '8', '-w', '%{speed_download}', url],
                             capture_output=True, text=True).stdout
        speed = float(out or 0)
    except Exception:
        pass
    print(f'  {speed / 1048576:6.2f} MB/s  {c}', file=sys.stderr)
    if speed > best[0]:   # 全都连不上时用第一个（阿里云）
        best = (speed, c)
print(best[1])
PY
}
if [[ -z ${PIP_INDEX_URL:-} ]]; then
  echo "测试 PyPI 镜像速度："
  PIP_INDEX_URL=$(pick_mirror)
fi
export PIP_INDEX_URL UV_INDEX_URL=$PIP_INDEX_URL UV_CACHE_DIR=$DATA/cache/uv UV_HTTP_TIMEOUT=300
echo "pip 源：$PIP_INDEX_URL"
# 用 uv 安装（SGLang 官方推荐）：并行下载，比 pip 一个一个下快得多；uv 出问题时退回 pip
PKGS=("sglang[diffusion]" "huggingface_hub[cli]" modelscope)
if pip install -q -U uv && uv pip install --python "$VENV/bin/python" -U "${PKGS[@]}"; then
  :
else
  echo "uv 安装失败，改用 pip"
  pip install -U "${PKGS[@]}"
fi
rm -rf "$PIP_CACHE_DIR" "$UV_CACHE_DIR"              # 装好了，下载缓存（几 GB）留着没用

# 下载：download <魔搭仓库> <HF 仓库> <目标目录> <文件或 --include 参数...>
download() {
  local ms=$1 hf=$2 dir=$3; shift 3
  if [[ $MODEL_SOURCE == hf ]]; then
    hf download "$hf" "$@" --local-dir "$dir" --max-workers "$DL_WORKERS"
  else
    modelscope download "$ms" "$@" --local-dir "$dir" --max-workers "$DL_WORKERS"
  fi
}
echo "模型下载源：$MODEL_SOURCE（可用 MODEL_SOURCE=hf 换成 Hugging Face）"

echo "== 3/5 下载 MiniMax-H3 的 Ref2VA 分区（整个仓库约 500GB，只下需要的约 144GB，耗时较长）"
download MiniMax/MiniMax-H3 MiniMaxAI/MiniMax-H3 "$MODELS/MiniMax-H3" --include "Ref2VA/*" "*.json"
if [[ ! -d "$MODELS/MiniMax-H3/Ref2VA" ]]; then
  echo "没找到 Ref2VA 目录，仓库的目录结构可能变了。看看下载下来有什么："
  ls "$MODELS/MiniMax-H3"
  echo "把子目录名告诉开发者，或者改 --include 参数后重试。"
  exit 1
fi

echo "== 4/5 下载 lightx2v Ref2V 8 步加速 LoRA（约 1.4GB）"
LORA_FILE=minimax_h3_ref2v_turbo_8step_v1.0_768p_bf16.safetensors
download lightx2v/Minimax-h3-Turbo lightx2v/Minimax-h3-Turbo "$MODELS/loras" "$LORA_FILE"

echo "== 5/5 生成启动 / 停止脚本 $DATA/start.sh、$DATA/stop.sh"
mkdir -p "$DATA/assets" "$DATA/logs"
SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
PID_FILE=$DATA/logs/serve.pid
cat > "$DATA/start.sh" <<START
#!/usr/bin/env bash
# 后台启动 H3 服务，日志在 $DATA/logs/serve.log。看日志：tail -f $DATA/logs/serve.log
if [ -f $PID_FILE ] && kill -0 "\$(cat $PID_FILE)" 2>/dev/null; then echo "服务已经在运行"; exit 0; fi
source $VENV/bin/activate
export HF_HOME=$HF_HOME HF_ENDPOINT=$HF_ENDPOINT HF_HUB_OFFLINE=1
# torch.compile / Triton 的编译缓存也放数据盘，重启后不用重新编译
export TORCHINDUCTOR_CACHE_DIR=$DATA/cache/inductor TRITON_CACHE_DIR=$DATA/cache/triton
export MODEL=\${MODEL:-$MODELS/MiniMax-H3} LORA=\${LORA:-$MODELS/loras/$LORA_FILE}
# setsid 让服务自成一个进程组，停止时连同 SGLang 派生的工作进程一起结束
setsid nohup bash $SCRIPT_DIR/serve.sh > $DATA/logs/serve.log 2>&1 < /dev/null &
echo \$! > $PID_FILE
echo "已在后台启动，首次加载权重 + FP8 量化 + 编译要几分钟。看日志：tail -f $DATA/logs/serve.log"
START
cat > "$DATA/stop.sh" <<STOP
#!/usr/bin/env bash
# 停止 H3 服务（整个进程组）
if ! [ -f $PID_FILE ] || ! kill -0 "\$(cat $PID_FILE)" 2>/dev/null; then echo "服务没有在运行"; rm -f $PID_FILE; exit 0; fi
pgid=\$(cat $PID_FILE)
kill -TERM -- -\$pgid 2>/dev/null
for i in \$(seq 20); do kill -0 -- -\$pgid 2>/dev/null || break; sleep 1; done
kill -KILL -- -\$pgid 2>/dev/null
rm -f $PID_FILE
echo "已停止"
STOP
chmod +x "$DATA/start.sh" "$DATA/stop.sh"

du -sh "$MODELS"/* 2>/dev/null || true
cat <<DONE

准备完成。接下来：
  1. 把 anchor.png / portrait.png / voice.wav 上传到 $DATA/assets/
  2. 关机，切换成「有卡模式」开机
  3. 运行：bash $DATA/start.sh
DONE
