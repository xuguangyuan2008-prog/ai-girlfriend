import type { VRMHumanBoneName } from '@pixiv/three-vrm'

/** 情绪 → VRM 表情权重。VRM 预设表情：happy angry sad relaxed surprised */
export const EMOTIONS = {
  neutral: {},
  happy: { happy: 0.75 },
  sad: { sad: 0.7 },
  angry: { angry: 0.6 },
  surprised: { surprised: 0.7 },
  relaxed: { relaxed: 0.6 },
  shy: { happy: 0.35, relaxed: 0.3 },
} satisfies Record<string, Record<string, number>>

export type Emotion = keyof typeof EMOTIONS

export const GESTURES = ['nod', 'shake', 'tilt', 'wave', 'shrug', 'think', 'shy', 'cheer'] as const
export type Gesture = (typeof GESTURES)[number]

/** 说话时角色所处的状态，用来叠加不同的待机姿态 */
export type Mode = 'idle' | 'listening' | 'thinking' | 'speaking'

/** 骨骼欧拉角 [x, y, z]，弧度；作用在 three-vrm 的 normalized 骨骼上 */
export type Euler3 = [number, number, number]
export type Pose = Partial<Record<VRMHumanBoneName, Euler3>>

export const isEmotion = (v: unknown): v is Emotion => typeof v === 'string' && v in EMOTIONS
export const isGesture = (v: unknown): v is Gesture => GESTURES.includes(v as Gesture)
