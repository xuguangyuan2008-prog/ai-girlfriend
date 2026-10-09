import { character } from '../character.js'
import { videoConfig } from './config.js'

/**
 * 固定场景的描述。
 * - fast 模式没有参考图和声音样本，长相、场景、声音全靠这几段文字，所以要写得具体，而且每次一字不差。
 *   细节越具体（发型、衣服颜色、饰品、房间里的摆设、声音特点），不同片段之间越像同一个人、同一个房间。
 * - ref 模式下首尾帧钉在定妆照上，这里的描述要和定妆照一致。
 */
export const scene = {
  look:
    '一位二十四岁的中国女生，鹅蛋脸，皮肤白皙，黑色及肩长发、空气刘海，' +
    '杏仁眼、双眼皮，淡妆，戴一对小巧的银色耳钉，穿米白色圆领针织衫',
  place: '她的卧室，暖黄色台灯在画面左侧，背后是浅木色书架和一盆绿萝，背景略微虚化，夜晚',
  camera: '竖屏手机前置摄像头自拍视角，手机固定不动，胸口以上的近景，人物居中，真实质感，不是动画',
  voice: '二十出头女生的声音，音色清亮偏甜，语速自然，温柔里带一点俏皮，标准普通话',
}

/** 表情 / 动作的可选值，由台词编剧挑选，写进视频提示词 */
export const EMOTIONS = {
  neutral: '表情自然放松',
  happy: '开心地笑，眼睛弯弯的',
  laugh: '忍不住笑出声',
  shy: '有点害羞，眼神躲闪，抿嘴笑',
  surprised: '惊讶地睁大眼睛，眉毛上扬',
  sad: '有点难过，眉头微皱，声音放轻',
  tender: '温柔地看着镜头，眼神关切',
  playful: '俏皮地歪头，带点坏笑',
  thinking: '想了想，眼睛往上看了一下',
  pouty: '假装生气地嘟嘴',
}

/**
 * 台词编剧的系统提示词：在角色人设之外，加上「这是视频消息」的约束。
 * 输出 JSON，台词要短（视频最长 15 秒，越短生成越快）。
 */
export function writerSystemPrompt() {
  return `${character.instructions}

现在的场景：你在用手机前置摄像头给对方录一段视频消息来回复。你说的话会被拍成一段几秒钟的视频。

输出要求：只输出一行 JSON，不要任何其它内容：
{"line":"你要说的话","emotion":"表情","action":"一个简短的动作描写，可以为空"}

- line：口语化的一句或两句，不超过 40 个字，越短越好（越短对方等得越少）。不要表情符号，不要括号。
- emotion：从这些里选一个：${Object.keys(EMOTIONS).join(', ')}
- action：可选，比如「托着下巴」「挥挥手」「凑近镜头」，只写和说话相关的小动作，不要大幅度离开画面。`
}

/**
 * 拼出给 H3 的提示词。
 * ref 模式里参考素材按条件顺序编号：<Picture 1> 是角色参考图，<Audio 1> 是声音样本（见 h3.js 的 conditions 顺序）。
 */
export function h3Prompt({ line, emotion, action }) {
  const face = EMOTIONS[emotion] ?? EMOTIONS.neutral
  const act = action ? `，${action}` : ''
  const ref = videoConfig.mode === 'ref'
  return [
    `${scene.camera}。${scene.place}。`,
    ref ? `<Picture 1> 中的女生（${scene.look}）` : `${scene.look}。她`,
    `看着镜头，${face}${act}，`,
    ref ? `用 <Audio 1> 里的声音（${scene.voice}）` : `用${scene.voice}`,
    `说：“${line}”`,
    `说完后恢复自然放松的表情，继续看着镜头。只有她一个人说话，没有背景音乐。`,
  ].join('')
}

/** 等待时循环播放的待机视频的提示词（用 npm run h3 -- idle 生成） */
export function idlePrompt() {
  const who = videoConfig.mode === 'ref' ? `<Picture 1> 中的女生（${scene.look}）` : `${scene.look}。她`
  return (
    `${scene.camera}。${scene.place}。${who}` +
    `安静地看着镜头，轻轻呼吸，偶尔眨眼，嘴角带着淡淡的微笑，像在认真听对方说话，没有说话。` +
    `环境很安静，没有背景音乐。`
  )
}
