import { useEffect, useMemo, useState, type FormEvent } from 'react'
import {
  ALL_SEATS,
  PARENT_ROOM_SEATS,
  SIDE_L_SEATS,
  SIDE_R_SEATS,
  WHEELCHAIR_SEATS,
  seatById,
  seatIdsOfRow,
  type Floor,
  type SeatDef,
} from '../data/seats'
import {
  activeReservations,
  defaultTicketType,
  doorsOpenBeforeStart,
  formatYen,
  normalizePhone,
  normalizeSellerNames,
  reservationDisplayName,
  reservationTotal,
  reservationTypeSummary,
  seatStatus,
  totals,
  type Performance,
  type TicketType,
} from '../lib/logic'
import { DEFAULT_PASSCODE, useStore } from '../lib/store'
import { useToast } from '../lib/toast'
import { downloadReservationsCsv } from '../lib/csv'
import SeatMap, {
  SeatLegend,
  ZoomControls,
  type SeatVisualState,
  type SeatZoom,
} from './SeatMap'
import TicketTypePicker, { priceOfSeat } from './TicketTypePicker'
import QrReception from './QrReception'

type StaffTab = 'reception' | 'door' | 'settings' | 'summary' | 'perf'
const ALL_SEAT_IDS = ALL_SEATS.map((s) => s.id)

/**
 * スタッフ入室状態の保持先（R3-8）: sessionStorage なのでタブを閉じれば消える。
 * 同じタブ内でお客様画面へ出て戻ってきても再入室を求めないための保持で、
 * 明示的なログアウトで破棄する。
 *
 * トレードオフ（R4-8）: ここにはパスコードそのものを平文で保持している。
 * ハッシュを保存しても、それ自体が入室に使える「同等の資格情報」になるため
 * 安全性は変わらない。守るべき境界は「タブを閉じれば消える」「端末を他人へ
 * 渡すときはログアウトする」という運用側に置く（警告文もスタッフ内に出している）。
 */
const STAFF_SESSION_KEY = 'sakura-seats-staff-session'

function loadStaffSession(): string | null {
  try {
    return sessionStorage.getItem(STAFF_SESSION_KEY)
  } catch {
    return null
  }
}

function saveStaffSession(passcode: string) {
  try {
    sessionStorage.setItem(STAFF_SESSION_KEY, passcode)
  } catch {
    // 保存できなくても入室自体は継続する
  }
}

function clearStaffSession() {
  try {
    sessionStorage.removeItem(STAFF_SESSION_KEY)
  } catch {
    // 何もしない
  }
}

/**
 * ローカルモードの明示バナー（R4-2）: クラウド接続が無効なビルドを
 * 本番運用と誤認しないよう、スタッフエリアではっきり知らせる。
 */
function LocalModeBanner() {
  return (
    <p className="local-mode-banner" data-local-mode-banner role="alert">
      ⚠ ローカルモードで動作しています：データはこの端末内にのみ保存され、
      他の端末とは同期されません。
    </p>
  )
}

export default function Staff({ onExit }: { onExit: () => void }) {
  const { mode, staffUnlock } = useStore()
  const [unlocked, setUnlocked] = useState(false)
  const [passcode, setPasscode] = useState('')
  const [passError, setPassError] = useState('')
  const [checking, setChecking] = useState(false)
  const [tab, setTab] = useState<StaffTab>('reception')
  /** 入室に使ったパスコード（初期値のままかどうか・セッション保持の更新に使う） */
  const [sessionPasscode, setSessionPasscode] = useState('')

  // 同じタブセッション内での再入室を省略する（保存済みパスコードで自動入室を試す）
  useEffect(() => {
    const saved = loadStaffSession()
    if (!saved) return
    let active = true
    setChecking(true)
    void staffUnlock(saved)
      .then((ok) => {
        if (!active) return
        if (ok) {
          setSessionPasscode(saved)
          setUnlocked(true)
        } else {
          clearStaffSession()
        }
      })
      .catch(() => {
        if (active) clearStaffSession()
      })
      .finally(() => {
        if (active) setChecking(false)
      })
    return () => {
      active = false
    }
    // 初回マウント時のみ
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const handleLogout = () => {
    clearStaffSession()
    setSessionPasscode('')
    setPasscode('')
    setPassError('')
    setUnlocked(false)
  }

  if (!unlocked) {
    return (
      <section className="card staff-login">
        <button type="button" className="btn btn-ghost back-btn" onClick={onExit}>
          ← 予約画面へ戻る
        </button>
        <h2>スタッフ用</h2>
        {mode === 'local' && <LocalModeBanner />}
        <p className="muted">受付・当日販売・販売設定・集計・公演設定を行います。パスコードを入力してください。</p>
        <form
          onSubmit={async (e) => {
            e.preventDefault()
            setChecking(true)
            try {
              if (await staffUnlock(passcode)) {
                saveStaffSession(passcode)
                setSessionPasscode(passcode)
                setUnlocked(true)
                setPassError('')
              } else {
                // 失敗時は入力をクリアして打ち直しやすくする
                setPasscode('')
                setPassError('パスコードが違います')
              }
            } catch {
              setPasscode('')
              setPassError('確認に失敗しました。しばらくしてからお試しください')
            } finally {
              setChecking(false)
            }
          }}
        >
          <label className="field">
            <span>パスコード</span>
            <input
              type="password"
              inputMode="numeric"
              value={passcode}
              onChange={(e) => setPasscode(e.target.value)}
              placeholder="パスコード"
            />
          </label>
          {passError && <p className="error-text">{passError}</p>}
          <button type="submit" className="btn btn-primary btn-block" disabled={checking}>
            {checking ? '確認中…' : '入室する'}
          </button>
        </form>
      </section>
    )
  }

  return (
    <div className="staff">
      <div className="staff-head">
        <div className="btn-row staff-head-row">
          <button type="button" className="btn btn-ghost back-btn" onClick={onExit}>
            ← 予約画面へ戻る
          </button>
          <button
            type="button"
            className="btn btn-ghost"
            data-staff-logout
            onClick={handleLogout}
          >
            ログアウト
          </button>
        </div>
        {mode === 'cloud' ? (
          <p className="prototype-note">
            クラウド同期中：データはスタッフ全員の端末で共有されます
          </p>
        ) : (
          <LocalModeBanner />
        )}
        {sessionPasscode === DEFAULT_PASSCODE && (
          <p className="passcode-warning" data-default-passcode-warning>
            ⚠ パスコードが初期値のままです。受付情報（お客様のお名前・電話番号）を
            守るため、「公演設定」からパスコードを変更してください。
          </p>
        )}
      </div>

      <nav className="staff-tabs" aria-label="スタッフメニュー">
        {(
          [
            ['reception', '受付'],
            ['door', '当日販売'],
            ['settings', '販売設定'],
            ['summary', '集計'],
            ['perf', '公演設定'],
          ] as [StaffTab, string][]
        ).map(([key, label]) => (
          <button
            key={key}
            type="button"
            data-staff-tab={key}
            className={`staff-tab${tab === key ? ' active' : ''}`}
            onClick={() => setTab(key)}
          >
            {label}
          </button>
        ))}
      </nav>

      {tab === 'reception' && <Reception />}
      {tab === 'door' && <DoorSales />}
      {tab === 'settings' && <SeatSettings />}
      {tab === 'summary' && <Summary />}
      {tab === 'perf' && (
        <PerformanceSettings
          onPasscodeChanged={(next) => {
            setSessionPasscode(next)
            saveStaffSession(next)
          }}
        />
      )}
    </div>
  )
}

/* ---------------- 受付 ---------------- */

function Reception() {
  const { data, cancel, setCheckedIn, setPaid, completeReception } = useStore()
  const { showToast } = useToast()
  const [query, setQuery] = useState('')
  const [showCancelled, setShowCancelled] = useState(false)
  const [unpaidOnly, setUnpaidOnly] = useState(false)
  const [qrMode, setQrMode] = useState(false)
  const [confirmingCancel, setConfirmingCancel] = useState<string | null>(null)

  // 失敗はトーストでその場に出す（一覧上部の表示だとスクロール中に気づけない・R4-4）
  const runAction = (fn: () => Promise<void>) => {
    void fn().catch(() =>
      showToast('操作に失敗しました。接続を確認してもう一度お試しください'),
    )
  }

  const list = useMemo(() => {
    const q = query.trim().toLowerCase()
    const qPhone = normalizePhone(query)
    return data.reservations
      .filter((r) => showCancelled || !r.cancelled)
      .filter((r) => !unpaidOnly || (!r.paid && !r.cancelled))
      .filter(
        (r) =>
          !q ||
          r.name.toLowerCase().includes(q) ||
          r.id.toLowerCase().includes(q) ||
          // 電話番号は全角・ハイフンの有無を正規化してから部分一致させる
          (qPhone.length > 0 && normalizePhone(r.phone).includes(qPhone)),
      )
      .sort((a, b) => a.id.localeCompare(b.id))
  }, [data.reservations, query, showCancelled, unpaidOnly])

  const active = activeReservations(data)

  return (
    <section className="card">
      <h3>受付（{active.length}件の予約）</h3>
      <label className="field">
        <span>検索（名前・予約番号・電話番号）</span>
        <input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="例：山田 / SK-0001 / 090"
        />
      </label>
      <label className="check-line">
        <input
          type="checkbox"
          checked={showCancelled}
          onChange={(e) => setShowCancelled(e.target.checked)}
        />
        キャンセル済みも表示する
      </label>
      <label className="check-line">
        <input
          type="checkbox"
          data-unpaid-filter
          checked={unpaidOnly}
          onChange={(e) => setUnpaidOnly(e.target.checked)}
        />
        未払いのみ表示
      </label>
      <div className="btn-row">
        <button
          type="button"
          className="btn btn-primary btn-small"
          data-qr-open
          onClick={() => setQrMode(true)}
        >
          📷 QRで受付
        </button>
        <button
          type="button"
          className="btn btn-ghost btn-small"
          data-csv-download
          onClick={() => downloadReservationsCsv(data.reservations)}
        >
          予約一覧をCSVでダウンロード
        </button>
      </div>
      {qrMode && <QrReception onClose={() => setQrMode(false)} />}
      {list.length === 0 && <p className="muted">該当する予約がありません。</p>}
      <ul className="reservation-list">
        {list.map((res) => (
          <li key={res.id} className={`reservation-item${res.cancelled ? ' is-cancelled' : ''}`}>
            <div className="reservation-main">
              <p className="reservation-title">
                <span className="reservation-code-small">{res.id}</span>
                <span className="reservation-name">{reservationDisplayName(res)}</span>
                <span className={`source-badge source-${res.source}`}>
                  {res.source === 'door' ? '当日販売' : '予約'}
                </span>
                {res.cancelled && <span className="source-badge source-cancelled">キャンセル済</span>}
              </p>
              <p className="muted small">
                {res.seatIds.map((id) => seatById(id).label).join('、')}
              </p>
              <p className="muted small">
                <span data-type-breakdown>{reservationTypeSummary(res)}</span>
                {' ／ '}電話：{res.phone || '（未入力）'} ／ 合計 {formatYen(reservationTotal(res))}
                {res.seller && (
                  <>
                    {' ／ '}販売者：<span data-seller-name>{res.seller}</span>
                  </>
                )}
                {res.note && <> ／ 備考：{res.note}</>}
              </p>
            </div>
            {!res.cancelled && (
              <div className="reservation-actions">
                {!(res.paid && res.checkedIn) && (
                  <button
                    type="button"
                    data-action="complete"
                    className="toggle-btn complete-btn"
                    onClick={() => runAction(() => completeReception(res.id))}
                  >
                    受付完了（支払い＋来場）
                  </button>
                )}
                <button
                  type="button"
                  data-action="checkin"
                  aria-pressed={res.checkedIn}
                  className={`toggle-btn${res.checkedIn ? ' on' : ''}`}
                  onClick={() => runAction(() => setCheckedIn(res.id, !res.checkedIn))}
                >
                  {res.checkedIn ? '✓ 来場済み' : '来場チェックイン'}
                </button>
                <button
                  type="button"
                  data-action="pay"
                  aria-pressed={res.paid}
                  className={`toggle-btn${res.paid ? ' on' : ''}`}
                  onClick={() => runAction(() => setPaid(res.id, !res.paid))}
                >
                  {res.paid ? '✓ 支払い済み' : '支払い済みにする'}
                </button>
                {confirmingCancel === res.id ? (
                  <span className="cancel-confirm">
                    キャンセルしますか？
                    <button
                      type="button"
                      className="btn btn-danger btn-small"
                      onClick={() => {
                        runAction(() => cancel(res.id))
                        setConfirmingCancel(null)
                      }}
                    >
                      キャンセルする
                    </button>
                    <button
                      type="button"
                      className="btn btn-ghost btn-small"
                      onClick={() => setConfirmingCancel(null)}
                    >
                      やめる
                    </button>
                  </span>
                ) : (
                  <button
                    type="button"
                    className="btn btn-ghost btn-small"
                    onClick={() => setConfirmingCancel(res.id)}
                  >
                    予約キャンセル
                  </button>
                )}
              </div>
            )}
          </li>
        ))}
      </ul>
    </section>
  )
}

/* ---------------- 座席表の操作パネル（当日販売・販売設定で共用） ---------------- */

function SeatControls({
  floor,
  setFloor,
  zoom,
  setZoom,
  fitScale,
}: {
  floor: Floor
  setFloor: (f: Floor) => void
  zoom: SeatZoom
  setZoom: (z: SeatZoom) => void
  fitScale: number | null
}) {
  return (
    <div className="seat-controls">
      <div className="floor-tabs" role="tablist" aria-label="階の切り替え">
        {([1, 2] as Floor[]).map((f) => (
          <button
            key={f}
            type="button"
            role="tab"
            aria-selected={floor === f}
            data-floor-tab={f}
            className={`floor-tab${floor === f ? ' active' : ''}`}
            onClick={() => setFloor(f)}
          >
            {f}階席
          </button>
        ))}
      </div>
      <ZoomControls zoom={zoom} setZoom={setZoom} fitScale={fitScale} />
    </div>
  )
}

/* ---------------- 当日販売 ---------------- */

/** 前回選んだ販売者の保持先（同じ端末・同じタブの間だけ引き継ぐ） */
const LAST_SELLER_KEY = 'sakura-seats-last-seller'

function loadLastSeller(): string {
  try {
    return sessionStorage.getItem(LAST_SELLER_KEY) ?? ''
  } catch {
    return ''
  }
}

function DoorSales() {
  const { data, reserve } = useStore()
  const perf = data.performance
  const [floor, setFloor] = useState<Floor>(1)
  const [zoom, setZoom] = useState<SeatZoom>('fit')
  const [fitScale, setFitScale] = useState<number | null>(null)
  const [selected, setSelected] = useState<string[]>([])
  /** 席ごとの券種指定（未指定はデフォルト券種） */
  const [typeBySeat, setTypeBySeat] = useState<Record<string, string>>({})
  const [buyerName, setBuyerName] = useState('')
  /** 販売者（公演設定のリストから選択。前回分を初期値にする） */
  const [seller, setSeller] = useState<string>(loadLastSeller)
  const [message, setMessage] = useState('')
  const [error, setError] = useState('')

  // 設定から削除された販売者が残っていたら未選択扱いにする
  const effectiveSeller = perf.sellerNames.includes(seller) ? seller : ''

  const handleSellerChange = (next: string) => {
    setSeller(next)
    try {
      if (next) sessionStorage.setItem(LAST_SELLER_KEY, next)
      else sessionStorage.removeItem(LAST_SELLER_KEY)
    } catch {
      // 保持できなくても販売は継続する
    }
  }

  const total = selected.reduce((sum, id) => sum + priceOfSeat(perf, typeBySeat, id), 0)

  const stateOf = (seat: SeatDef): SeatVisualState => {
    if (selected.includes(seat.id)) return 'selected'
    return seatStatus(data, seat.id)
  }

  const handleTap = (seat: SeatDef) => {
    setMessage('')
    setError('')
    if (selected.includes(seat.id)) {
      setSelected(selected.filter((id) => id !== seat.id))
      return
    }
    if (seatStatus(data, seat.id) !== 'available') return
    setSelected([...selected, seat.id])
  }

  const handleSell = async () => {
    try {
      const res = await reserve({
        seats: selected.map((seatId) => ({
          seatId,
          typeId: typeBySeat[seatId] ?? defaultTicketType(perf).id,
        })),
        name: buyerName,
        phone: '',
        note: '',
        source: 'door',
        seller: effectiveSeller || undefined,
      })
      setMessage(
        `販売を記録しました（${res.id}：${res.seatIds.map((id) => seatById(id).label).join('、')} ／ ${formatYen(res.amount)}・支払済）`,
      )
      setSelected([])
      setTypeBySeat({})
      setBuyerName('')
    } catch (e) {
      setError(e instanceof Error ? e.message : '販売の記録に失敗しました')
    }
  }

  return (
    <section className="card">
      <h3>当日販売</h3>
      <p className="muted">空席をタップして選び、その場で販売済み（支払済）として記録します。</p>
      <SeatControls floor={floor} setFloor={setFloor} zoom={zoom} setZoom={setZoom} fitScale={fitScale} />
      <SeatLegend variant="staff" />
      <SeatMap floor={floor} zoom={zoom} stateOf={stateOf} onSeatTap={handleTap} onFitScale={setFitScale} onZoomChange={setZoom} />
      {selected.length > 0 && (
        <>
          <h4 className="form-subhead">席ごとの券種</h4>
          <TicketTypePicker
            perf={perf}
            seatIds={selected}
            typeBySeat={typeBySeat}
            onChange={(seatId, typeId) =>
              setTypeBySeat((prev) => ({ ...prev, [seatId]: typeId }))
            }
          />
        </>
      )}
      <label className="field">
        <span>購入者名（任意・空欄なら「当日」）</span>
        <input
          type="text"
          value={buyerName}
          onChange={(e) => setBuyerName(e.target.value)}
          placeholder="例：当日券・鈴木様"
        />
      </label>
      {perf.sellerNames.length > 0 && (
        <label className="field">
          <span>販売者（手売りの精算用・任意）</span>
          <select
            data-seller-select
            value={effectiveSeller}
            onChange={(e) => handleSellerChange(e.target.value)}
          >
            <option value="">未選択（記録しない）</option>
            {perf.sellerNames.map((name) => (
              <option key={name} value={name}>
                {name}
              </option>
            ))}
          </select>
        </label>
      )}
      <p className="selection-total" data-door-total>
        選択中：{selected.length}席 ／ 合計 {formatYen(total)}
      </p>
      {message && <p className="success-text">{message}</p>}
      {error && <p className="error-text">{error}</p>}
      <button
        type="button"
        className="btn btn-primary btn-block"
        disabled={selected.length === 0}
        onClick={handleSell}
      >
        販売を確定する（支払済として記録）
      </button>
    </section>
  )
}

/* ---------------- 販売設定 ---------------- */

function SeatSettings() {
  const { data, toggleBlocked, setBlockedForSeats } = useStore()
  const { showToast } = useToast()
  const [floor, setFloor] = useState<Floor>(1)
  const [zoom, setZoom] = useState<SeatZoom>('fit')
  const [fitScale, setFitScale] = useState<number | null>(null)
  /** 占有席タップ時の理由表示（一時的に出す） */
  const [notice, setNotice] = useState('')

  const stateOf = (seat: SeatDef): SeatVisualState => seatStatus(data, seat.id)

  // 失敗を無言にしない（R4-4）: 切替系の失敗はすべてトーストで知らせる
  const runToggle = (fn: () => Promise<void>) => {
    void fn().catch(() =>
      showToast('販売設定の変更に失敗しました。接続を確認してもう一度お試しください'),
    )
  }

  const handleTap = (seat: SeatDef) => {
    const status = seatStatus(data, seat.id)
    if (status === 'reserved' || status === 'paid') {
      // 無反応に見えないよう、切り替えできない理由を一時表示する
      setNotice('予約済みのため変更できません')
      return
    }
    setNotice('')
    runToggle(() => toggleBlocked(seat.id))
  }

  // 理由表示は数秒で自動的に消す
  useEffect(() => {
    if (!notice) return
    const t = setTimeout(() => setNotice(''), 3500)
    return () => clearTimeout(t)
  }, [notice])

  const groups: { label: string; seatIds: string[] }[] = [
    ...[1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16].map((row) => ({
      label: `1階 ${row}列`,
      seatIds: seatIdsOfRow(1, row),
    })),
    { label: '車椅子席', seatIds: WHEELCHAIR_SEATS.map((s) => s.id) },
    { label: '親子室', seatIds: PARENT_ROOM_SEATS.map((s) => s.id) },
    ...[21, 22, 23].map((row) => ({ label: `2階 ${row}列`, seatIds: seatIdsOfRow(2, row) })),
    { label: '2階 L席', seatIds: SIDE_L_SEATS.map((s) => s.id) },
    { label: '2階 R席', seatIds: SIDE_R_SEATS.map((s) => s.id) },
  ]

  return (
    <section className="card">
      <h3>販売設定</h3>
      <p className="muted">
        「販売しない」席をタップで切り替えます（関係者席・使用しない席など）。
        予約が入っている席は切り替えできません。デフォルトは全席販売です。
      </p>
      <SeatControls floor={floor} setFloor={setFloor} zoom={zoom} setZoom={setZoom} fitScale={fitScale} />
      <SeatLegend variant="staff" />
      {notice && (
        <p className="seat-settings-notice" data-seat-notice role="status">
          {notice}
        </p>
      )}
      <SeatMap floor={floor} zoom={zoom} stateOf={stateOf} onSeatTap={handleTap} onFitScale={setFitScale} onZoomChange={setZoom} />
      <h4>列ごとの一括切替</h4>
      <ul className="row-toggle-list">
        {groups.map((group) => {
          const blockedCount = group.seatIds.filter(
            (id) => seatStatus(data, id) === 'blocked',
          ).length
          return (
            <li key={group.label} className="row-toggle-item">
              <span>
                {group.label}
                <span className="muted small">
                  （販売しない {blockedCount}/{group.seatIds.length}席）
                </span>
              </span>
              <span className="row-toggle-btns">
                <button
                  type="button"
                  className="btn btn-ghost btn-small"
                  data-row-block={group.label}
                  onClick={() => runToggle(() => setBlockedForSeats(group.seatIds, true))}
                >
                  全て販売しない
                </button>
                <button
                  type="button"
                  className="btn btn-ghost btn-small"
                  data-row-sell={group.label}
                  onClick={() => runToggle(() => setBlockedForSeats(group.seatIds, false))}
                >
                  全て販売する
                </button>
              </span>
            </li>
          )
        })}
      </ul>
    </section>
  )
}

/* ---------------- 集計 ---------------- */

function Summary() {
  const { data } = useStore()
  const t = totals(data, ALL_SEAT_IDS)
  const printList = activeReservations(data)
    .slice()
    .sort((a, b) => a.id.localeCompare(b.id))
  return (
    <section className="card">
      <h3>集計</h3>
      <div className="btn-row no-print">
        <button
          type="button"
          className="btn btn-ghost btn-small"
          data-print-summary
          onClick={() => window.print()}
        >
          🖨 予約一覧と集計表を印刷
        </button>
        <button
          type="button"
          className="btn btn-ghost btn-small"
          data-csv-download
          onClick={() => downloadReservationsCsv(data.reservations)}
        >
          予約一覧をCSVでダウンロード
        </button>
      </div>
      <div className="print-sheet" aria-hidden="true">
        <h2>
          {data.performance.name} ― 予約一覧・集計表
        </h2>
        <p>
          予約 {t.reservationCount}件 ／ 支払済 {t.paidSeatCount}席 ／ 売上 {formatYen(t.salesTotal)}
          ／ 未払い {formatYen(t.unpaidTotal)}（{t.reservedSeatCount}席分） ／ 残席 {t.availableSeatCount}席
        </p>
        <table>
          <thead>
            <tr>
              <th>予約番号</th>
              <th>名前</th>
              <th>電話</th>
              <th>席</th>
              <th>券種内訳</th>
              <th>金額</th>
              <th>支払い</th>
              <th>来場</th>
              <th>種別</th>
            </tr>
          </thead>
          <tbody>
            {printList.map((r) => (
              <tr key={r.id}>
                <td>{r.id}</td>
                <td>{r.name}</td>
                <td>{r.phone}</td>
                <td>{r.seatIds.map((id) => seatById(id).label).join('、')}</td>
                <td>{reservationTypeSummary(r)}</td>
                <td>{formatYen(r.amount)}</td>
                <td>{r.paid ? '支払済' : '未払い'}</td>
                <td>{r.checkedIn ? '来場済' : ''}</td>
                <td>{r.source === 'door' ? '当日販売' : '予約'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="summary-grid">
        <div className="summary-item">
          <span className="summary-value" data-summary="reservationCount">
            {t.reservationCount}件
          </span>
          <span className="summary-label">予約数（当日販売含む）</span>
        </div>
        <div className="summary-item">
          <span className="summary-value" data-summary="paidSeatCount">
            {t.paidSeatCount}席
          </span>
          <span className="summary-label">支払済数</span>
        </div>
        <div className="summary-item">
          <span className="summary-value" data-summary="salesTotal">
            {formatYen(t.salesTotal)}
          </span>
          <span className="summary-label">売上（支払済合計）</span>
        </div>
        <div className="summary-item">
          <span className="summary-value" data-summary="unpaidTotal">
            {formatYen(t.unpaidTotal)}
          </span>
          <span className="summary-label">未払い合計（{t.reservedSeatCount}席分）</span>
        </div>
        <div className="summary-item">
          <span className="summary-value" data-summary="availableSeatCount">
            {t.availableSeatCount}席
          </span>
          <span className="summary-label">残席（販売中）</span>
        </div>
        <div className="summary-item">
          <span className="summary-value" data-summary="blockedSeatCount">
            {t.blockedSeatCount}席
          </span>
          <span className="summary-label">販売しない席</span>
        </div>
      </div>
      <h4>券種別内訳</h4>
      <table className="type-table">
        <thead>
          <tr>
            <th>券種</th>
            <th>未払い席数</th>
            <th>支払済席数</th>
            <th>売上</th>
          </tr>
        </thead>
        <tbody>
          {t.byType.map((row) => (
            <tr key={row.typeName} data-type-row={row.typeName}>
              <td>{row.typeName}</td>
              <td data-type-cell="reserved">{row.reservedSeatCount}席</td>
              <td data-type-cell="paid">{row.paidSeatCount}席</td>
              <td data-type-cell="sales">{formatYen(row.salesTotal)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {t.bySeller.length > 0 && (
        <>
          <h4>販売者別内訳（手売り・当日販売）</h4>
          <table className="type-table">
            <thead>
              <tr>
                <th>販売者</th>
                <th>席数</th>
                <th>金額</th>
              </tr>
            </thead>
            <tbody>
              {t.bySeller.map((row) => (
                <tr key={row.seller} data-seller-row={row.seller}>
                  <td>{row.seller}</td>
                  <td data-seller-cell="seats">{row.seatCount}席</td>
                  <td data-seller-cell="amount">{formatYen(row.amount)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="muted small">
            販売者が記録された予約だけを集計しています（キャンセル済みは除く）。
            団員ごとの集金確認に使ってください。
          </p>
        </>
      )}
      <p className="muted small">
        チェックイン状況は「受付」タブで確認できます。金額は各予約に記録された金額
        （予約時点の券種ごとの料金の合計）で集計しています。後から公演設定の料金を
        変更しても、記録済みの売上は変わりません。「未払い席数」は未払い（予約中）の席数です。
      </p>
    </section>
  )
}

/* ---------------- 公演設定 ---------------- */

interface TypeDraft {
  id: string
  name: string
  price: string
}

function PerformanceSettings({
  onPasscodeChanged,
}: {
  onPasscodeChanged?: (next: string) => void
}) {
  const { data, mode, saveSettings, resetAll, changePasscode } = useStore()
  const { showToast } = useToast()
  const perf = data.performance
  const [name, setName] = useState(perf.name)
  const [date, setDate] = useState(perf.date)
  const [time, setTime] = useState(perf.time)
  const [doorsOpen, setDoorsOpen] = useState(perf.doorsOpen)
  /** 販売者名リストの編集中の値（保存時に正規化する） */
  const [sellers, setSellers] = useState<string[]>(perf.sellerNames)
  const [deadline, setDeadline] = useState(data.bookingDeadline ? data.bookingDeadline.slice(0, 16) : '')
  const [types, setTypes] = useState<TypeDraft[]>(
    perf.ticketTypes.map((t) => ({ id: t.id, name: t.name, price: String(t.price) })),
  )
  const [priceNote, setPriceNote] = useState(perf.priceNote)
  const [note, setNote] = useState(perf.note)
  const [error, setError] = useState('')
  const [saved, setSaved] = useState('')
  const [confirmingReset, setConfirmingReset] = useState(false)
  const [confirmingTypeDelete, setConfirmingTypeDelete] = useState<string | null>(null)
  const [typeSeq, setTypeSeq] = useState(0)

  const touch = () => setSaved('')

  const addType = () => {
    const next = typeSeq + 1
    setTypeSeq(next)
    setTypes((prev) => [
      ...prev,
      { id: `type-${Date.now().toString(36)}-${next}`, name: '', price: '0' },
    ])
    touch()
  }

  const updateType = (id: string, patch: Partial<TypeDraft>) => {
    setTypes((prev) => prev.map((t) => (t.id === id ? { ...t, ...patch } : t)))
    touch()
  }

  const deleteType = (id: string) => {
    setTypes((prev) => prev.filter((t) => t.id !== id))
    setConfirmingTypeDelete(null)
    touch()
  }

  const handleSave = async (e: FormEvent) => {
    e.preventDefault()
    // 保存エラーはフォーム内表示に加えてトーストでも出す（画面外でも気づけるように）
    const fail = (message: string) => {
      setError(message)
      showToast(message)
    }
    if (!name.trim()) {
      fail('公演名を入力してください')
      return
    }
    if (!date || !time) {
      fail('日付と開演時刻を入力してください')
      return
    }
    if (!doorsOpen) {
      fail('開場時刻を入力してください')
      return
    }
    // 開場が開演と同じ・後になる設定は保存させない（R4-5）
    if (!doorsOpenBeforeStart(doorsOpen, time)) {
      fail('開場時刻は開演時刻より前にしてください')
      return
    }
    if (types.length === 0) {
      fail('券種は1つ以上必要です')
      return
    }
    const names = types.map((t) => t.name.trim())
    if (names.some((n) => !n)) {
      fail('券種名を入力してください')
      return
    }
    if (new Set(names).size !== names.length) {
      fail('券種名が重複しています')
      return
    }
    const ticketTypes: TicketType[] = []
    for (const draft of types) {
      const priceNum = Number(draft.price)
      if (!Number.isInteger(priceNum) || priceNum < 0) {
        fail('券種の料金は0以上の整数で入力してください')
        return
      }
      ticketTypes.push({ id: draft.id, name: draft.name.trim(), price: priceNum })
    }
    const next: Performance = {
      name: name.trim(),
      date,
      time,
      doorsOpen,
      ticketTypes,
      priceNote: priceNote.trim(),
      note: note.trim(),
      sellerNames: normalizeSellerNames(sellers),
    }
    try {
      await saveSettings(next, deadline ? deadline : null)
      setError('')
      setSaved('公演設定を保存しました')
    } catch {
      fail('保存に失敗しました。接続を確認してもう一度お試しください')
    }
  }

  return (
    <section className="card">
      <h3>公演設定</h3>
      <p className="muted">
        公演は1回のみです。公演名・日時・券種（大人・子供などの料金種別）・メモを編集できます。
        券種の変更は新しい予約から反映され、記録済みの予約の券種名・料金は変わりません。
      </p>
      <form onSubmit={handleSave}>
        <label className="field">
          <span>公演名</span>
          <input
            type="text"
            value={name}
            onChange={(e) => {
              setName(e.target.value)
              touch()
            }}
          />
        </label>
        <div className="field-row">
          <label className="field">
            <span>日付</span>
            <input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
          </label>
          <label className="field">
            <span>開場時刻</span>
            <input
              type="time"
              data-doors-open
              value={doorsOpen}
              onChange={(e) => {
                setDoorsOpen(e.target.value)
                touch()
              }}
            />
          </label>
          <label className="field">
            <span>開演時刻</span>
            <input type="time" value={time} onChange={(e) => setTime(e.target.value)} />
          </label>
        </div>
        <div className="field">
          <span className="field-label">券種と料金（先頭がデフォルト券種）</span>
          {types.map((draft) => (
            <div key={draft.id} className="type-editor-row" data-type-editor-row={draft.id}>
              <input
                type="text"
                aria-label="券種名"
                placeholder="例：大人"
                value={draft.name}
                onChange={(e) => updateType(draft.id, { name: e.target.value })}
              />
              <span className="type-editor-price">
                <input
                  type="number"
                  aria-label="料金（円）"
                  min={0}
                  step={100}
                  value={draft.price}
                  onChange={(e) => updateType(draft.id, { price: e.target.value })}
                />
                <span className="yen-unit">円</span>
              </span>
              {confirmingTypeDelete === draft.id ? (
                <span className="cancel-confirm">
                  <button
                    type="button"
                    className="btn btn-danger btn-small"
                    data-type-delete-confirm={draft.id}
                    onClick={() => deleteType(draft.id)}
                  >
                    削除する
                  </button>
                  <button
                    type="button"
                    className="btn btn-ghost btn-small"
                    onClick={() => setConfirmingTypeDelete(null)}
                  >
                    やめる
                  </button>
                </span>
              ) : (
                <button
                  type="button"
                  className="btn btn-ghost btn-small"
                  data-type-delete={draft.id}
                  disabled={types.length <= 1}
                  onClick={() => setConfirmingTypeDelete(draft.id)}
                >
                  削除
                </button>
              )}
            </div>
          ))}
          {confirmingTypeDelete && (
            <p className="muted small">
              ※券種を削除しても、すでに記録された予約の券種名・料金・合計はそのまま残ります
              （新しい予約でこの券種が選べなくなるだけです）。
            </p>
          )}
          <button type="button" className="btn btn-ghost btn-small" onClick={addType}>
            ＋ 券種を追加
          </button>
        </div>
        <div className="field">
          <span className="field-label">販売者（手売り・当日販売で記録する担当者）</span>
          {sellers.map((sellerName, i) => (
            <div key={i} className="type-editor-row" data-seller-editor-row>
              <input
                type="text"
                aria-label="販売者名"
                placeholder="例：田中"
                value={sellerName}
                onChange={(e) => {
                  const next = [...sellers]
                  next[i] = e.target.value
                  setSellers(next)
                  touch()
                }}
              />
              <button
                type="button"
                className="btn btn-ghost btn-small"
                onClick={() => {
                  setSellers(sellers.filter((_, j) => j !== i))
                  touch()
                }}
              >
                削除
              </button>
            </div>
          ))}
          <button
            type="button"
            className="btn btn-ghost btn-small"
            data-seller-add
            onClick={() => {
              setSellers([...sellers, ''])
              touch()
            }}
          >
            ＋ 販売者を追加
          </button>
          <p className="muted small">
            当日販売のときに販売者を選ぶと、予約と集計（販売者別内訳）に記録されます。
            空欄の行は保存時に取り除かれます。
          </p>
        </div>
        <label className="field">
          <span>料金注記（お客様画面の券種選択付近に表示されます）</span>
          <input
            type="text"
            value={priceNote}
            onChange={(e) => setPriceNote(e.target.value)}
            placeholder="例：子供料金は小学生以下が対象です"
          />
        </label>
        <label className="field">
          <span>メモ（お客様画面にも表示されます）</span>
          <textarea value={note} onChange={(e) => setNote(e.target.value)} rows={2} />
        </label>
        <label className="field">
          <span>予約締切（空欄なら締切なし・過ぎるとオンライン予約を受付終了にします）</span>
          <input
            type="datetime-local"
            data-booking-deadline
            value={deadline}
            onChange={(e) => {
              setDeadline(e.target.value)
              touch()
            }}
          />
        </label>
        {error && <p className="error-text">{error}</p>}
        {saved && <p className="success-text">{saved}</p>}
        <button type="submit" className="btn btn-primary btn-block">
          保存する
        </button>
      </form>
      <hr className="divider" />
      <PasscodeSettings changePasscode={changePasscode} onChanged={onPasscodeChanged} />
      {mode === 'local' && (
        <>
          <hr className="divider" />
          <h4>試作データ</h4>
      <p className="muted small">
        予約・販売設定をすべて消して、初期状態（サンプル公演のみ・予約なし）に戻します。
      </p>
      {confirmingReset ? (
        <span className="row-toggle-btns">
          <button
            type="button"
            className="btn btn-danger btn-small"
            onClick={() => {
              resetAll()
              setConfirmingReset(false)
            }}
          >
            本当に初期化する
          </button>
          <button
            type="button"
            className="btn btn-ghost btn-small"
            onClick={() => setConfirmingReset(false)}
          >
            やめる
          </button>
        </span>
      ) : (
        <button
          type="button"
          className="btn btn-ghost btn-small"
          onClick={() => setConfirmingReset(true)}
        >
          試作データを初期化
        </button>
      )}
        </>
      )}
    </section>
  )
}

function PasscodeSettings({
  changePasscode,
  onChanged,
}: {
  changePasscode: (newPasscode: string) => Promise<void>
  onChanged?: (next: string) => void
}) {
  const [next, setNext] = useState('')
  const [message, setMessage] = useState('')
  const [error, setError] = useState('')

  const handleChange = async (e: FormEvent) => {
    e.preventDefault()
    setMessage('')
    setError('')
    if (!next.trim()) {
      setError('新しいパスコードを入力してください')
      return
    }
    try {
      await changePasscode(next.trim())
      onChanged?.(next.trim())
      setNext('')
      setMessage('パスコードを変更しました')
    } catch {
      setError('パスコードの変更に失敗しました')
    }
  }

  return (
    <>
      <h4>スタッフパスコード</h4>
      <form onSubmit={handleChange}>
        <label className="field">
          <span>新しいパスコード</span>
          <input
            type="password"
            inputMode="numeric"
            autoComplete="off"
            value={next}
            onChange={(e) => setNext(e.target.value)}
            placeholder="例：5678"
          />
        </label>
        {error && <p className="error-text">{error}</p>}
        {message && <p className="success-text">{message}</p>}
        <button type="submit" className="btn btn-ghost btn-small">
          パスコードを変更する
        </button>
      </form>
    </>
  )
}
