import basicSsl from '@vitejs/plugin-basic-ssl'
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

export default defineConfig(({ mode }) => {
  // 手机调试：麦克风只能在 HTTPS 下用，`npm run dev:phone` 用自签名证书在局域网开 HTTPS
  const phone = mode === 'phone'
  return {
    plugins: [realtimeApi(), phone && basicSsl()],
    server: {
      host: phone || undefined,
      // 允许通过内网穿透域名访问（cloudflared / ngrok）
      allowedHosts: ['.trycloudflare.com', '.ngrok-free.app', '.ngrok.app'],
    },
  }
})
