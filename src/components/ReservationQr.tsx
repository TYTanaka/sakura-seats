import { useEffect, useState } from 'react'

/** 予約番号QRの画像URLを取得する（生成ライブラリは動的 import で遅延読み込み） */
export function useReservationQrUrl(code: string): string {
  const [url, setUrl] = useState('')

  useEffect(() => {
    let cancelled = false
    import('../lib/qr')
      .then((m) => m.reservationQrDataUrl(code))
      .then((u) => {
        if (!cancelled) setUrl(u)
      })
      .catch(() => undefined)
    return () => {
      cancelled = true
    }
  }, [code])

  return url
}

/**
 * 予約番号の QR コード表示（予約完了画面・予約確認結果で共用）。
 * QR 生成ライブラリは動的 import で遅延読み込みする。
 */
export default function ReservationQr({ code }: { code: string }) {
  const url = useReservationQrUrl(code)

  return (
    <div className="reservation-qr" data-reservation-qr>
      {url ? (
        <img
          className="reservation-qr-img"
          src={url}
          alt={`予約番号 ${code} のQRコード`}
          width={168}
          height={168}
        />
      ) : (
        <p className="muted small reservation-qr-loading">QRコードを準備中…</p>
      )}
      <p className="qr-caption">当日、受付でこのQRコードを見せてください</p>
    </div>
  )
}
