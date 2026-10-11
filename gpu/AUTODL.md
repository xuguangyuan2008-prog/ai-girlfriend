# 在 AutoDL 上跑视频聊天

整体结构：**GPU 只跑 H3**（AutoDL），**网页和台词生成跑在你自己的电脑上**，两者通过 SSH 隧道连起来。
AutoDL 上的配置全部由你电脑上的 `npm run autodl` 命令自动完成，不用登录实例手动敲命令。

```
你的电脑：npm run dev（网页 + 台词编剧）──SSH 隧道──► AutoDL：SGLang + MiniMax H3（端口 30000）
```

## 选卡

| 卡 | 说明 |
|---|---|
| **RTX PRO 6000 96GB**（约 ¥7.35/时，推荐） | Blackwell 架构，支持 FP8，算力完整。启动时自动开 FP8，并把文本编码器卸载到 CPU 内存（需要约 52GB，110GB 够用） |
| RTX 6000D 84GB（约 ¥6.8/时） | 国内特供版，算力有削减。配置方式同上 |
| H800 80GB（约 ¥10/时） | 算力更强。配置方式同上 |
| A800 80GB | **不推荐**：Ampere 架构不支持 FP8，放不下 |
| RTX 5090 32GB | 显存不够 |

价格以 AutoDL 官网为准。按量计费，**不用时记得关机**。

## 0. 准备你的电脑

需要 Node.js 22 以上，以及 ssh（macOS、Linux、Windows 10 以上都自带）。

```bash
git clone <这个仓库> && cd ai-girlfriend
npm install
cp .env.example .env
```

在 `.env` 里填好台词编剧（火山方舟上开通一个便宜快速的模型）：

```bash
CHAT_API_KEY=你的方舟 API Key
CHAT_MODEL=模型名或推理接入点 ID（ep-xxxx）
```

H3 相关的两项（`H3_BASE_URL`、`H3_ASSET_DIR`）会在下面的第 1 步自动加上。

## 1. 租卡，连上实例

1. AutoDL 控制台 → 租新实例 → 选 RTX PRO 6000。镜像随意，只要 Python ≥ 3.10（基础镜像的 PyTorch 最干净；ComfyUI 之类的社区镜像也行）。SGLang 会装进数据盘上的独立虚拟环境，不占系统盘，也不影响镜像自带的环境。
2. **把数据盘扩容到 200GB 以上**：只下载 Ref2VA 部分也要约 144GB。
3. 用「**无卡模式**」开机。装依赖、下载模型都不需要 GPU，无卡模式便宜很多。
4. 在实例列表里复制「登录指令」和密码，在你电脑的项目目录里运行：

```bash
npm run autodl -- login "ssh -p 12345 root@connect.westb.seetacloud.com"
```

按提示输入一次密码。命令会在实例上配置免密登录，之后所有操作都不用再输密码。

## 2. 安装依赖、下载模型（无卡模式下）

```bash
npm run autodl -- setup
```

这一步会在实例上：
- 检查磁盘空间；
- 安装 ffmpeg 和 SGLang；
- 从魔搭社区**只下载 H3 的 Ref2VA 部分**和 8 步加速 LoRA（AutoDL 上实测魔搭比 Hugging Face 镜像快得多）；
- 生成启动和停止脚本。

下载约 144GB，要一段时间。实测无卡模式限速（约 4MB/s，要十个小时左右），有卡模式约 14MB/s（3 小时左右）。在有卡模式下装的话，加上 `--shutdown`，装完自动关机，不空转计费：

```bash
npm run autodl -- setup --shutdown
```

安装在实例后台运行，**按 Ctrl+C 或关掉电脑都不会中断**，之后用 `npm run autodl -- setup-log` 接着看进度。中途失败的话，重新运行 `setup` 会断点续传。

## 3. 上传角色素材

在电脑上建一个文件夹，放三个文件（要求见 [README 第 4 节](README.md#4-准备素材一致性模式)），然后上传：

```bash
npm run autodl -- assets ./my-assets
```

- `anchor.png`：9:16 定妆照，就是视频画面本身；
- `portrait.png`：正方形脸部特写；
- `voice.wav`：6~10 秒干净人声。**只用你有权使用的声音**。

角色的文字描述在 `server/videochat/prompt.js` 的 `scene` 里，要和定妆照对得上。

## 4. 有卡开机，启动服务

在控制台关机，用**正常模式**（有卡）开机，然后：

```bash
npm run autodl -- start
```

命令会检查 GPU 和素材，后台启动 H3，并一直等到服务就绪。第一次要加载约 66GB 权重、做 FP8 量化、编译，大约 5~15 分钟。

## 5. 连接并测试

另开一个终端，建立隧道，**这个窗口保持开着**：

```bash
npm run autodl -- tunnel
```

再开一个终端：

```bash
npm run h3 -- say "哈哈，真的假的？快跟我说说！" --emotion surprised   # 先生成一段看看效果
npm run h3 -- warmup                                                  # 预热各个时长档
npm run h3 -- idle                                                    # 生成待机循环视频
npm run h3 -- bench --durations 4,6,8 --steps 8 --shifts 12,6         # 测速度、对比参数
npm run dev                                                           # 打开 http://localhost:5173/video.html 开始聊天
```

生成的视频都在项目的 `media/` 目录里。**除了速度，一定要看画面、听声音**，满意的参数写进 `.env`。

## 日常使用

| 命令 | 作用 |
|---|---|
| `npm run autodl -- status` | 查看 GPU、磁盘、素材、服务状态和最近日志 |
| `npm run autodl -- logs` | 实时看服务日志 |
| `npm run autodl -- stop` | 停止服务（连同所有子进程） |
| `npm run autodl -- start` | 启动服务 |
| `npm run autodl -- tunnel` | 建立隧道 |

每次用完：`stop`，然后**在控制台关机**。下次用时开机 → `start` → `tunnel`。

## 常见问题

下面 `XXX=值 npm run ...` 的写法适用于 macOS / Linux。Windows PowerShell 里要分两步写：`$env:XXX="值"; npm run ...`。

- **AutoDL 换了登录地址或端口**（比如迁移实例后）：重新运行 `login`。
- **本机 30000 端口被占用**：`LOCAL_PORT=30001 npm run autodl -- tunnel`，并把 `.env` 里的 `H3_BASE_URL` 改成 `http://localhost:30001`。
- **启动时显存不足（OOM）**：把 `.env` 里的 `H3_SHORT_EDGE` 改成 640 或 480 再试；或者用 `QUANT=none npm run autodl -- start` 换大显存卡。
- **想试试文本编码器常驻显存**（每条请求少一次搬运，96GB 卡可能放得下）：
  `npm run autodl -- stop && OFFLOAD_TEXT=0 npm run autodl -- start`，报显存不足就改回去。
- **下载很慢或失败**：模型默认从魔搭下载，用 `MODEL_SOURCE=hf` 换成 Hugging Face（`HF_ENDPOINT` 选镜像），`DL_WORKERS` 调并行数；pip 依赖默认走阿里云镜像，用 `PIP_INDEX_URL=<其它源>` 换。无卡模式的网速可能受限，可以在有卡模式下测一次速度再决定在哪个模式下载。
- **装完 torch 报驱动太旧**：把 `npm run autodl -- setup-log` 里的报错发给开发者，需要换对应 CUDA 版本的 torch。
- **想让手机也能用**：手机访问的是你电脑上的网页，不是 AutoDL，按主 README 的「在手机上测试」配置即可。AutoDL 的端口不要直接暴露到公网。
