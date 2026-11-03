/**
 * 控えの現在状態（キャンセル済み）をクラウド照会で取り直すための
 * 共有 Promise キャッシュ（R26・ラウンド11 C-1R）。
 *
 * R25 の実装は、控えコンポーネントの effect が「照会済み」の印（ref）を
 * 立ててから await し、応答が返る前にストア再描画で effect が cleanup
 * されると、in-flight な結果が破棄され、再実行も印に阻まれて二度と
 * 照会しなかった（応答が遅いと控えが一生キャンセル済みに反転しない）。
 *
 * ここでは Promise 自体をコンポーネントの外（モジュール）に保持する:
 * - 同じ予約番号＋電話の照会は、進行中・完了後を問わず1回だけ発行する
 * - effect が cleanup されても Promise は生き続け、結果は失われない。
 *   再マウント／再実行した effect が同じ Promise を購読し直せば、
 *   遅れて届いた応答もそのまま反映される
 * - 失敗・未発見などで「不明」（null）に終わった場合はキャッシュに
 *   残さない。次に購読し直したときに再試行できる（＝再試行可能）。
 *   呼び出し側は null の間は従来表示を保つため、安全側に倒れる
 *   （有効な予約を誤ってキャンセル扱いすることはない）
 */

export type ReceiptCancelledLookup = (
  code: string,
  phone: string,
) => Promise<{ cancelled: boolean } | null>

const cache = new Map<string, Promise<boolean | null>>()

/**
 * 予約のキャンセル状態を（予約番号＋電話で）1回だけ照会する。
 * 戻り値: キャンセル済みなら true、そうでなければ false、
 * 照会できなかった・見つからなかった場合は null（不明）。
 */
export function lookupReceiptCancelled(
  lookup: ReceiptCancelledLookup,
  code: string,
  phone: string,
): Promise<boolean | null> {
  const key = `${code}|${phone}`
  const hit = cache.get(key)
  if (hit) return hit
  const p: Promise<boolean | null> = (async () => {
    try {
      const res = await lookup(code, phone)
      return res ? res.cancelled : null
    } catch {
      return null
    }
  })()
  cache.set(key, p)
  // 「不明」は確定結果として残さない（再試行の余地を残す）
  void p.then((v) => {
    if (v === null && cache.get(key) === p) cache.delete(key)
  })
  return p
}

/** テスト用: キャッシュを空にする */
export function clearReceiptStatusCache(): void {
  cache.clear()
}
