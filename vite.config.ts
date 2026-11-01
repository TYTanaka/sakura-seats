/// <reference types="vitest/config" />
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  // 相対パスで出力し、配信サブパス（GitHub Pages 等）に依存しない。
  base: './',
  test: {
    environment: 'node',
  },
})
