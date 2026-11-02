/// <reference types="vitest/config" />
import react from '@vitejs/plugin-react'
import { defineConfig, loadEnv } from 'vite'

// https://vite.dev/config/
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '')
  return {
    plugins: [react()],
    // 配信先のベースパス。既定は現在の GitHub Pages のパス。
    // Cloudflare Pages（ルート配信）では VITE_BASE=/ を指定する（app/CLOUDFLARE.md）。
    base: env.VITE_BASE ?? '/sakura-seats/',
    test: {
      environment: 'node',
    },
  }
})
