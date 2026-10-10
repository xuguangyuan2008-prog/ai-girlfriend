#!/usr/bin/env bash
# AutoDL 一键准备：装依赖 → 只下载 H3 的 Ref2VA 分区和 8 步 LoRA → 生成启动脚本。
# 建议在「无卡模式」开机时运行（便宜），下载中断了重新运行会断点续传。
#
#   bash autodl.sh
set -euo pipefail

DATA=${DATA:-/root/autodl-tmp}                       # AutoDL 数据盘，系统盘只有 30GB，不要往那里放模型
MODELS=$DATA/models
export HF_ENDPOINT=${HF_ENDPOINT:-https://hf-mirror.com}   # 国内用镜像下载 Hugging Face
export HF_HOME=$DATA/hf                              # 缓存也放数据盘
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
pip install -U "sglang[diffusion]" "huggingface_hub[cli]"

echo "== 3/5 下载 MiniMax-H3 的 Ref2VA 分区（只下需要的一半，约 140GB，耗时较长）"
hf download MiniMaxAI/MiniMax-H3 --include "Ref2VA/*" "*.json" --local-dir "$MODELS/MiniMax-H3"
if [[ ! -d "$MODELS/MiniMax-H3/Ref2VA" ]]; then
  echo "没找到 Ref2VA 目录，仓库的目录结构可能变了。看看下载下来有什么："
  ls "$MODELS/MiniMax-H3"
  echo "把子目录名告诉开发者，或者改 --include 参数后重试。"
  exit 1
fi

echo "== 4/5 下载 lightx2v Ref2V 8 步加速 LoRA（约 1.4GB）"
LORA_FILE=minimax_h3_ref2v_turbo_8step_v1.0_768p_bf16.safetensors
hf download lightx2v/Minimax-h3-Turbo "$LORA_FILE" --local-dir "$MODELS/loras"

echo "== 5/5 生成启动脚本 $DATA/start.sh"
mkdir -p "$DATA/assets" "$DATA/logs"
SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
cat > "$DATA/start.sh" <<START
#!/usr/bin/env bash
# 后台启动 H3 服务，日志在 $DATA/logs/serve.log。看日志：tail -f $DATA/logs/serve.log
export HF_HOME=$HF_HOME HF_ENDPOINT=$HF_ENDPOINT HF_HUB_OFFLINE=1
export MODEL=$MODELS/MiniMax-H3 LORA=$MODELS/loras/$LORA_FILE
nohup bash $SCRIPT_DIR/serve.sh > $DATA/logs/serve.log 2>&1 &
echo "已在后台启动（PID \$!），首次加载权重 + FP8 量化 + 编译要几分钟。"
echo "看到日志里出现服务已就绪 / Uvicorn running 之类的字样后即可使用：tail -f $DATA/logs/serve.log"
START
chmod +x "$DATA/start.sh"

du -sh "$MODELS"/* 2>/dev/null || true
cat <<DONE

准备完成。接下来：
  1. 把 anchor.png / portrait.png / voice.wav 上传到 $DATA/assets/
  2. 关机，切换成「有卡模式」开机
  3. 运行：bash $DATA/start.sh
DONE
