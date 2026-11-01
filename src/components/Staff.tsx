import { useMemo, useState } from 'react'
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
  formatYen,
  reservationTotal,
  seatStatus,
  totals,
  type Performance,
} from '../lib/logic'
import { useStore } from '../lib/store'
import SeatMap, { SeatLegend, type SeatVisualState } from './SeatMap'

const STAFF_PASSCODE = '1234'
type StaffTab = 'reception' | 'door' | 'settings' | 'summary' | 'perf'
const ZOOMS = [1, 1.25, 1.5]
const ALL_SEAT_IDS = ALL_SEATS.map((s) => s.id)

export default function Staff({ onExit }: { onExit: () => void }) {
  const [unlocked, setUnlocked] = useState(false)
  const [passcode, setPasscode] = useState('')
  const [passError, setPassError] = useState('')
  const [tab, setTab] = useState<StaffTab>('reception')

  if (!unlocked) {
    return (
      <section className="card staff-login">
        <button type="button" className="btn btn-ghost back-btn" onClick={onExit}>
          ← 予約画面へ戻る
        </button>
        <h2>スタッフ用</h2>
        <p className="muted">受付・当日販売・販売設定・集計・公演設定を行います。パスコードを入力してください。</p>
        <form
          onSubmit={(e) => {
            e.preventDefault()
            if (passcode === STAFF_PASSCODE) {
              setUnlocked(true)
              setPassError('')
            } else {
              setPassError('パスコードが違います')
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
          <button type="submit" className="btn btn-primary btn-block">
            入室する
          </button>
        </form>
        <p className="muted small">試作版のパスコードは 1234 です（READMEにも記載）。</p>
      </section>
    )
  }

  return (
    <div className="staff">
      <div className="staff-head">
        <button type="button" className="btn btn-ghost back-btn" onClick={onExit}>
          ← 予約画面へ戻る
        </button>
        <p className="prototype-note">
          試作版：データはこの端末内のみに保存されます（複数端末の同期は本番フェーズ）
        </p>
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
      {tab === 'perf' && <PerformanceSettings />}
    </div>
  )
}

/* ---------------- 受付 ---------------- */

function Reception() {
  const { data, cancel, setCheckedIn, setPaid } = useStore()
  const [query, setQuery] = useState('')
  const [showCancelled, setShowCancelled] = useState(false)
  const [confirmingCancel, setConfirmingCancel] = useState<string | null>(null)

  const list = useMemo(() => {
    const q = query.trim().toLowerCase()
    return data.reservations
      .filter((r) => showCancelled || !r.cancelled)
      .filter(
        (r) =>
          !q ||
          r.name.toLowerCase().includes(q) ||
          r.id.toLowerCase().includes(q) ||
          r.phone.replace(/-/g, '').includes(q.replace(/-/g, '')),
      )
      .sort((a, b) => a.id.localeCompare(b.id))
  }, [data.reservations, query, showCancelled])

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
      {list.length === 0 && <p className="muted">該当する予約がありません。</p>}
      <ul className="reservation-list">
        {list.map((res) => (
          <li key={res.id} className={`reservation-item${res.cancelled ? ' is-cancelled' : ''}`}>
            <div className="reservation-main">
              <p className="reservation-title">
                <span className="reservation-code-small">{res.id}</span>
                <span className="reservation-name">{res.name} 様</span>
                <span className={`source-badge source-${res.source}`}>
                  {res.source === 'door' ? '当日販売' : '予約'}
                </span>
                {res.cancelled && <span className="source-badge source-cancelled">キャンセル済</span>}
              </p>
              <p className="muted small">
                {res.seatIds.map((id) => seatById(id).label).join('、')}
              </p>
              <p className="muted small">
                電話：{res.phone || '（未入力）'} ／ 合計 {formatYen(reservationTotal(res))}
                {res.note && <> ／ 備考：{res.note}</>}
              </p>
            </div>
            {!res.cancelled && (
              <div className="reservation-actions">
                <button
                  type="button"
                  data-action="checkin"
                  aria-pressed={res.checkedIn}
                  className={`toggle-btn${res.checkedIn ? ' on' : ''}`}
                  onClick={() => setCheckedIn(res.id, !res.checkedIn)}
                >
                  {res.checkedIn ? '✓ 来場済み' : '来場チェックイン'}
                </button>
                <button
                  type="button"
                  data-action="pay"
                  aria-pressed={res.paid}
                  className={`toggle-btn${res.paid ? ' on' : ''}`}
                  onClick={() => setPaid(res.id, !res.paid)}
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
                        cancel(res.id)
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
}: {
  floor: Floor
  setFloor: (f: Floor) => void
  zoom: number
  setZoom: (z: number) => void
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
      <div className="zoom-controls" aria-label="座席表の拡大縮小">
        {ZOOMS.map((z) => (
          <button
            key={z}
            type="button"
            data-zoom={z}
            className={`zoom-btn${zoom === z ? ' active' : ''}`}
            onClick={() => setZoom(z)}
          >
            {Math.round(z * 100)}%
          </button>
        ))}
      </div>
    </div>
  )
}

/* ---------------- 当日販売 ---------------- */

function DoorSales() {
  const { data, reserve } = useStore()
  const perf = data.performance
  const [floor, setFloor] = useState<Floor>(1)
  const [zoom, setZoom] = useState(1)
  const [selected, setSelected] = useState<string[]>([])
  const [buyerName, setBuyerName] = useState('')
  const [message, setMessage] = useState('')
  const [error, setError] = useState('')

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

  const handleSell = () => {
    try {
      const res = reserve({
        seatIds: selected,
        name: buyerName,
        phone: '',
        note: '',
        source: 'door',
      })
      setMessage(
        `販売を記録しました（${res.id}：${res.seatIds.map((id) => seatById(id).label).join('、')} ／ ${formatYen(res.amount)}・支払済）`,
      )
      setSelected([])
      setBuyerName('')
    } catch (e) {
      setError(e instanceof Error ? e.message : '販売の記録に失敗しました')
    }
  }

  return (
    <section className="card">
      <h3>当日販売</h3>
      <p className="muted">空席をタップして選び、その場で販売済み（支払済）として記録します。</p>
      <SeatControls floor={floor} setFloor={setFloor} zoom={zoom} setZoom={setZoom} />
      <SeatLegend />
      <SeatMap floor={floor} zoom={zoom} stateOf={stateOf} onSeatTap={handleTap} />
      <label className="field">
        <span>購入者名（任意・空欄なら「当日」）</span>
        <input
          type="text"
          value={buyerName}
          onChange={(e) => setBuyerName(e.target.value)}
          placeholder="例：当日券・鈴木様"
        />
      </label>
      <p className="selection-total">
        選択中：{selected.length}席 ／ 合計 {formatYen(selected.length * perf.price)}
      </p>
      {selected.length > 0 && (
        <p className="muted small">{selected.map((id) => seatById(id).label).join('、')}</p>
      )}
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
  const [floor, setFloor] = useState<Floor>(1)
  const [zoom, setZoom] = useState(1)

  const stateOf = (seat: SeatDef): SeatVisualState => seatStatus(data, seat.id)

  const handleTap = (seat: SeatDef) => {
    const status = seatStatus(data, seat.id)
    if (status === 'reserved' || status === 'paid') return
    toggleBlocked(seat.id)
  }

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
      <SeatControls floor={floor} setFloor={setFloor} zoom={zoom} setZoom={setZoom} />
      <SeatLegend />
      <SeatMap floor={floor} zoom={zoom} stateOf={stateOf} onSeatTap={handleTap} />
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
                  onClick={() => setBlockedForSeats(group.seatIds, true)}
                >
                  全て販売しない
                </button>
                <button
                  type="button"
                  className="btn btn-ghost btn-small"
                  data-row-sell={group.label}
                  onClick={() => setBlockedForSeats(group.seatIds, false)}
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
  return (
    <section className="card">
      <h3>集計</h3>
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
      <p className="muted small">
        チェックイン状況は「受付」タブで確認できます。金額は各予約に記録された金額（公演単価{' '}
        {formatYen(data.performance.price)} × 席数）で集計しています。
      </p>
    </section>
  )
}

/* ---------------- 公演設定 ---------------- */

function PerformanceSettings() {
  const { data, updatePerformance, resetAll } = useStore()
  const perf = data.performance
  const [name, setName] = useState(perf.name)
  const [date, setDate] = useState(perf.date)
  const [time, setTime] = useState(perf.time)
  const [price, setPrice] = useState(String(perf.price))
  const [note, setNote] = useState(perf.note)
  const [error, setError] = useState('')
  const [saved, setSaved] = useState('')
  const [confirmingReset, setConfirmingReset] = useState(false)

  return (
    <section className="card">
      <h3>公演設定</h3>
      <p className="muted">公演は1回のみです。公演名・日時・料金・メモを編集できます。</p>
      <form
        onSubmit={(e) => {
          e.preventDefault()
          const priceNum = Number(price)
          if (!name.trim()) {
            setError('公演名を入力してください')
            return
          }
          if (!date || !time) {
            setError('日付と開演時刻を入力してください')
            return
          }
          if (!Number.isInteger(priceNum) || priceNum < 0) {
            setError('料金は0以上の整数で入力してください')
            return
          }
          const next: Performance = {
            name: name.trim(),
            date,
            time,
            price: priceNum,
            note: note.trim(),
          }
          updatePerformance(next)
          setError('')
          setSaved('公演設定を保存しました')
        }}
      >
        <label className="field">
          <span>公演名</span>
          <input
            type="text"
            value={name}
            onChange={(e) => {
              setName(e.target.value)
              setSaved('')
            }}
          />
        </label>
        <div className="field-row">
          <label className="field">
            <span>日付</span>
            <input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
          </label>
          <label className="field">
            <span>開演時刻</span>
            <input type="time" value={time} onChange={(e) => setTime(e.target.value)} />
          </label>
          <label className="field">
            <span>料金（1席・円）</span>
            <input
              type="number"
              min={0}
              step={100}
              value={price}
              onChange={(e) => setPrice(e.target.value)}
            />
          </label>
        </div>
        <label className="field">
          <span>メモ（お客様画面にも表示されます）</span>
          <textarea value={note} onChange={(e) => setNote(e.target.value)} rows={2} />
        </label>
        {error && <p className="error-text">{error}</p>}
        {saved && <p className="success-text">{saved}</p>}
        <button type="submit" className="btn btn-primary btn-block">
          保存する
        </button>
      </form>
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
    </section>
  )
}
