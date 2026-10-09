import * as THREE from 'three'
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js'
import { VRMLoaderPlugin, VRMUtils, type VRM, type VRMHumanBoneName } from '@pixiv/three-vrm'
import { GESTURE_DEFS } from './gestures'
import { SILENT, type Visemes } from './LipSync'
import { EMOTIONS, type Emotion, type Euler3, type Gesture, type Mode, type Pose } from './types'

/** 手臂自然下垂的静止姿态（VRM 默认是 T-Pose） */
const REST_POSE: Pose = {
  leftUpperArm: [0, 0, -1.35],
  rightUpperArm: [0, 0, 1.35],
  leftLowerArm: [0, -0.25, 0],
  rightLowerArm: [0, 0.25, 0],
}

const CONTROLLED_BONES: VRMHumanBoneName[] = [
  'spine', 'chest', 'neck', 'head',
  'leftShoulder', 'rightShoulder',
  'leftUpperArm', 'rightUpperArm',
  'leftLowerArm', 'rightLowerArm',
  'leftHand', 'rightHand',
]

const EXPRESSION_NAMES = ['happy', 'angry', 'sad', 'relaxed', 'surprised'] as const

/** 指数平滑：每秒以 rate 的速度逼近目标，与帧率无关 */
const damp = (cur: number, target: number, rate: number, dt: number) =>
  cur + (target - cur) * (1 - Math.exp(-rate * dt))

const smoothstep = (x: number) => {
  const t = Math.min(1, Math.max(0, x))
  return t * t * (3 - 2 * t)
}

interface ActiveGesture {
  name: Gesture
  t: number
}

export class Avatar {
  readonly renderer: THREE.WebGLRenderer
  private scene = new THREE.Scene()
  private camera = new THREE.PerspectiveCamera(28, 1, 0.1, 20)
  private clock = new THREE.Clock()
  private lookTarget = new THREE.Object3D()
  private vrm: VRM | null = null
  private headHeight = 1.4

  // 状态
  private time = 0
  private mode: Mode = 'idle'
  private modeWeights: Record<Mode, number> = { idle: 1, listening: 0, thinking: 0, speaking: 0 }
  private emotion: Emotion = 'neutral'
  private expressionWeights: Record<string, number> = {}
  private gestures: ActiveGesture[] = []
  private visemeSource: ((dt: number) => Visemes) | null = null
  private visemes: Visemes = { ...SILENT }

  // 眨眼 / 视线
  private nextBlink = 2
  private blinkT = -1
  private nextSaccade = 1
  private saccade = new THREE.Vector2()

  constructor(private container: HTMLElement) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true })
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
    this.renderer.outputColorSpace = THREE.SRGBColorSpace
    container.appendChild(this.renderer.domElement)

    const key = new THREE.DirectionalLight(0xffffff, 2.2)
    key.position.set(0.6, 1.5, 2)
    const fill = new THREE.DirectionalLight(0xffe8f0, 0.8)
    fill.position.set(-1.5, 1, 1)
    this.scene.add(key, fill, new THREE.AmbientLight(0xffffff, 0.6), this.lookTarget)

    new ResizeObserver(() => this.resize()).observe(container)
    this.resize()
    this.renderer.setAnimationLoop(() => this.tick())
  }

  async load(url: string) {
    const loader = new GLTFLoader()
    loader.register((parser) => new VRMLoaderPlugin(parser))
    const gltf = await loader.loadAsync(url)
    const vrm = gltf.userData.vrm as VRM | undefined
    if (!vrm) throw new Error('不是有效的 VRM 文件')

    VRMUtils.removeUnnecessaryVertices(gltf.scene)
    VRMUtils.combineSkeletons(gltf.scene)
    VRMUtils.rotateVRM0(vrm) // VRM0.x 模型面朝 -Z，转过来
    vrm.scene.traverse((o) => (o.frustumCulled = false))

    if (this.vrm) {
      this.scene.remove(this.vrm.scene)
      VRMUtils.deepDispose(this.vrm.scene)
    }
    this.vrm = vrm
    this.scene.add(vrm.scene)
    if (vrm.lookAt) vrm.lookAt.target = this.lookTarget

    this.applyPose(REST_POSE)
    vrm.update(0)
    const head = vrm.humanoid.getNormalizedBoneNode('head')
    this.headHeight = head ? head.getWorldPosition(new THREE.Vector3()).y : 1.4
    this.resize()
  }

  setEmotion(emotion: Emotion) {
    this.emotion = emotion
  }

  playGesture(name: Gesture) {
    // 同名手势不叠加，重新开始
    this.gestures = this.gestures.filter((g) => g.name !== name)
    this.gestures.push({ name, t: 0 })
  }

  setMode(mode: Mode) {
    this.mode = mode
  }

  /** 每帧调用 source 获取口型，传 null 停止 */
  setVisemeSource(source: ((dt: number) => Visemes) | null) {
    this.visemeSource = source
  }

  private resize() {
    const w = this.container.clientWidth || 1
    const h = this.container.clientHeight || 1
    this.renderer.setSize(w, h, false)
    this.camera.aspect = w / h

    // 半身取景：头顶到腰部，宽度至少容纳挥手
    const frameHeight = 0.85
    const frameWidth = 0.95
    const tanHalf = Math.tan(THREE.MathUtils.degToRad(this.camera.fov / 2))
    const dist = Math.max(frameHeight / 2 / tanHalf, frameWidth / 2 / (tanHalf * this.camera.aspect))
    const centerY = this.headHeight - 0.17
    this.camera.position.set(0, centerY + 0.04, dist)
    this.camera.lookAt(0, centerY, 0)
    this.camera.updateProjectionMatrix()
  }

  private tick() {
    const dt = Math.min(this.clock.getDelta(), 0.1)
    this.time += dt
    if (this.vrm) this.update(dt)
    this.renderer.render(this.scene, this.camera)
  }

  private update(dt: number) {
    const vrm = this.vrm!
    const t = this.time

    for (const m of Object.keys(this.modeWeights) as Mode[]) {
      this.modeWeights[m] = damp(this.modeWeights[m], m === this.mode ? 1 : 0, 4, dt)
    }
    const { listening, thinking, speaking } = this.modeWeights

    // 口型
    const target = this.visemeSource ? this.visemeSource(dt) : SILENT
    for (const k of Object.keys(this.visemes) as (keyof Visemes)[]) {
      this.visemes[k] = damp(this.visemes[k], target[k], 25, dt)
    }
    const talk = this.visemes.aa + this.visemes.oh + this.visemes.ee

    // ---- 身体：静止姿态 + 待机呼吸摆动 + 状态姿态 + 手势 ----
    const pose: Pose = {}
    const add = (bone: VRMHumanBoneName, e: Euler3, w = 1) => {
      const cur = (pose[bone] ??= [0, 0, 0])
      cur[0] += e[0] * w
      cur[1] += e[1] * w
      cur[2] += e[2] * w
    }
    for (const [bone, e] of Object.entries(REST_POSE)) add(bone as VRMHumanBoneName, e)

    const breath = Math.sin(t * ((Math.PI * 2) / 4.2))
    add('spine', [breath * 0.015, Math.sin(t * 0.31) * 0.02, Math.sin(t * 0.43) * 0.012])
    add('chest', [breath * 0.012, 0, 0])
    add('leftUpperArm', [0, 0, -breath * 0.02])
    add('rightUpperArm', [0, 0, breath * 0.02])
    add('neck', [0, Math.sin(t * 0.53) * 0.03, Math.sin(t * 0.37) * 0.025])
    add('head', [Math.sin(t * 0.71) * 0.02, Math.sin(t * 0.29) * 0.04, Math.sin(t * 0.47) * 0.03])

    // 倾听：身体微微前倾、歪头
    add('spine', [0.05, 0, 0], listening)
    add('head', [0.03, 0, 0.07], listening)
    // 思考：抬头看向一侧
    add('head', [-0.08, 0.06, -0.08], thinking)
    // 说话：头随着音量轻微点动
    add('head', [talk * 0.05 + Math.sin(t * 3.1) * 0.015, Math.sin(t * 1.3) * 0.03, 0], speaking)

    this.gestures = this.gestures.filter((g) => {
      const def = GESTURE_DEFS[g.name]
      g.t += dt
      const p = g.t / def.duration
      if (p >= 1) return false
      const env = smoothstep(p / 0.18) * smoothstep((1 - p) / 0.25)
      for (const [bone, e] of Object.entries(def.pose(p, g.t))) add(bone as VRMHumanBoneName, e, env)
      return true
    })

    this.applyPose(pose)

    // ---- 表情 ----
    const targetWeights: Record<string, number> = EMOTIONS[this.emotion]
    for (const name of EXPRESSION_NAMES) {
      const w = damp(this.expressionWeights[name] ?? 0, targetWeights[name as keyof typeof targetWeights] ?? 0, 6, dt)
      this.expressionWeights[name] = w
      vrm.expressionManager?.setValue(name, w)
    }
    // 开心时嘴型收一点，避免和笑脸冲突
    const mouthScale = 1 - (this.expressionWeights.happy ?? 0) * 0.4
    for (const k of Object.keys(this.visemes) as (keyof Visemes)[]) {
      vrm.expressionManager?.setValue(k, this.visemes[k] * mouthScale)
    }

    // 眨眼
    this.nextBlink -= dt
    if (this.nextBlink <= 0 && this.blinkT < 0) {
      this.blinkT = 0
      this.nextBlink = 2 + Math.random() * 4
      if (Math.random() < 0.15) this.nextBlink = 0.25 // 偶尔连眨两下
    }
    let blink = 0
    if (this.blinkT >= 0) {
      this.blinkT += dt
      const d = 0.16
      blink = this.blinkT < d / 2 ? this.blinkT / (d / 2) : 1 - (this.blinkT - d / 2) / (d / 2)
      if (this.blinkT >= d) this.blinkT = -1
    }
    // 笑眯眯的时候本来就闭着眼，减弱眨眼
    vrm.expressionManager?.setValue('blink', Math.max(0, blink) * (1 - (this.expressionWeights.happy ?? 0)))

    // 视线：盯着镜头 + 随机微小跳动；思考时往上看
    this.nextSaccade -= dt
    if (this.nextSaccade <= 0) {
      this.nextSaccade = 0.8 + Math.random() * 2.5
      this.saccade.set((Math.random() - 0.5) * 0.12, (Math.random() - 0.5) * 0.08)
    }
    this.lookTarget.position.set(
      this.camera.position.x + this.saccade.x + thinking * 0.4,
      this.camera.position.y + this.saccade.y + thinking * 0.35,
      this.camera.position.z,
    )

    vrm.update(dt)
  }

  private applyPose(pose: Pose) {
    const humanoid = this.vrm?.humanoid
    if (!humanoid) return
    for (const bone of CONTROLLED_BONES) {
      const node = humanoid.getNormalizedBoneNode(bone)
      const e = pose[bone] ?? [0, 0, 0]
      node?.rotation.set(e[0], e[1], e[2])
    }
  }
}
