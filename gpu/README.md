# MiniMax H3 视频聊天：GPU 部署与提速

视频聊天模式（`/video.html`）的流程：用户发一句话 → 文本模型写台词和表情 → H3 在 GPU 上拍成一段几秒的视频 → 前端播放。

> 用 AutoDL 的话，直接看 [AUTODL.md](AUTODL.md)，按步骤走即可。

## 1. 两种模式

| | **一致性模式**（默认，`MODE=ref`） | **极速模式**（`MODE=fast`） |
|---|---|---|
| 模型 | 官方 MiniMax H3 的 ref2va 分区 + [lightx2v Ref2V 8 步加速 LoRA](https://huggingface.co/lightx2v/Minimax-h3-Turbo) | 社区蒸馏的 [FastH3](https://haoailab.com/blogs/fasth3-preview/) |
| 步数 | 8 步（原版 50 步，约快 6 倍） | 4 次前向 + 90% 稀疏注意力 |
| 能传的条件 | 参考图 + 声音样本 + 首尾帧 | **只有文字**（FastH3 只蒸馏了文生视频） |
| 一致性 | 每段视频首尾帧钉在同一张定妆照上，声音来自固定样本，长相、声音、场景都稳定 | 靠固定的文字描述 + 固定种子，会有漂移 |
| 适合 | 正式使用 | 能接受轻微「换人」、只追求最快时 |

两种模式都要在 Web 服务器的 `.env` 里设置对应的 `H3_MODE`，默认都是 ref。

## 2. 选卡

主干网络 33B 参数（BF16 约 66GB），文本编码器 BF16 约 51GB。

| 配置 | 说明 |
|---|---|
| **1 × H100 80GB**（够用） | `serve.sh` 自动开在线 FP8（主干约 33GB），文本编码器卸载到 CPU，LoRA 在前向时单独计算、不合并进 FP8 权重 |
| **1 × B200 / H200**（更快、更省心） | 显存够，不用量化和卸载，画质最接近原版 |
| 多卡 | `GPUS=2 bash serve.sh` 序列并行，单条请求更快 |

**延迟主要取决于算力**，显存只决定能不能放下。

## 3. 安装与启动（在 GPU 机器上）

```bash
apt-get install -y ffmpeg                 # H3 处理媒体需要 ffmpeg / ffprobe
pip install "sglang[diffusion]"
export HF_TOKEN=...                       # 首次启动会从 Hugging Face 下载基础模型和 LoRA
bash serve.sh                             # 一致性模式 + 8 步 LoRA，默认端口 30000
```

可调的环境变量写在 `serve.sh` 开头：
- `LORA=none`：不加载加速 LoRA。这时 Web 端的 `H3_STEPS` 要改回 30~50。
- `LORA` / `LORA_WEIGHT`：换别的 LoRA，比如 [HyperFlow](https://huggingface.co/videorebirth/hyperflow)，它一个文件同时支持 t2va / fl2va / ref2va。
- `QUANT=none`：在大显存卡上关掉 FP8。
- `MODE=fast`：极速模式。

**安全**：不要把 30000 端口直接暴露到公网。用防火墙只放行 Web 服务器的 IP，或者用 SSH 隧道：
`ssh -N -L 30000:localhost:30000 gpu-host`，Web 服务器上 `H3_BASE_URL=http://localhost:30000`。
前面加了带鉴权的网关的话，把 Bearer token 填到 `H3_API_KEY`。

## 4. 准备素材（一致性模式）

放在 GPU 机器的 `/workspace/assets/`（`H3_ASSET_DIR` 可改）：

| 文件 | 要求 | 作用 |
|---|---|---|
| `anchor.png` | 9:16 竖图，就是视频画面本身：她在卧室里看着镜头、表情放松 | 每段视频的第一帧和最后一帧都钉在这张图上，画面永远一致，片段之间、和待机视频之间无缝衔接 |
| `portrait.png` | **正方形**脸部特写（可以从 anchor 里裁） | 长相参考。服务端会把参考图放大到短边 2048 再编码，正方形比 9:16 少约 44% 的 token |
| `voice.wav` | 6~10 秒、干净的人声，不要背景音乐 | 声音参考，保证每段视频是同一个声音。会被截断到视频时长，太长没用 |

制作建议：`anchor.png` 用任意文生图工具做成竖屏自拍风格；声音可以先让 H3 生成一段她说话的视频，满意后用
`ffmpeg -i clip.mp4 -vn -ac 1 voice.wav` 提取。场景描述写在 `server/videochat/prompt.js` 的 `scene`，要和 `anchor.png` 一致。

## 5. 预热、待机视频、调参（在 Web 服务器上运行）

```bash
npm run h3 -- warmup          # 每个时长档发一次请求，触发 torch.compile 编译（首次每档会比较慢）
npm run h3 -- idle            # 生成待机循环视频 → public/video/idle.mp4
npm run h3 -- say "哈哈，真的假的？快跟我说说！" --emotion surprised

# 第一次部署建议跑这两组，对比速度和画质 / 声音
npm run h3 -- bench --durations 4,6,8 --steps 8 --shifts 12,6   # 时间步偏移：模型卡写 12，也有资料写训练用 6
npm run h3 -- bench --durations 6 --steps 8,12                   # 8 步不够好时，多几步换画质
```

`bench` 输出表格的最后一列「等待 / 视频时长」就是实际体验：2.0x 表示 6 秒的回复要等约 12 秒。
**每组的视频都保存在 `media/` 里，文件名打印在输出中。除了速度，一定要看画面、听声音再定参数。**
定下来的值写进 `.env`：`H3_STEPS`、`H3_FLOW_SHIFT`、`H3_AUDIO_FLOW_SHIFT`。

## 6. 已经做的提速

| 措施 | 说明 |
|---|---|
| **8 步加速 LoRA**（ref 模式） | lightx2v 专门为 Ref2VA 蒸馏的 768p 版本；比早期 4 步版画质和音频更好 |
| 台词短 + 按长度选时长 | 台词限制在 40 字以内；时长 = 朗读时间 + 留白，向上取到 4/6/8/10/12/15 秒档，大部分回复 4~6 秒 |
| 固定时长档 + 预热 | torch.compile 按张量形状编译，只有几种时长，预热后请求时不再临时编译 |
| 首尾帧钉在定妆照上 | 画面不漂移；回复视频和待机视频首尾相接，切换时看不出接缝 |
| 正方形参考图 | 参考图 token 少约 44% |
| FP8（80GB 卡） | 显存减半，矩阵乘更快 |
| 待机视频掩盖等待 | 等待时她在画面里安静地听，前端显示「她在录视频… 已等待 / 预计时间」 |
| 无引导分支 | H3 是引导蒸馏模型，每步只算一次前向 |

### 还可以继续做的

| 方向 | 说明 |
|---|---|
| 阿里 PAI 的 PDD 8 步加速（官方蒸馏） | 有 Ref2VA 专用版本。它不是普通 LoRA，SGLang 自带合并工具：`python3 -m sglang.multimodal_gen.tools.build_minimax_h3_pdd_weights`，用法见该文件开头的说明 |
| 稀疏 / INT8 注意力 | 社区在单卡上测到 INT8 注意力在 Turbo LoRA 基础上又快约 1.6 倍（RTX 5090，作者自测） |
| VDN-H3（混合线性注意力） | SGLang 已内置流水线，作者称 8 步画质不输 50 步原版；是否支持 ref2va 还没确认 |
| 跨请求缓存参考素材的编码 | 固定素材目前每次都会重新编码，场景固定的话只需要算一次，要改 SGLang |
| 换推理引擎 | vLLM-Omni 已支持 H3，做了 AdaLN 缓存、VAE FP8 等系统级优化，可以和 SGLang 对比 |

## 7. 风险（先实测）

- **8 步 LoRA 加 FP8 的组合没有公开测评**。80GB 卡上画质不满意的话，换大显存卡用 `QUANT=none` 对比。
- 有论坛帖转述 MiniMax 的说法：**ref2va 本身的画质目前不如 fl2va**，他们在改进。
- 有用户反馈 Ref2V 8 步 LoRA「参考相似度不错，但提示词遵循不太稳定」；4 步版有人反馈人声变差，8 步版官方说已改善，**声音要自己听**。
- 中文对白的口型和发音没有找到专门测评，要用自己的角色实测。
- H3 权重是社区许可证，部分地区不在授权范围内，商用前看清楚许可证。
