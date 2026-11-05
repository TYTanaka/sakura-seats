/**
 * さくら席 Service Worker（R37）。
 *
 * 目的: 会場のネットが不調でも、オフライン再読み込みでアプリが開くこと。
 * public/ に置き、ビルド成果物へそのままコピーさせる（素の JS）。
 *
 * 判定（どのリクエストをどう扱うか）の正は src/lib/swCore.ts で、
 * 単体テストで担保する。このファイルは Cache Storage との配線だけを担い、
 * バージョン文字列と主要な振る舞いが swCore.ts と食い違っていないことは
 * round37 のテストがこのファイルを読んで照合する。
 *
 * 方針:
 * - 遷移（HTML）は network-first＋キャッシュ fallback（新しい版を優先し、
 *   オフライン時だけ前回の版を出す。古い版が居座らないための要）
 * - ハッシュ付きアセットは cache-first（URL にハッシュがあるため安全）
 * - バージョンが変わったら旧キャッシュを全削除し、新 SW は即時有効化
 *   （skipWaiting + clients.claim）。会場運用で「古い版が居座る事故」を防ぐ
 */

/** キャッシュの世代（src/lib/swCore.ts の SW_VERSION と一致させる。
 *  SW の内容が変わればブラウザが自動で更新するが、世代を上げると
 *  旧キャッシュを確実に捨てられる） */
const SW_VERSION = 'sakura-seats-v1'
const ASSET_CACHE = `${SW_VERSION}-assets`
const PAGE_CACHE = `${SW_VERSION}-pages`

/** ハッシュ付きアセットか（Vite の出力: /assets/<name>-<hash>.<ext>）。
 *  判定の正は swCore.ts の isHashedAssetPath */
function isHashedAsset(url) {
  return /\/assets\/[^/]+-[A-Za-z0-9_-]{8,}\.[^/]+$/.test(url.pathname)
}

self.addEventListener('install', (event) => {
  // 新しい版は待たせず即有効化する（会場で古い版が居座る事故を防ぐ）
  event.waitUntil(self.skipWaiting())
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys()
      await Promise.all(
        keys
          .filter((k) => k !== ASSET_CACHE && k !== PAGE_CACHE)
          .map((k) => caches.delete(k)),
      )
      await self.clients.claim()
    })(),
  )
})

self.addEventListener('fetch', (event) => {
  const { request } = event
  if (request.method !== 'GET') return
  const url = new URL(request.url)
  if (url.origin !== self.location.origin) return

  if (request.mode === 'navigate') {
    // 遷移: network-first。オンラインでは常に最新の HTML を取りに行き、
    // 取れたらキャッシュを更新する。失敗したらキャッシュ済み HTML を返す
    event.respondWith(
      (async () => {
        const cache = await caches.open(PAGE_CACHE)
        try {
          const fresh = await fetch(request)
          if (fresh.ok) cache.put(request, fresh.clone())
          return fresh
        } catch {
          const cached = await cache.match(request, { ignoreSearch: true })
          if (cached) return cached
          throw new Error('offline and no cached page')
        }
      })(),
    )
    return
  }

  if (isHashedAsset(url)) {
    // ハッシュ付きアセット: cache-first（無ければ取得して保存）
    event.respondWith(
      (async () => {
        const cache = await caches.open(ASSET_CACHE)
        const cached = await cache.match(request)
        if (cached) return cached
        const fresh = await fetch(request)
        if (fresh.ok) cache.put(request, fresh.clone())
        return fresh
      })(),
    )
  }
  // それ以外（フォント・API 等）は SW を介さず通常の取得に任せる
})
