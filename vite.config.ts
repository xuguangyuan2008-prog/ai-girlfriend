import { defineConfig, loadEnv, type Plugin } from 'vite'

// 开发时把 /api/session 挂到 Vite dev server 上，只需要一个 `npm run dev`
function realtimeApi(): Plugin {
  return {
    name: 'realtime-api',
    configureServer(server) {
      Object.assign(process.env, loadEnv(server.config.mode, process.cwd(), ''))
      server.middlewares.use('/api/session', async (req, res) => {
        // @ts-expect-error 纯 JS 模块，没有类型声明
        const { sessionHandler } = await import('./server/session.js')
        await sessionHandler(req, res)
      })
    },
  }
}

export default defineConfig({
  plugins: [realtimeApi()],
})
