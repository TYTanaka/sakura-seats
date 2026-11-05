/**
 * Service Worker（public/sw.js）の判定ロジックの正（R37）。
 *
 * sw.js は素の JS で TS を import できないため、扱いの判定だけを
 * ここに切り出して単体テストで担保する。sw.js 側は Cache Storage との
 * 配線だけを担い、バージョン文字列と主要な振る舞いがここの判定と食い違って
 * いないことは round37 のテストが sw.js を読んで照合する。
 *
 * 方針（会場運用で「古い版が居座る」事故を最優先で避ける）:
 * - 遷移（HTML）は network-first＋キャッシュ fallback。オンラインでは
 *   常に最新を取り、キャッシュはオフライン時の保険にだけ使う
 * - ハッシュ付きアセットは cache-first。ファイル名にコンテンツハッシュが
 *   入っているため、内容が変われば URL も変わり、古い版を掴む心配がない
 * - それ以外（外部フォント・Supabase 等）は SW を介さない
 */

/** キャッシュの世代。public/sw.js の SW_VERSION と一致させること */
export const SW_VERSION = 'sakura-seats-v1'

export const ASSET_CACHE = `${SW_VERSION}-assets`
export const PAGE_CACHE = `${SW_VERSION}-pages`

/** この世代で保持するキャッシュ名（activate 時にこれ以外を全削除する） */
export const CURRENT_CACHES: readonly string[] = [ASSET_CACHE, PAGE_CACHE]

/** Vite のハッシュ付きアセット出力（/assets/<name>-<hash>.<ext>）か */
export function isHashedAssetPath(pathname: string): boolean {
  return /\/assets\/[^/]+-[A-Za-z0-9_-]{8,}\.[^/]+$/.test(pathname)
}

export type SwRequestKind = 'navigate' | 'asset' | 'passthrough'

export interface SwRequestLike {
  method: string
  mode: string
  /** リクエスト先が自オリジンか */
  sameOrigin: boolean
  pathname: string
}

/** リクエストの扱いを決める。sw.js の fetch ハンドラはこの判定に従う */
export function classifySwRequest(req: SwRequestLike): SwRequestKind {
  if (req.method !== 'GET') return 'passthrough'
  if (!req.sameOrigin) return 'passthrough'
  if (req.mode === 'navigate') return 'navigate'
  if (isHashedAssetPath(req.pathname)) return 'asset'
  return 'passthrough'
}

/** 登録先 URL。本番の base（import.meta.env.BASE_URL）に追随させる */
export function swScriptUrl(baseUrl: string): string {
  return `${baseUrl}sw.js`
}
