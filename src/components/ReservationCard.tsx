import { useState } from 'react'
import {
  formatSeatList,
  formatYen,
  reservationDisplayName,
  reservationTotal,
  reservationTypeSummary,
  type Reservation,
} from '../lib/logic'

/** ISO日時を「12月19日 13:05」の形にする（受付済み時刻の表示用） */
export function formatCheckedInAt(iso: string | null | undefined): string {
  if (!iso) return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  const hh = String(d.getHours()).padStart(2, '0')
  const mm = String(d.getMinutes()).padStart(2, '0')
  return `${d.getMonth() + 1}月${d.getDate()}日 ${hh}:${mm}`
}

interface ReservationCardProps {
  res: Reservation
  onComplete: (res: Reservation) => void
  onToggleCheckIn: (res: Reservation) => void
  onTogglePaid: (res: Reservation) => void
  onCancel: (res: Reservation) => void
  /** キャンセル済みカードの「取り消す」ボタン（QR受付では渡さない） */
  onUncancel?: (res: Reservation) => void
}

/**
 * スタッフ向け予約カード（受付一覧と QR受付で共用）。
 *
 * 見やすさの階層（R7・スタッフUI改善）:
 * - 1段目: 氏名（主）＋予約番号（副）／右に状態チップ（当日販売・支払済/未払い・来場済・キャンセル済）
 *   状態はボタンの見た目ではなくチップで読めるようにする
 * - 2段目: 座席は範囲圧縮表記（1階 3列 11〜16番）で太字
 * - 3段目: 券種・合計（強調）・電話・販売者・備考を控えめに
 * - 操作: 主アクション「受付完了」は全幅で1つだけ目立たせ、副アクション
 *   （来場/支払いの個別トグル・キャンセル）は下段に小さくまとめる。
 *   状態に応じて不要な主アクションは出さない（支払済＋来場済なら主ボタンなし）。
 * 操作の意味・対象は従来と同一（data-action 属性も維持）。
 */
export default function ReservationCard({
  res,
  onComplete,
  onToggleCheckIn,
  onTogglePaid,
  onCancel,
  onUncancel,
}: ReservationCardProps) {
  const [confirmingCancel, setConfirmingCancel] = useState(false)
  const receptionDone = res.paid && res.checkedIn

  return (
    <>
      <div className="reservation-main">
        <div className="reservation-head">
          <p className="reservation-title">
            <span className="reservation-name">{reservationDisplayName(res)}</span>
            <span className="reservation-code-small" data-qr-result-code>
              {res.id}
            </span>
          </p>
          <p className="reservation-chips">
            <span className={`source-badge source-${res.source}`}>
              {res.source === 'door' ? '当日販売' : '予約'}
            </span>
            {res.cancelled ? (
              <span className="source-badge source-cancelled">キャンセル済</span>
            ) : (
              <>
                <span className={`state-chip ${res.paid ? 'is-paid' : 'is-unpaid'}`}>
                  {res.paid ? '支払済' : '未払い'}
                </span>
                {res.checkedIn && <span className="state-chip is-checkedin">来場済</span>}
              </>
            )}
          </p>
        </div>
        <p className="reservation-seats">{formatSeatList(res.seatIds)}</p>
        <p className="muted small reservation-meta">
          <span data-type-breakdown>{reservationTypeSummary(res)}</span>
          {' ／ '}合計{' '}
          <strong className="reservation-total">{formatYen(reservationTotal(res))}</strong>
          {' ／ '}電話：{res.phone || '（未入力）'}
          {res.seller && (
            <>
              {' ／ '}販売者：<span data-seller-name>{res.seller}</span>
            </>
          )}
          {res.note && <> ／ 備考：{res.note}</>}
        </p>
        {res.checkedIn && res.checkedInAt && (
          <p className="muted small reservation-meta">
            受付済み：{formatCheckedInAt(res.checkedInAt)}
          </p>
        )}
      </div>

      {!res.cancelled ? (
        <div className="reservation-actions">
          {!receptionDone && (
            <button
              type="button"
              data-action="complete"
              className="toggle-btn complete-btn reservation-primary"
              onClick={() => onComplete(res)}
            >
              受付完了（支払い＋来場）
            </button>
          )}
          <div className="reservation-subactions">
            <button
              type="button"
              data-action="checkin"
              aria-pressed={res.checkedIn}
              className={`toggle-btn sub${res.checkedIn ? ' on' : ''}`}
              onClick={() => onToggleCheckIn(res)}
            >
              {res.checkedIn ? '✓ 来場済み' : '来場チェックイン'}
            </button>
            <button
              type="button"
              data-action="pay"
              aria-pressed={res.paid}
              className={`toggle-btn sub${res.paid ? ' on' : ''}`}
              onClick={() => onTogglePaid(res)}
            >
              {res.paid ? '✓ 支払い済み' : '支払い済みにする'}
            </button>
            {confirmingCancel ? (
              <span className="cancel-confirm">
                キャンセルしますか？
                <button
                  type="button"
                  className="btn btn-danger btn-small"
                  onClick={() => {
                    onCancel(res)
                    setConfirmingCancel(false)
                  }}
                >
                  キャンセルする
                </button>
                <button
                  type="button"
                  className="btn btn-ghost btn-small"
                  onClick={() => setConfirmingCancel(false)}
                >
                  やめる
                </button>
              </span>
            ) : (
              <button
                type="button"
                className="btn btn-ghost btn-small"
                onClick={() => setConfirmingCancel(true)}
              >
                予約キャンセル
              </button>
            )}
          </div>
        </div>
      ) : onUncancel ? (
        <div className="reservation-actions">
          <div className="reservation-subactions">
            <button
              type="button"
              data-action="uncancel"
              className="toggle-btn sub"
              onClick={() => onUncancel(res)}
            >
              キャンセルを取り消す
            </button>
          </div>
        </div>
      ) : null}
    </>
  )
}
