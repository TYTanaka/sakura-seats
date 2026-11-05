import { useEffect, useRef, useState } from 'react'
import { seatById } from '../data/seats'
import {
  formatSeatList,
  formatYen,
  reservationDisplayName,
  reservationTotal,
  reservationTypeSummary,
  seatStatus,
  type Reservation,
} from '../lib/logic'
import { useStore } from '../lib/store'
import { reservationSeatDisplay, zoneLabel, zoneOfSeat } from '../lib/zones'
import StaffSeatMap, { type StaffSeatState } from './StaffSeatMap'

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
  /**
   * 席の手動指定（R25・ラウンド10 S-1）。未割当のゾーン予約にだけ
   * 「席を指定する」を出す。失敗時は呼び出し側がトーストで理由を出し、
   * この Promise を reject する（パネルは開いたままになる）。
   */
  onAssignSeats?: (res: Reservation, seatIds: string[]) => Promise<void>
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
  onAssignSeats,
}: ReservationCardProps) {
  const { data } = useStore()
  /**
   * キャンセル確認の段階（R22・オーナー要望で2段階に戻す）:
   * idle → inline（カード内の小さな確認・R20以前の形）→ modal（R20の
   * 大きなモーダルが最終確認）。実際のキャンセルはモーダルの
   * 「キャンセルする」からだけ実行される。inline の「やめる」はカードの
   * 通常表示に畳み、モーダルの「やめる」・背景・Escape は閉じるだけ。
   */
  const [cancelStep, setCancelStep] = useState<'idle' | 'inline' | 'modal'>('idle')
  /**
   * 受付完了の確認段階（R26・ラウンド11 N3-2）: 未払いの予約では
   * 「受付完了（支払い＋来場）」を押しただけでは完了させず、金額入りの
   * 軽い確認（「合計◯円を受け取りましたか？」）を1段挟む。
   * 「チェックインだけして」という口頭指示で主ボタンを押した新人が、
   * 現金未収なのに支払い済みにしてしまう事故を防ぐため。
   * 支払い済み（来場だけが残っている）予約は従来どおりワンタップで速く。
   */
  const [completeConfirm, setCompleteConfirm] = useState(false)
  /** モーダルのパネルと、閉じたときにフォーカスを戻す先（予約キャンセルボタン） */
  const modalPanelRef = useRef<HTMLDivElement>(null)
  const cancelTriggerRef = useRef<HTMLButtonElement>(null)

  // モーダル表示中は Escape で閉じ、背後のスクロールを止める（R20）
  // R25（ラウンド10・A-1）: Tab はモーダル内（2ボタン）で循環させる
  // フォーカストラップを追加し、閉じたら呼び出し元ボタンへフォーカスを戻す。
  // 背景ページへフォーカスが抜けると、キーボード/スイッチ操作のスタッフが
  // 見えない背景を操作しかねないため。
  useEffect(() => {
    if (cancelStep !== 'modal') return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setCancelStep('idle')
        return
      }
      if (e.key !== 'Tab') return
      const panel = modalPanelRef.current
      if (!panel) return
      const focusables = [
        ...panel.querySelectorAll<HTMLElement>(
          'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
        ),
      ].filter((el) => el.offsetParent !== null || el === document.activeElement)
      if (focusables.length === 0) return
      const first = focusables[0]
      const last = focusables[focusables.length - 1]
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault()
        last.focus()
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault()
        first.focus()
      }
    }
    document.addEventListener('keydown', onKey)
    const prevOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      document.removeEventListener('keydown', onKey)
      document.body.style.overflow = prevOverflow
      // 閉じたら操作の起点（予約キャンセルボタン）へフォーカスを戻す
      cancelTriggerRef.current?.focus()
    }
  }, [cancelStep])

  const receptionDone = res.paid && res.checkedIn
  // R12: ゾーン予約は支払いまで席未確定（ゾーン名＋「席未確定」で表示し、
  // 席番号は出さない）。支払い後に割り当たれば従来どおり席を表示する
  const seatDisplay = reservationSeatDisplay(res)

  /* ---------------- 席の手動指定（R25・ラウンド10 S-1） ---------------- */
  // 自動割当できずに手動チェックインした予約など、未割当のゾーン予約には
  // スタッフが座席表から席を決める手段がなかった。カード内で座席表を開き、
  // そのゾーンの空席だけを人数分選んで確定する。支払い・来場は変えない
  const [assignOpen, setAssignOpen] = useState(false)
  const [picked, setPicked] = useState<string[]>([])
  const [assigning, setAssigning] = useState(false)
  const canAssign =
    !!onAssignSeats && !res.cancelled && seatDisplay.isZone && !seatDisplay.assigned
  /** 来場済みなのに席が決まっていない（当日の案内が止まる状態） */
  const seatPendingUrgent = canAssign && res.checkedIn
  const party = res.items.length

  const assignStateOf = (seatId: string): StaffSeatState => {
    if (picked.includes(seatId)) return 'selected'
    return seatStatus(data, seatId)
  }
  const assignSeatEnabled = (seatId: string): boolean => {
    if (picked.includes(seatId)) return true
    return (
      zoneOfSeat(seatById(seatId)) === res.zone &&
      seatStatus(data, seatId) === 'available'
    )
  }
  const togglePick = (seatId: string) => {
    // 関数型更新にする: 同一タスク内の連続タップでも、直前の選択を
    // 取りこぼさずにトグルできるように（state の古い値で上書きしない）
    setPicked((prev) => {
      if (prev.includes(seatId)) return prev.filter((id) => id !== seatId)
      if (zoneOfSeat(seatById(seatId)) !== res.zone) return prev
      if (seatStatus(data, seatId) !== 'available') return prev
      if (prev.length >= party) return prev
      return [...prev, seatId]
    })
  }
  const closeAssign = () => {
    setAssignOpen(false)
    setPicked([])
  }
  const confirmAssign = async () => {
    if (!onAssignSeats || picked.length !== party || assigning) return
    setAssigning(true)
    try {
      await onAssignSeats(res, picked)
      closeAssign()
    } catch {
      // 理由は呼び出し側がトーストで出す。パネルは開いたままにして選び直せるようにする
    } finally {
      setAssigning(false)
    }
  }

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
                {/* R25（S-1）: 来場済みなのに席未確定なら警告色で強く出す。
                    このままではお客様を席へ案内できない状態だと一目で分かるように */}
                {seatPendingUrgent && (
                  <span className="state-chip is-seat-pending" data-seat-pending>
                    席未確定
                  </span>
                )}
              </>
            )}
          </p>
        </div>
        <p
          className={`reservation-seats${seatPendingUrgent ? ' is-seat-pending' : ''}`}
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
          {!receptionDone &&
            (completeConfirm && !res.paid ? (
              // R26（N3-2）: 未払いの場合の金額入り確認。実際に完了するのは
              // 「受け取った」からだけ（キャンセルの2段階確認と同じ作法）
              <span className="complete-confirm" data-complete-confirm>
                合計{formatYen(reservationTotal(res))}を受け取りましたか？
                <button
                  type="button"
                  className="btn btn-primary btn-small"
                  data-complete-confirm-ok
                  onClick={() => {
                    setCompleteConfirm(false)
                    onComplete(res)
                  }}
                >
                  受け取って受付完了
                </button>
                <button
                  type="button"
                  className="btn btn-ghost btn-small"
                  data-complete-confirm-abort
                  onClick={() => setCompleteConfirm(false)}
                >
                  やめる
                </button>
              </span>
            ) : (
              <button
                type="button"
                data-action="complete"
                className="toggle-btn complete-btn reservation-primary"
                onClick={() => {
                  // 未払いは確認を挟む。支払い済みはワンタップのまま
                  if (!res.paid) setCompleteConfirm(true)
                  else onComplete(res)
                }}
              >
                {/* R36（低8）: 残っている手続きだけを文言に出す。
                    支払済なのに「支払い＋来場」と出ると、済ませたことに
                    なるのか一瞬迷うため */}
                {res.paid
                  ? '受付完了（来場のみ）'
                  : res.checkedIn
                    ? '受付完了（支払いのみ）'
                    : '受付完了（支払い＋来場）'}
              </button>
            ))}
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
            {canAssign && (
              <button
                type="button"
                data-action="assign-seats"
                aria-expanded={assignOpen}
                className={`toggle-btn sub${seatPendingUrgent ? ' warn' : ''}`}
                onClick={() => (assignOpen ? closeAssign() : setAssignOpen(true))}
              >
                席を指定する
              </button>
            )}
            {cancelStep === 'inline' ? (
              <span className="cancel-confirm" data-cancel-inline>
                キャンセルしますか？
                <button
                  type="button"
                  className="btn btn-danger btn-small"
                  data-cancel-inline-confirm
                  onClick={() => setCancelStep('modal')}
                >
                  キャンセルする
                </button>
                <button
                  type="button"
                  className="btn btn-ghost btn-small"
                  data-cancel-inline-abort
                  onClick={() => setCancelStep('idle')}
                >
                  やめる
                </button>
              </span>
            ) : (
              <button
                type="button"
                data-action="cancel"
                ref={cancelTriggerRef}
                className="btn btn-ghost btn-small"
                onClick={() => setCancelStep('inline')}
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

      {/* 席の手動指定パネル（R25・S-1）: そのゾーンの空席だけが選べる。
          支払い・来場の状態は変えず、席だけを確定する */}
      {canAssign && assignOpen && (
        <div className="assign-panel" data-assign-panel>
          <p className="assign-panel-note">
            {res.zone ? zoneLabel(res.zone) : ''}の空席から{party}席選んでください（
            {picked.length}/{party}席）。薄くなっている席は対象外です。
            支払い・来場の状態は変わりません。
          </p>
          <StaffSeatMap
            data={data}
            stateOf={assignStateOf}
            onSeatTap={togglePick}
            seatEnabled={assignSeatEnabled}
          />
          {picked.length > 0 && (
            <p className="door-selection-bar" data-assign-selection>
              選択中：{formatSeatList(picked)}
            </p>
          )}
          <div className="btn-row">
            <button
              type="button"
              className="btn btn-primary"
              data-assign-confirm
              disabled={picked.length !== party || assigning}
              onClick={() => void confirmAssign()}
            >
              {assigning ? '割り当て中…' : 'この席に決める'}
            </button>
            <button
              type="button"
              className="btn btn-ghost"
              data-assign-abort
              disabled={assigning}
              onClick={closeAssign}
            >
              やめる
            </button>
          </div>
        </div>
      )}

      {/* R22: 最終確認モーダル（R20のものをそのまま第2段階にする）。
          背景タップ・やめる・Escape では閉じるだけでキャンセルしない */}
      {cancelStep === 'modal' && (
        <div
          className="modal-backdrop"
          data-cancel-modal
          onClick={() => setCancelStep('idle')}
        >
          <div
            className="modal-panel"
            role="alertdialog"
            aria-modal="true"
            aria-label="予約キャンセルの確認"
            ref={modalPanelRef}
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
                  setCancelStep('idle')
                }}
              >
                キャンセルする
              </button>
              <button
                type="button"
                className="btn btn-ghost modal-btn"
                data-cancel-modal-abort
                autoFocus
                onClick={() => setCancelStep('idle')}
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
