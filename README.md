# AI Girlfriend：Web 实时语音虚拟角色

浏览器里运行的半身 3D 虚拟角色，可以和她实时语音聊天。她会根据说话内容变换表情、做简单手势，嘴型跟着声音同步。

- **实时语音**：支持 **OpenAI Realtime**（WebRTC）和**豆包端到端实时语音大模型**（WebSocket），低延迟，随时可以插话打断
- **角色渲染**：three.js + [@pixiv/three-vrm](https://github.com/pixiv/three-vrm)，支持任意 VRM 模型（可以用 VRoid Studio 免费捏人）
- **表情**：happy / sad / angry / surprised / relaxed / shy，平滑过渡
- **手势**：挥手、点头、摇头、歪头、耸肩、思考、害羞、欢呼，全部程序化生成，不需要动画文件
- **活人感**：呼吸、自动眨眼、视线微动、倾听时前倾、思考时抬眼
- **口型同步**：按音量和频谱实时驱动 a/i/u/e/o 口型

## 两种模式

| | 实时通话（`/`） | 视频聊天（`/video.html`） |
|---|---|---|
| 交互 | 打电话，即说即回，可以打断 | 发消息，她回一段视频 |
| 形象 | 3D 角色（VRM），表情/手势/口型实时驱动 | **真人视频**：MiniMax H3 生成，声音、口型、表情一次生成，天然一致 |
| 延迟 | 1 秒内 | 取决于 GPU，几秒到几十秒 |
| 依赖 | OpenAI / 豆包实时语音 | 文本模型 + 租用 GPU 跑 H3，见 [gpu/README.md](gpu/README.md) |

视频聊天本地调试不需要 GPU：不填 `H3_BASE_URL` 时走调试模式，只显示字幕。

## 快速开始

```bash
npm install
cp .env.example .env   # 填入 OpenAI 或豆包的密钥（至少一个）
npm run dev            # 打开 http://localhost:5173
```

点击「开始聊天」并允许麦克风，然后直接说话。两家都配置了的话，按钮左边会出现下拉框可以切换。右下角 🎭 按钮可以手动测试表情和手势，不连 API 也能用。

部署到生产环境：

```bash
npm run build
npm start              # 默认端口 3000，可用 PORT 修改
```

> 浏览器只有在 HTTPS 或 localhost 下才允许使用麦克风，部署时记得配置 HTTPS。

## 在手机上测试

手机通过 `http://电脑IP` 访问时浏览器会禁用麦克风，所以需要 HTTPS。三种方式任选其一：

**方式一：局域网 HTTPS（最快）**——手机和电脑连同一个 Wi-Fi

```bash
npm run dev:phone      # 终端里会打印 Network: https://192.168.x.x:5173
```

手机浏览器打开这个地址，会提示「证书不受信任」（自签名证书，正常现象）：
- Android Chrome：点「高级」→「继续前往」
- iPhone Safari：点「显示详细信息」→「访问此网站」

**方式二：内网穿透（不用同一 Wi-Fi，没有证书警告）**

```bash
npm run dev
npx cloudflared tunnel --url http://localhost:5173   # 打印 https://xxx.trycloudflare.com
```

**方式三：部署上线**——Render、Railway、Fly.io 等平台都会自动配 HTTPS。构建命令 `npm install && npm run build`，启动命令 `npm start`，环境变量里填 `.env.example` 中的密钥。

注意：
- 用 OpenAI 时是**手机浏览器直接连 OpenAI**（WebRTC），手机所在的网络必须能访问 `api.openai.com`，OpenAI 不支持的地区连不上；用豆包时手机只连你的服务器，由服务器转发
- 外放时如果角色被自己的声音打断，戴耳机效果最好
- 第一次加载要下载约 10MB 的模型

## 工作原理

两家服务的接入方式完全不同，都被翻译成同一套事件（`src/voice/types.ts`），表情导演和界面不关心底层是谁。

```
OpenAI：
  浏览器 ──► 你的服务器 POST /api/session ──► 用 API Key 换短时效 client secret
  浏览器 ◄══ WebRTC 音频 + DataChannel 事件 ══► OpenAI Realtime（直连）

豆包：
  浏览器 ◄══ WebSocket /api/doubao ══► 你的服务器 ◄══ 二进制协议 ══► 豆包实时语音
         16kHz PCM 上行 / 24kHz PCM 下行      （鉴权头只能由服务端添加）

统一事件 ──► 表情导演 ──► 表情 / 手势 / 倾听·思考·说话姿态
角色声音 ──► AnalyserNode ──► 口型
```

**表情怎么来的？** 语音模式下模型说的每个字都会被念出来，不能让它在台词里写 `[happy]`。所以每句台词另外请求一次标注 `{emotion, gesture}`：

| | OpenAI | 豆包 |
|---|---|---|
| 怎么标注 | 同一会话里的「带外响应」（`conversation: "none"`），并行运行、不写入对话历史 | 服务端 `/api/emotion` 调方舟等文本模型；没配置则用关键词规则 |
| 什么时候触发 | 按字数估算每句话的开口时间 | 豆包推送每句话开始合成的事件，音频队列在我们手里，**能精确算出开口时刻** |

## 目录

```
server/
  character.js        人设、声音（改这里换角色）
  videochat/          视频聊天：台词编剧、H3 客户端、场景与提示词、SSE 接口
  api.js              /api/config、/api/session、/api/emotion
  openai.js           创建 OpenAI Realtime 会话（模型、VAD、转写等配置）
  doubao.js           豆包二进制协议编解码 + WebSocket 中转
  emotion.js          文本模型标注表情
  index.js            生产环境服务器
shared/
  cues.js             表情 / 手势名单和导演提示词（前后端共用）
gpu/                  H3 的 GPU 部署脚本和提速说明
scripts/h3.js         H3 命令行：预热、生成待机视频、单条测试、压测
src/
  main.ts             界面与各模块组装
  video/              视频聊天页面
  avatar/
    Avatar.ts         three.js 场景、VRM 加载、姿态/表情/眨眼/视线
    gestures.ts       程序化手势定义
    LipSync.ts        音频 → 口型
    types.ts          表情权重、类型
  voice/
    types.ts          统一的语音会话接口和事件
    OpenAIVoice.ts    OpenAI（WebRTC）
    DoubaoVoice.ts    豆包（经服务端中转）
    pcm.ts            麦克风采集降采样、PCM 排队播放
    cues.ts           解析标注结果、关键词兜底规则
  director/
    EmotionDirector.ts 台词 → 表情/手势 的导演
public/models/avatar.vrm  默认模型
```

## 自定义

| 想改什么 | 怎么改 |
|---|---|
| 人设 / 说话风格 | `server/character.js` 的 `instructions`（豆包另有 `speakingStyle`） |
| 声音 | `.env` 里的 `OPENAI_VOICE` 或 `DOUBAO_SPEAKER` |
| 模型 | `.env` 里的 `OPENAI_REALTIME_MODEL` 或 `DOUBAO_MODEL` |
| 默认语音服务 | `.env` 里的 `VOICE_PROVIDER` |
| 角色形象 | 替换 `public/models/avatar.vrm`，设置 `VITE_VRM_URL`，或者直接把 .vrm 拖进页面 |
| 加手势 | 在 `shared/cues.js` 的 `GESTURES` 加名字（导演提示词会自动带上），再到 `src/avatar/gestures.ts` 实现动作 |
| 接入别的语音服务 | 实现 `src/voice/types.ts` 的 `VoiceSession` 接口，在 `main.ts` 的 `PROVIDERS` 里注册 |
| 表情强度 | `src/avatar/types.ts` 的 `EMOTIONS` |

## 已知限制 / 后续可以做

- OpenAI 的表情时间点是按字数估算的（中文约 0.22 秒/字），长回复后半段可能有些偏差
- 豆包的协议实现依据官方 WebSocket 二进制协议编写，并用模拟服务器做了端到端测试，但尚未连真实账号验证；如果你的账号只开通了新版双工接口（Seeduplex），需要改用对应协议
- 豆包模式下音频由网页自己播放，部分桌面浏览器的回声消除可能不如 WebRTC，外放出现自己打断自己时请戴耳机
- 手势是程序化的，比较简单；想要更自然可以导入 VRMA / Mixamo 动画
- 没有长期记忆，每次连接都是新对话；可以在服务端存储对话摘要，下次放进 instructions
- 口型基于频谱的粗略估计，不是真正的音素对齐

## 模型版权

默认模型 `public/models/avatar.vrm` 为 pixiv Inc. 的 *VRM1_Constraint_Twist_Sample*（来自 three-vrm 示例），依据 [VRM Public License 1.0](https://vrm.dev/licenses/1.0/) 允许再分发与商用。
