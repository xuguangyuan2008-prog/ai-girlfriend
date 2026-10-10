# 在 AutoDL 上跑视频聊天

整体结构：**GPU 只跑 H3**（AutoDL），**网页和台词生成跑在你自己的电脑上**，两者通过 SSH 隧道连起来。

```
你的电脑：npm run dev（网页 + 台词编剧）──SSH 隧道──► AutoDL：SGLang + MiniMax H3（端口 30000）
```

## 选卡

| 卡 | 说明 |
|---|---|
| **RTX 6000D 84GB**（约 ¥6.8/时，推荐先用它试） | Blackwell 架构，支持 FP8。启动脚本会自动开 FP8，并把文本编码器卸载到 CPU 内存（需要约 52GB 内存，110GB 够用）。国内特供版，算力有削减，速度要实测 |
| H800 80GB（约 ¥10/时） | 算力更强，延迟更低。配置方式同上 |
| A800 80GB | **不推荐**：Ampere 架构不支持 FP8，80GB 放不下 BF16 的主干网络和运行时显存 |
| RTX 5090 32GB | 显存不够这套部署 |

价格以 AutoDL 官网为准。按量计费，**不用时记得关机**。

## 第一步：在你的电脑上准备网页端

需要 Node.js 22 以上。

```bash
git clone <这个仓库> && cd ai-girlfriend
npm install
cp .env.example .env
```

编辑 `.env`，至少填这几项：

```bash
# 台词编剧：火山方舟（豆包），在方舟控制台开通一个便宜快速的模型
CHAT_API_KEY=你的方舟 API Key
CHAT_MODEL=模型名或推理接入点 ID（ep-xxxx）

# H3：通过 SSH 隧道访问 AutoDL
H3_BASE_URL=http://localhost:30000
H3_ASSET_DIR=/root/autodl-tmp/assets
```

## 第二步：租卡、准备环境（用「无卡模式」省钱）

1. AutoDL 控制台 → 租新实例 → 选 RTX 6000D。
   镜像选**基础镜像里的 PyTorch**，Python 3.10~3.12 都行，SGLang 会自己装需要的 torch 版本。
2. **扩容数据盘到 200GB 以上**：只下 Ref2VA 部分也要约 140GB，默认的 50GB 不够。
3. 用「**无卡模式**」开机。装依赖、下载模型都不需要 GPU，无卡模式按很低的价格计费。
4. 把这个仓库的 `gpu/serve.sh` 和 `gpu/autodl.sh` 传到实例的 `/root/autodl-tmp/`。
   用 JupyterLab 的上传按钮最简单；也可以用 scp，端口和地址在控制台的「登录指令」里：
   ```bash
   scp -P <端口> gpu/serve.sh gpu/autodl.sh root@<地址>:/root/autodl-tmp/
   ```
5. 在实例的终端里运行：
   ```bash
   cd /root/autodl-tmp && bash autodl.sh
   ```
   脚本会做这几件事：
   - 检查磁盘空间；
   - 装 ffmpeg 和 SGLang；
   - 通过 hf-mirror 镜像**只下载 Ref2VA 分区**和 8 步加速 LoRA；
   - 生成启动脚本 `start.sh`。

   下载要一段时间。中途断了就重新运行，会断点续传。

## 第三步：上传角色素材

把三个文件传到 `/root/autodl-tmp/assets/`（要求见 [README 第 4 节](README.md#4-准备素材一致性模式)）：

- `anchor.png`：9:16 的定妆照，就是视频画面本身；
- `portrait.png`：正方形的脸部特写；
- `voice.wav`：6~10 秒干净的人声。**只用你有权使用的声音**，不要拿真人的声音去克隆。

角色描述在你电脑上的 `server/videochat/prompt.js` 里，要和定妆照对得上。

## 第四步：有卡开机，启动服务

1. 关机 → 切回正常模式（有卡）开机。
2. 在实例终端运行：
   ```bash
   bash /root/autodl-tmp/start.sh
   tail -f /root/autodl-tmp/logs/serve.log      # 看启动进度
   ```
   第一次启动要加载约 66GB 权重、做 FP8 量化，要等几分钟。服务在后台运行，关掉终端也不会停。

## 第五步：在你的电脑上连接并测试

1. **开 SSH 隧道**。把控制台「登录指令」里的端口和地址填进去，输入密码后这个窗口保持开着：
   ```bash
   ssh -CNg -L 30000:127.0.0.1:30000 -p <端口> root@<地址>
   ```
2. 另开一个终端，在项目目录里依次运行：
   ```bash
   curl http://localhost:30000/v1/models        # 能返回内容说明连上了
   npm run h3 -- say "哈哈，真的假的？快跟我说说！" --emotion surprised   # 先生成一段看看效果
   npm run h3 -- warmup                         # 预热各个时长档（第一次每档会比较慢）
   npm run h3 -- idle                           # 生成待机循环视频
   npm run h3 -- bench --durations 4,6,8 --steps 8 --shifts 12,6   # 测速度、对比参数
   npm run dev                                  # 打开 http://localhost:5173/video.html 开始聊天
   ```
   生成的视频都在项目的 `media/` 目录里。**除了速度，一定要看画面、听声音**，再把满意的参数写进 `.env`。

## 常见问题

- **启动报显存不足（OOM）**：先把 `.env` 里 `H3_SHORT_EDGE` 改成 640 或 480 试试。或者换显存更大的卡，用 `QUANT=none` 启动。
- **下载很慢或失败**：确认 `HF_ENDPOINT=https://hf-mirror.com` 生效了。也可以先运行 `source /etc/network_turbo` 打开 AutoDL 的学术资源加速，再重新跑 `autodl.sh`。
- **看日志**：`tail -f /root/autodl-tmp/logs/serve.log`。
- **停止服务**：`pkill -f "sglang serve"`。
- **换回不用加速 LoRA 的原版**：改 `start.sh` 里的 `LORA=none`，同时把你电脑上 `.env` 的 `H3_STEPS` 改成 30~50。
- **想让手机也能用**：手机访问的是你电脑上的网页，不是 AutoDL。按主 README 的「在手机上测试」配置即可。AutoDL 的端口不要直接暴露到公网。
