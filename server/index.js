// 生产环境入口：先 `npm run build`，再 `npm start`
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import express from 'express'

if (existsSync('.env')) process.loadEnvFile('.env')

const { apiMiddleware, attachDoubao } = await import('./api.js')

const app = express()
const dist = fileURLToPath(new URL('../dist', import.meta.url))
const publicDir = fileURLToPath(new URL('../public', import.meta.url))

app.use(apiMiddleware)
app.use(express.static(dist))
// 构建之后才生成的素材（如 npm run h3 -- idle 生成的待机视频）直接从 public/ 读，不用重新构建
app.use(express.static(publicDir))

const port = Number(process.env.PORT) || 3000
const server = app.listen(port, () => console.log(`http://localhost:${port}`))
attachDoubao(server, { rejectOthers: true })
