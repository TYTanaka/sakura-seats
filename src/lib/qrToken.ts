/**
 * 受付用 QR トークン（R7）。
 *
 * 旧方式は予約番号（SK-0001 のような連番）そのものを QR に入れていたため、
 * 誰でも番号を印刷すれば偽装できてしまった。新方式では QR に入れるのは
 * 予約ごとに発行する推測不能なトークンだけにし、受付可否はサーバ
 * （クラウド: staff_check_in RPC）または端末内データ（ローカル）で検証する。
 *
 * QR の中身 = `sk1:` + トークン（16バイト乱数の base64url = 22文字）。
 * 接頭辞で新形式 / 旧形式（予約番号そのまま）/ それ以外を判別する。
 */

export const QR_PAYLOAD_PREFIX = 'sk1:'

/** トークン本体の形式: base64url 22文字（128bit） */
const TOKEN_RE = /^[A-Za-z0-9_-]{22}$/

/** 値がトークン本体の形式かどうか */
export function isQrToken(value: unknown): value is string {
  return typeof value === 'string' && TOKEN_RE.test(value)
}

/** 推測不能なトークンを生成する（Web Crypto の乱数） */
export function generateQrToken(): string {
  const bytes = new Uint8Array(16)
  globalThis.crypto.getRandomValues(bytes)
  let binary = ''
  for (const b of bytes) binary += String.fromCharCode(b)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

/** トークン → QR に埋め込む文字列 */
export function encodeQrPayload(token: string): string {
  return `${QR_PAYLOAD_PREFIX}${token}`
}

export type QrPayload =
  | { kind: 'token'; token: string }
  | { kind: 'legacy'; code: string }
  | { kind: 'invalid' }

/**
 * 読み取った文字列を分類する。
 * - `sk1:` + 正しい形式のトークン → token
 * - 予約番号そのもの（旧形式 QR） → legacy（番号で受付してもらう）
 * - それ以外 → invalid
 * トークンは大文字小文字を区別するため、token の場合は正規化しない。
 */
export function parseQrPayload(raw: string): QrPayload {
  const value = (raw ?? '').trim()
  if (value.startsWith(QR_PAYLOAD_PREFIX)) {
    const token = value.slice(QR_PAYLOAD_PREFIX.length)
    return isQrToken(token) ? { kind: 'token', token } : { kind: 'invalid' }
  }
  const upper = value.toUpperCase()
  if (/^SK-\d+$/.test(upper)) return { kind: 'legacy', code: upper }
  return { kind: 'invalid' }
}
