import './style.css'
import { Avatar } from './avatar/Avatar'
import { LipSync } from './avatar/LipSync'
import { EMOTIONS, GESTURES, type Emotion } from './avatar/types'
import { EmotionDirector } from './director/EmotionDirector'
import { DoubaoVoice } from './voice/DoubaoVoice'
import { OpenAIVoice } from './voice/OpenAIVoice'
import type { VoiceSession } from './voice/types'

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T

const ui = {
  stage: $('stage'),
  dot: $('dot'),
  charName: $('charName'),
  status: $('status'),
  log: $<HTMLUListElement>('log'),
  provider: $<HTMLSelectElement>('provider'),
  connect: $<HTMLButtonElement>('connect'),
  mute: $<HTMLButtonElement>('mute'),
  textForm: $<HTMLFormElement>('textForm'),
  textInput: $<HTMLInputElement>('textInput'),
  debugToggle: $<HTMLButtonElement>('debugToggle'),
  debug: $('debug'),
  emotionButtons: $('emotionButtons'),
  gestureButtons: $('gestureButtons'),
  cue: $('cue'),
  drop: $('drop'),
}

const setStatus = (text: string) => (ui.status.textContent = text)

// ---------- 角色 ----------
const avatar = new Avatar(ui.stage)
if (import.meta.env.DEV) Object.assign(window, { avatar })
const MODEL_URL = import.meta.env.VITE_VRM_URL || '/models/avatar.vrm'
avatar.load(MODEL_URL).catch((err) => {
  console.error(err)
  setStatus(`模型加载失败：${err.message}。可以把 .vrm 文件拖进页面`)
})

// ---------- 语音服务 ----------
const PROVIDERS: Record<string, { label: string; create: () => VoiceSession }> = {
  openai: { label: 'OpenAI', create: () => new OpenAIVoice() },
  doubao: { label: '豆包', create: () => new DoubaoVoice() },
}

fetch('/api/config')
  .then((r) => r.json())
  .then((config: { characterName: string; providers: string[]; defaultProvider: string | null }) => {
    ui.charName.textContent = config.characterName
    if (!config.providers.length) {
      setStatus('服务端还没有配置任何语音服务，请参考 README 填写 .env')
      ui.connect.disabled = true
      return
    }
    for (const id of config.providers) ui.provider.add(new Option(PROVIDERS[id]?.label ?? id, id))
    ui.provider.value = config.defaultProvider ?? config.providers[0]
    showProviderPicker = config.providers.length > 1
    ui.provider.hidden = !showProviderPicker
  })
  .catch(() => setStatus('无法连接服务器'))

// ---------- 实时对话 ----------
/** 配置了多个语音服务时，未连接状态下显示下拉框供选择 */
let showProviderPicker = false
let voice: VoiceSession | null = null
let micOn = true
let audioCtx: AudioContext | null = null

ui.connect.onclick = async () => {
  if (voice) return hangUp()
  ui.connect.disabled = true
  ui.provider.hidden = true
  setStatus('连接中…')
  // AudioContext 必须在用户点击时创建，否则浏览器会静音
  audioCtx ??= new AudioContext()
  await audioCtx.resume()

  const session = PROVIDERS[ui.provider.value].create()
  voice = session
  wire(session)
  try {
    await session.connect(audioCtx)
    if (session.voiceNode) {
      const lipSync = new LipSync(audioCtx, session.voiceNode)
      avatar.setVisemeSource((dt) => lipSync.update(dt))
    }
    ui.dot.classList.add('live')
    ui.connect.textContent = '挂断'
    ui.mute.disabled = ui.textInput.disabled = false
    setStatus(`已连接 · ${session.model} · 直接说话就行，随时可以打断她`)
  } catch (err) {
    console.error(err)
    hangUp()
    setStatus(`连接失败：${(err as Error).message}`)
  } finally {
    ui.connect.disabled = false
  }
}

function hangUp() {
  voice?.disconnect()
  voice = null
  avatar.setVisemeSource(null)
  avatar.setMode('idle')
  micOn = true
  ui.dot.classList.remove('live')
  ui.connect.textContent = '开始聊天'
  ui.provider.hidden = !showProviderPicker
  ui.mute.disabled = ui.textInput.disabled = true
  ui.mute.classList.remove('off')
  setStatus('已挂断')
}

ui.mute.onclick = () => {
  micOn = !micOn
  voice?.setMicEnabled(micOn)
  ui.mute.classList.toggle('off', !micOn)
}

ui.textForm.onsubmit = (e) => {
  e.preventDefault()
  const text = ui.textInput.value.trim()
  if (!text || !voice) return
  voice.sendText(text)
  addLog('user', text)
  ui.textInput.value = ''
}

/** 每次连接都是新的会话对象，在这里挂上导演、字幕和错误处理 */
function wire(session: VoiceSession) {
  const director = new EmotionDirector(session, avatar)
  director.onCue = (cue) => {
    ui.cue.textContent = `${cue.emotion} / ${cue.gesture}\n「${cue.text}」`
  }

  session.on('disconnected', () => voice === session && hangUp())
  session.on('error', (e) => setStatus(`出错了：${e.message}`))

  const assistantLines = new Map<string, HTMLLIElement>()
  session.on('assistant.text_delta', (e) => {
    let li = assistantLines.get(e.id)
    if (!li) {
      li = addLog('assistant', '')
      assistantLines.set(e.id, li)
    }
    li.textContent += e.delta
  })
  session.on('user.transcript', (e) => addLog('user', e.text))
}

// ---------- 字幕 ----------
const MAX_LOG = 4
function addLog(role: 'user' | 'assistant', text: string) {
  const li = document.createElement('li')
  li.className = role
  li.textContent = text
  ui.log.append(li)
  while (ui.log.children.length > MAX_LOG) ui.log.firstElementChild!.remove()
  ;[...ui.log.children].forEach((el, i, all) => {
    ;(el as HTMLElement).style.opacity = String(0.4 + (0.6 * (i + 1)) / all.length)
  })
  return li
}

// ---------- 调试面板 ----------
ui.debugToggle.onclick = () => (ui.debug.hidden = !ui.debug.hidden)
for (const emotion of Object.keys(EMOTIONS) as Emotion[]) {
  const b = document.createElement('button')
  b.textContent = emotion
  b.onclick = () => avatar.setEmotion(emotion)
  ui.emotionButtons.append(b)
}
for (const gesture of GESTURES) {
  const b = document.createElement('button')
  b.textContent = gesture
  b.onclick = () => avatar.playGesture(gesture)
  ui.gestureButtons.append(b)
}

// ---------- 拖拽换模型 ----------
let dragDepth = 0
window.addEventListener('dragenter', (e) => {
  e.preventDefault()
  dragDepth++
  ui.drop.hidden = false
})
window.addEventListener('dragleave', () => {
  if (--dragDepth <= 0) ui.drop.hidden = true
})
window.addEventListener('dragover', (e) => e.preventDefault())
window.addEventListener('drop', async (e) => {
  e.preventDefault()
  dragDepth = 0
  ui.drop.hidden = true
  const file = e.dataTransfer?.files[0]
  if (!file?.name.toLowerCase().endsWith('.vrm')) return setStatus('请拖入 .vrm 文件')
  const url = URL.createObjectURL(file)
  try {
    await avatar.load(url)
    setStatus(`已加载 ${file.name}`)
  } catch (err) {
    setStatus(`模型加载失败：${(err as Error).message}`)
  } finally {
    URL.revokeObjectURL(url)
  }
})
