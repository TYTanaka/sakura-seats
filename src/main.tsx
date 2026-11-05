import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import './index.css'
import { swScriptUrl } from './lib/swCore'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)

/**
 * Service Worker の登録（R37）: オフライン再読み込みでもアプリが開くように
 * する（public/sw.js）。登録は本番ビルドのみ（開発サーバでは HMR の邪魔に
 * なるため登録しない）。失敗してもアプリ本体には影響させない。
 * 登録パスは base（GitHub Pages の /sakura-seats/ や Cloudflare の /）に
 * 追随させる。SW 側の更新方式（network-first＋即時有効化）は swCore.ts 参照。
 */
if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker
      .register(swScriptUrl(import.meta.env.BASE_URL))
      .catch(() => {
        /* 登録できなくても通常のオンライン動作は続く */
      })
  })
}
