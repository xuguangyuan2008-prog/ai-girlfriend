// 生产环境入口：先 `npm run build`，再 `npm start`
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import express from 'express'

if (existsSync('.env')) process.loadEnvFile('.env')

const { apiMiddleware, attachDoubao } = await import('./api.js')

const app = express()
const dist = fileURLToPath(new URL('../dist', import.meta.url))

app.use(apiMiddleware)
app.use(express.static(dist))

const port = Number(process.env.PORT) || 3000
const server = app.listen(port, () => console.log(`http://localhost:${port}`))
attachDoubao(server, { rejectOthers: true })
