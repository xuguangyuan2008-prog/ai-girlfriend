import './style.css'
import { Avatar } from './avatar/Avatar'
import { LipSync } from './avatar/LipSync'
import { EMOTIONS, GESTURES, type Emotion } from './avatar/types'
import { EmotionDirector } from './realtime/EmotionDirector'
import { RealtimeClient } from './realtime/RealtimeClient'

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T

const ui = {
  stage: $('stage'),
  dot: $('dot'),
  charName: $('charName'),
  status: $('status'),
  log: $<HTMLUListElement>('log'),
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

// ---------- 实时对话 ----------
const client = new RealtimeClient()
const director = new EmotionDirector(client, avatar)
let connected = false
let micOn = true
let audioCtx: AudioContext | null = null

director.onCue = (cue) => {
  ui.cue.textContent = `${cue.emotion} / ${cue.gesture}\n「${cue.text}」`
}

ui.connect.onclick = async () => {
  if (connected) return hangUp()
  ui.connect.disabled = true
  setStatus('连接中…')
  // AudioContext 必须在用户点击时创建，否则浏览器会静音
  audioCtx ??= new AudioContext()
  await audioCtx.resume()
  try {
    const session = await client.connect()
    const lipSync = new LipSync(audioCtx, client.remoteStream!)
    avatar.setVisemeSource((dt) => lipSync.update(dt))
    connected = true
    ui.charName.textContent = session.characterName
    ui.dot.classList.add('live')
    ui.connect.textContent = '挂断'
    ui.mute.disabled = ui.textInput.disabled = false
    setStatus(`已连接 · ${session.model} · 直接说话就行，随时可以打断她`)
  } catch (err) {
    console.error(err)
    client.disconnect()
    setStatus(`连接失败：${(err as Error).message}`)
  } finally {
    ui.connect.disabled = false
  }
}

function hangUp() {
  client.disconnect()
  avatar.setVisemeSource(null)
  avatar.setMode('idle')
  connected = false
  micOn = true
  ui.dot.classList.remove('live')
  ui.connect.textContent = '开始聊天'
  ui.mute.disabled = ui.textInput.disabled = true
  ui.mute.classList.remove('off')
  setStatus('已挂断')
}

ui.mute.onclick = () => {
  micOn = !micOn
  client.setMicEnabled(micOn)
  ui.mute.classList.toggle('off', !micOn)
}

ui.textForm.onsubmit = (e) => {
  e.preventDefault()
  const text = ui.textInput.value.trim()
  if (!text || !connected) return
  client.sendText(text)
  addLog('user', text)
  ui.textInput.value = ''
}

client.on('client.disconnected', () => connected && hangUp())
client.on('error', (e) => {
  console.error('Realtime error', e.error)
  setStatus(`出错了：${e.error?.message ?? '未知错误'}`)
})

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

const assistantLines = new Map<string, HTMLLIElement>()
client.on('response.output_audio_transcript.delta', (e) => {
  let li = assistantLines.get(e.response_id)
  if (!li) {
    li = addLog('assistant', '')
    assistantLines.set(e.response_id, li)
  }
  li.textContent += e.delta
})
client.on('conversation.item.input_audio_transcription.completed', (e) => {
  if (e.transcript?.trim()) addLog('user', e.transcript.trim())
})

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
