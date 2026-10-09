import type { Gesture, Pose } from './types'

/**
 * 程序化手势：不需要动画文件，直接对骨骼叠加旋转。
 * pose(p, t) 返回相对静止姿态的偏移量，p 是 0~1 的进度，t 是已播放秒数。
 * 淡入淡出由 Avatar 统一处理。
 *
 * 坐标约定（normalized 骨骼，角色面朝 +Z / 镜头）：
 * - head.x 正 = 低头，负 = 抬头；head.y = 左右转头；head.z = 歪头
 * - 左臂沿 +X，upperArm.z 正 = 抬起；右臂沿 -X，符号相反
 * - 手臂下垂时 upperArm.x 负 = 向前摆；lowerArm.y（左负右正）= 屈肘向前
 */
interface GestureDef {
  duration: number
  pose: (p: number, t: number) => Pose
}

const TAU = Math.PI * 2

export const GESTURE_DEFS: Record<Gesture, GestureDef> = {
  nod: {
    duration: 1.1,
    pose: (p) => {
      const a = Math.sin(p * TAU * 2) * 0.14 * (1 - p * 0.5)
      return { head: [Math.max(a, -0.03), 0, 0], neck: [a * 0.4, 0, 0] }
    },
  },

  shake: {
    duration: 1.3,
    pose: (p) => {
      const a = Math.sin(p * TAU * 2) * 0.2 * (1 - p * 0.4)
      return { head: [0.03, a, 0], neck: [0, a * 0.4, 0] }
    },
  },

  tilt: {
    duration: 2.0,
    pose: () => ({ head: [-0.03, 0.05, 0.2], neck: [0, 0, 0.07] }),
  },

  wave: {
    duration: 2.4,
    pose: (_p, t) => {
      const w = Math.sin(t * TAU * 2.2)
      return {
        rightUpperArm: [0, 0.35, -1.05],
        rightLowerArm: [0, 0.3, -1.75 + w * 0.22],
        rightHand: [0, 0, w * 0.15],
        head: [0, -0.06, -0.06],
        spine: [0, 0, 0.03],
      }
    },
  },

  shrug: {
    duration: 1.8,
    pose: () => ({
      leftShoulder: [0, 0, 0.18],
      rightShoulder: [0, 0, -0.18],
      leftUpperArm: [0, -0.1, 0.25],
      rightUpperArm: [0, 0.1, -0.25],
      leftLowerArm: [0, -1.0, 0],
      rightLowerArm: [0, 1.0, 0],
      head: [-0.04, 0, 0.12],
    }),
  },

  think: {
    duration: 2.6,
    pose: (_p, t) => ({
      head: [-0.12, 0.1, -0.1 + Math.sin(t * 1.5) * 0.02],
      neck: [-0.04, 0.03, 0],
      spine: [-0.03, 0, 0],
    }),
  },

  shy: {
    duration: 2.4,
    pose: () => ({
      head: [0.17, 0.2, 0.08],
      neck: [0.06, 0.06, 0],
      spine: [0.04, 0, -0.02],
      leftShoulder: [0, 0, 0.08],
      rightShoulder: [0, 0, -0.08],
      leftUpperArm: [-0.15, 0, -0.08],
      rightUpperArm: [-0.15, 0, 0.08],
      leftLowerArm: [0, -0.5, 0],
      rightLowerArm: [0, 0.5, 0],
    }),
  },

  cheer: {
    duration: 1.6,
    pose: (_p, t) => {
      const b = Math.abs(Math.sin(t * TAU * 1.8))
      return {
        leftUpperArm: [-0.35, 0, 0.15 + b * 0.1],
        rightUpperArm: [-0.35, 0, -0.15 - b * 0.1],
        leftLowerArm: [0, -1.9, 0],
        rightLowerArm: [0, 1.9, 0],
        spine: [-0.03 + b * 0.04, 0, 0],
        head: [-0.06, 0, 0],
      }
    },
  },
}
