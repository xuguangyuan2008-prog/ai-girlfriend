import basicSsl from '@vitejs/plugin-basic-ssl'
import { defineConfig, loadEnv, type Plugin } from 'vite'

// 开发时把 /api/* 和豆包中转挂到 Vite dev server 上，只需要一个 `npm run dev`
function api(): Plugin {
  return {
    name: 'api',
    async configureServer(server) {
      Object.assign(process.env, loadEnv(server.config.mode, process.cwd(), ''))
      // 读完 .env 再加载服务端代码
      const { apiMiddleware, attachDoubao } = await import('./server/api.js')
      server.middlewares.use(apiMiddleware)
      if (server.httpServer) attachDoubao(server.httpServer)
    },
  }
}

export default defineConfig(({ mode }) => {
  // 手机调试：麦克风只能在 HTTPS 下用，`npm run dev:phone` 用自签名证书在局域网开 HTTPS
  const phone = mode === 'phone'
  return {
    plugins: [api(), phone && basicSsl()],
    server: {
      host: phone || undefined,
      // 允许通过内网穿透域名访问（cloudflared / ngrok）
      allowedHosts: ['.trycloudflare.com', '.ngrok-free.app', '.ngrok.app'],
    },
  }
})
