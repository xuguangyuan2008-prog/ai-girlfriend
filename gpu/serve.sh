#!/usr/bin/env bash
# 在租用的 GPU 机器上启动 MiniMax H3（SGLang）。用法见 gpu/README.md。
#
#   bash serve.sh                 # 默认：基础版 H3 ref2va + lightx2v Ref2V 8 步加速 LoRA
#   LORA=none bash serve.sh       # 不加载加速 LoRA（此时 Web 端 H3_STEPS 要改回 30~50）
#   MODE=fast bash serve.sh       # FastH3（只支持文生视频，最快，但长相/声音会漂）
#   GPUS=2 bash serve.sh          # 多卡序列并行，单条请求更快
#
# Web 服务器 .env 里的 H3_MODE / H3_STEPS 要和这里对应。
set -euo pipefail

MODE=${MODE:-ref}
PORT=${PORT:-30000}
GPUS=${GPUS:-1}
QUANT=${QUANT:-auto}               # auto：单卡显存 < 120GB 时用在线 FP8；none：不量化；或指定 fp8
OFFLOAD_TEXT=${OFFLOAD_TEXT:-auto} # 文本编码器 BF16 约 51GB；单卡显存 < 120GB 时卸载到 CPU

# ref 模式的加速 LoRA：lightx2v 专门为 Ref2VA 蒸馏的 8 步 768p 版本（diffusers 格式）
LORA=${LORA:-lightx2v/Minimax-h3-Turbo}
LORA_WEIGHT=${LORA_WEIGHT:-minimax_h3_ref2v_turbo_8step_v1.0_768p_bf16.safetensors}

mem=$(nvidia-smi --query-gpu=memory.total --format=csv,noheader,nounits | head -1)
small_card=$(( GPUS == 1 && mem < 120000 ))

# 主干网络 BF16 约 66GB，80GB 卡放不下「主干 + 激活」，自动用 FP8
if [[ "$QUANT" == "auto" ]]; then QUANT=$([[ $small_card == 1 ]] && echo fp8 || echo none); fi
if [[ "$OFFLOAD_TEXT" == "auto" ]]; then OFFLOAD_TEXT=$small_card; fi

args=(--host 0.0.0.0 --port "$PORT" --num-gpus "$GPUS" --input-save-path "" --warmup-mode off)

if [[ "$MODE" == "fast" ]]; then
  MODEL=${MODEL:-FastVideo/FastVideo-FastH3-4-step-Preview-v1-VSA-DataFree}
  args+=(
    --model-path "$MODEL"
    # FastH3 是带稀疏注意力门控训练的，要用配套的 VSA 后端
    --attention-backend video_sparse_attn_h3
    --attention-backend-config '{"VSA_sparsity": 0.9}'
  )
else
  MODEL=${MODEL:-MiniMaxAI/MiniMax-H3}
  args+=(
    --model-path "$MODEL"
    --model-variant ref2va        # 只加载 ref2va 分区
    --enable-torch-compile        # 配合固定时长档，用 `npm run h3 -- warmup` 预热
  )
  if [[ "$LORA" != "none" ]]; then
    args+=(--lora-path "$LORA" --lora-weight-name "$LORA_WEIGHT")
    # 主干量化成 FP8 时，LoRA 在前向时单独计算，不合并进 FP8 权重，避免精度损失
    if [[ "$QUANT" != "none" ]]; then args+=(--lora-merge-mode dynamic); fi
  fi
fi

if [[ "$QUANT" != "none" ]]; then args+=(--quantization "$QUANT"); fi
if [[ "$OFFLOAD_TEXT" == "1" ]]; then args+=(--text-encoder-cpu-offload); fi

echo "显存 ${mem}MiB × ${GPUS}，模式 ${MODE}，量化 ${QUANT}，LoRA ${LORA}"
echo "sglang serve ${args[*]}"
exec sglang serve "${args[@]}"
