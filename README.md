# AI Girlfriend：Web 实时语音虚拟角色

浏览器里运行的半身 3D 虚拟角色，可以和她实时语音聊天。她会根据说话内容变换表情、做简单手势，嘴型跟着声音同步。

- **实时语音**：OpenAI Realtime API（WebRTC），低延迟，随时可以插话打断
- **角色渲染**：three.js + [@pixiv/three-vrm](https://github.com/pixiv/three-vrm)，支持任意 VRM 模型（可以用 VRoid Studio 免费捏人）
- **表情**：happy / sad / angry / surprised / relaxed / shy，平滑过渡
- **手势**：挥手、点头、摇头、歪头、耸肩、思考、害羞、欢呼，全部程序化生成，不需要动画文件
- **活人感**：呼吸、自动眨眼、视线微动、倾听时前倾、思考时抬眼
- **口型同步**：按音量和频谱实时驱动 a/i/u/e/o 口型

## 快速开始

```bash
npm install
cp .env.example .env   # 填入 OPENAI_API_KEY
npm run dev            # 打开 http://localhost:5173
```

点击「开始聊天」并允许麦克风，然后直接说话。右下角 🎭 按钮可以手动测试表情和手势，不连 API 也能用。

部署到生产环境：

```bash
npm run build
npm start              # 默认端口 3000，可用 PORT 修改
```

> 浏览器只有在 HTTPS 或 localhost 下才允许使用麦克风，部署时记得配置 HTTPS。

## 工作原理

```
           ┌──────── 你的服务器 ────────┐
浏览器 ──► │ POST /api/session          │ ──► OpenAI：用 API Key 换短时效 client secret
           └────────────────────────────┘
浏览器 ◄══ WebRTC 音频 + DataChannel 事件 ══► OpenAI Realtime（gpt-realtime-2.1）
   │
   ├─ 远端音频 ──► <audio> 播放
   │           └─► AnalyserNode ──► 口型
   ├─ speech_started / stopped ──► 倾听 / 思考姿态
   └─ 角色台词文字流 ──► 按句切分 ──► 带外响应（conversation: "none"）
                                      让模型给每句标注 {emotion, gesture}
                                      ──► 按估算的朗读时间点触发表情和手势
```

**为什么用「带外响应」标注表情，而不是让模型在台词里写 `[happy]`？**
语音模式下模型说出的每个字都会被念出来，标签也不例外。带外响应和主对话并行运行，不写入对话历史，也不会拖慢回复。

## 目录

```
server/
  character.js        人设、声音（改这里换角色）
  session.js          创建 Realtime 会话（模型、VAD、转写等配置）
  index.js            生产环境服务器
src/
  main.ts             界面与各模块组装
  avatar/
    Avatar.ts         three.js 场景、VRM 加载、姿态/表情/眨眼/视线
    gestures.ts       程序化手势定义
    LipSync.ts        音频 → 口型
    types.ts          情绪、手势列表
  realtime/
    RealtimeClient.ts WebRTC 连接
    EmotionDirector.ts 台词 → 表情/手势 的导演
public/models/avatar.vrm  默认模型
```

## 自定义

| 想改什么 | 怎么改 |
|---|---|
| 人设 / 说话风格 | `server/character.js` 的 `instructions` |
| 声音 | `.env` 里的 `OPENAI_VOICE`（marin、cedar、coral、shimmer…） |
| 模型 | `.env` 里的 `OPENAI_REALTIME_MODEL`，想更快更便宜可以用 `gpt-realtime-2.1-mini` |
| 角色形象 | 替换 `public/models/avatar.vrm`，设置 `VITE_VRM_URL`，或者直接把 .vrm 拖进页面 |
| 加手势 | 在 `src/avatar/gestures.ts` 加定义，在 `types.ts` 的 `GESTURES` 里加名字，导演提示词会自动带上 |
| 表情强度 | `src/avatar/types.ts` 的 `EMOTIONS` |

## 已知限制 / 后续可以做

- 表情时间点是按字数估算的（中文约 0.22 秒/字），长回复后半段可能有些偏差
- 手势是程序化的，比较简单；想要更自然可以导入 VRMA / Mixamo 动画
- 没有长期记忆，每次连接都是新对话；可以在服务端存储对话摘要，下次放进 instructions
- 口型基于频谱的粗略估计，不是真正的音素对齐

## 模型版权

默认模型 `public/models/avatar.vrm` 为 pixiv Inc. 的 *VRM1_Constraint_Twist_Sample*（来自 three-vrm 示例），依据 [VRM Public License 1.0](https://vrm.dev/licenses/1.0/) 允许再分发与商用。
