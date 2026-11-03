import { useEffect, useState } from 'react'
import { encodeQrPayload, isQrToken } from '../lib/qrToken'
import { formatCheckedInAt } from './ReservationCard'

/**
 * QR の中身（payload 文字列）から画像 URL を取得する。
 * 生成ライブラリは動的 import で遅延読み込みする。payload が null なら生成しない。
 */
export function useReservationQrUrl(payload: string | null): string {
  const [url, setUrl] = useState('')

  useEffect(() => {
    if (!payload) {
      setUrl('')
      return
    }
    let cancelled = false
    import('../lib/qr')
      .then((m) => m.reservationQrDataUrl(payload))
      .then((u) => {
        if (!cancelled) setUrl(u)
      })
      .catch(() => undefined)
    return () => {
      cancelled = true
    }
  }, [payload])

  return url
}

/**
 * 受付用 QR コード表示（予約完了画面・予約確認結果・控えで共用）。
 *
 * R7: QR の中身は予約番号ではなく、予約ごとのトークン（`sk1:` 形式）。
 * 連番の予約番号をそのまま入れると誰でも偽装できるため。
 * トークンを持たない予約（この仕組みより前の予約・控え、または
 * サーバ更新前のクラウド予約）では QR を出さず、予約番号の提示を案内する。
 */
export default function ReservationQr({
  code,
  token,
  checkedInAt,
}: {
  code: string
  token?: string | null
  /**
   * 受付済みのときの受付日時（R21・評価ラウンド8 C-2）。
   * 渡されたら案内文を「受付済み」に切り替える（照会画面用）。
   * 完了画面など受付前の表示では渡さない。
   */
  checkedInAt?: string | null
}) {
  const payload = isQrToken(token) ? encodeQrPayload(token) : null
  const url = useReservationQrUrl(payload)
  const checkedInCaption = checkedInAt
    ? `受付済みです（${formatCheckedInAt(checkedInAt)}）`
    : null

  if (!payload) {
    return (
      <div className="reservation-qr" data-reservation-qr data-qr-token="absent">
        <p className="qr-code-fallback">
          予約番号 <strong>{code}</strong>
        </p>
        <p className="qr-caption">
          {checkedInCaption ??
            '当日は受付で予約番号をお伝えください（この予約にはQRコードがありません）'}
        </p>
      </div>
    )
  }

  return (
    <div className="reservation-qr" data-reservation-qr data-qr-token="present">
      {url ? (
        <img
          className="reservation-qr-img"
          src={url}
          alt={`予約番号 ${code} のQRコード`}
          width={168}
          height={168}
        />
      ) : (
        /* R34・R13-3: 生成待ちの間も予約番号を先に大きく見せ、「数秒で
           表示される」ことを伝える（番号さえ分かれば受付できるため、
           素っ気ない「準備中…」だけを見せ続けない） */
        <div className="reservation-qr-loading">
          <p className="qr-code-fallback">
            予約番号 <strong>{code}</strong>
          </p>
          <p className="muted small">
            QRコードを準備中です（数秒で表示されます。そのままお待ちください）
          </p>
        </div>
      )}
      <p className="qr-caption">
        {checkedInCaption ?? '当日、受付でこのQRコードを見せてください'}
      </p>
    </div>
  )
}
