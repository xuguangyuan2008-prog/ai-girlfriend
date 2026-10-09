import { isEmotion, isGesture } from '../avatar/types'
import type { Cue } from './types'

/** 从模型输出里抠出 {"emotion","gesture"}，容忍代码块等多余内容 */
export function parseCue(output: string): Cue | null {
  const match = output.match(/\{[\s\S]*?\}/)
  if (!match) return null
  try {
    const parsed = JSON.parse(match[0])
    return {
      emotion: isEmotion(parsed.emotion) ? parsed.emotion : 'neutral',
      gesture: isGesture(parsed.gesture) ? parsed.gesture : 'none',
    }
  } catch {
    return null
  }
}

// 没有可用的标注模型时，用关键词兜底。按顺序匹配，先命中的生效。
const EMOTION_RULES: [RegExp, Cue['emotion']][] = [
  [/害羞|不好意思|人家|讨厌啦|脸红/, 'shy'],
  [/哇|天哪|天啊|真的吗|居然|竟然|不会吧|什么[？?]/, 'surprised'],
  [/生气|气死|哼|过分|讨厌/, 'angry'],
  [/难过|伤心|可惜|遗憾|抱歉|对不起|心疼|唉/, 'sad'],
  [/哈哈|嘻嘻|嘿嘿|开心|高兴|太好了|太棒了|好棒|真棒|喜欢|好耶|你好|嗨|早上好/, 'happy'],
  [/放松|舒服|慢慢来|没关系|别担心/, 'relaxed'],
]

const GESTURE_RULES: [RegExp, Cue['gesture']][] = [
  [/你好|嗨|哈喽|早上好|晚上好|拜拜|再见|晚安|hello|hi\b/i, 'wave'],
  [/好耶|太好了|太棒了|耶[！!]|恭喜/, 'cheer'],
  [/害羞|不好意思|讨厌啦|脸红/, 'shy'],
  [/让我想想|我想想|想一想|好像是|我记得/, 'think'],
  [/不知道|没办法|也许吧|随便|谁知道/, 'shrug'],
  [/^(不是|不对|不要|不行|才不)/, 'shake'],
  [/^(嗯嗯|对呀|对啊|是的|没错|好的|当然|可以呀)/, 'nod'],
  [/[？?]$/, 'tilt'],
]

export function keywordCue(text: string): Cue {
  const t = text.trim()
  return {
    emotion: EMOTION_RULES.find(([re]) => re.test(t))?.[1] ?? 'neutral',
    gesture: GESTURE_RULES.find(([re]) => re.test(t))?.[1] ?? 'none',
  }
}
