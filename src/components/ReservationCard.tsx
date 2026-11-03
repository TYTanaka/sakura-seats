import { useEffect, useState } from 'react'
import {
  formatYen,
  reservationDisplayName,
  reservationTotal,
  reservationTypeSummary,
  type Reservation,
} from '../lib/logic'
import { reservationSeatDisplay } from '../lib/zones'

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

  // R20: キャンセル確認モーダル表示中は Escape で閉じ、背後のスクロールを止める
  useEffect(() => {
    if (!confirmingCancel) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setConfirmingCancel(false)
    }
    document.addEventListener('keydown', onKey)
    const prevOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      document.removeEventListener('keydown', onKey)
      document.body.style.overflow = prevOverflow
    }
  }, [confirmingCancel])

  const receptionDone = res.paid && res.checkedIn
  // R12: ゾーン予約は支払いまで席未確定（ゾーン名＋「席未確定」で表示し、
  // 席番号は出さない）。支払い後に割り当たれば従来どおり席を表示する
  const seatDisplay = reservationSeatDisplay(res)

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
            {seatDisplay.isZone && (
              <span className="source-badge source-zone" data-zone-badge>
                ゾーン{res.zone}
              </span>
            )}
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
        <p
          className="reservation-seats"
          data-seat-display={seatDisplay.assigned ? 'seats' : 'unassigned'}
        >
          {seatDisplay.text}
        </p>
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
            <button
              type="button"
              className="btn btn-ghost btn-small"
              onClick={() => setConfirmingCancel(true)}
            >
              予約キャンセル
            </button>
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

      {/* R20: キャンセル確認モーダル（旧インライン確認は誤タップしやすいため廃止）。
          背景タップ・やめる・Escape では閉じるだけでキャンセルしない */}
      {confirmingCancel && (
        <div
          className="modal-backdrop"
          data-cancel-modal
          onClick={() => setConfirmingCancel(false)}
        >
          <div
            className="modal-panel"
            role="alertdialog"
            aria-modal="true"
            aria-label="予約キャンセルの確認"
            onClick={(e) => e.stopPropagation()}
          >
            <h4 className="modal-title">本当にキャンセルしますか？</h4>
            <dl className="modal-summary">
              <div>
                <dt>お名前</dt>
                <dd>{reservationDisplayName(res)}</dd>
              </div>
              <div>
                <dt>予約番号</dt>
                <dd>{res.id}</dd>
              </div>
              <div>
                <dt>席</dt>
                <dd>{seatDisplay.text || '—'}</dd>
              </div>
              <div>
                <dt>人数</dt>
                <dd>{res.items.length}名</dd>
              </div>
              <div>
                <dt>合計</dt>
                <dd>{formatYen(reservationTotal(res))}</dd>
              </div>
              <div>
                <dt>支払い</dt>
                <dd>{res.paid ? '支払済' : '未払い'}</dd>
              </div>
            </dl>
            <p className="modal-note">
              キャンセルすると、この予約の席が解放されます。
            </p>
            <div className="modal-actions">
              <button
                type="button"
                className="btn btn-danger modal-btn"
                data-cancel-modal-confirm
                onClick={() => {
                  onCancel(res)
                  setConfirmingCancel(false)
                }}
              >
                キャンセルする
              </button>
              <button
                type="button"
                className="btn btn-ghost modal-btn"
                data-cancel-modal-abort
                autoFocus
                onClick={() => setConfirmingCancel(false)}
              >
                やめる
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  )
}
