#!/usr/bin/env bash
# 在租用的 GPU 机器上启动 MiniMax H3（SGLang）。用法见 gpu/README.md。
#
#   bash serve.sh                # 默认：单卡、ref2va、FP8
#   GPUS=2 bash serve.sh         # 两卡序列并行，单条请求更快
#   LORA=<加速 LoRA 路径> bash serve.sh
set -euo pipefail

MODEL=${MODEL:-MiniMaxAI/MiniMax-H3}
PORT=${PORT:-30000}
GPUS=${GPUS:-1}
QUANT=${QUANT:-fp8}            # Hopper/Blackwell 上在线 FP8：显存减半、矩阵乘更快；设为空则用 BF16
OFFLOAD_TEXT=${OFFLOAD_TEXT:-auto}  # 文本编码器 BF16 约 51GB；单张 80GB 卡放不下全部时卸载到 CPU
LORA=${LORA:-}                 # 少步数加速 LoRA（需确认是 ref2va 分区可用的）

args=(
  --model-path "$MODEL"
  --model-variant ref2va        # 只加载 ref2va 分区（参考图 + 声音 + 首尾帧）
  --host 0.0.0.0
  --port "$PORT"
  --num-gpus "$GPUS"
  --enable-torch-compile        # 首次请求每种尺寸会编译，之后复用；配合固定时长分档
  --input-save-path ""          # 不保存上传的素材
  --warmup-mode off             # 用 `npm run h3 -- warmup` 按真实请求形状预热
)

if [[ -n "$QUANT" ]]; then args+=(--quantization "$QUANT"); fi
if [[ -n "$LORA" ]]; then args+=(--lora-path "$LORA"); fi

if [[ "$OFFLOAD_TEXT" == "auto" ]]; then
  mem=$(nvidia-smi --query-gpu=memory.total --format=csv,noheader,nounits | head -1)
  # 小于 120GB（如 H100 80GB）时卸载文本编码器；H200 141GB 放得下
  if (( GPUS == 1 && mem < 120000 )); then OFFLOAD_TEXT=1; else OFFLOAD_TEXT=0; fi
fi
if [[ "$OFFLOAD_TEXT" == "1" ]]; then args+=(--text-encoder-cpu-offload); fi

echo "sglang serve ${args[*]}"
exec sglang serve "${args[@]}"
