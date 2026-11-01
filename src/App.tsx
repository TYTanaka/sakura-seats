import { useEffect, useState } from 'react'
import { ALL_SEATS } from './data/seats'
import {
  formatMonthDayTime,
  formatPerformanceWhen,
  formatTicketTypes,
  formatYen,
  isBookingClosed,
  localDateString,
  seatStatus,
  type Performance,
} from './lib/logic'
import { StoreProvider, useStore } from './lib/store'
import { ToastProvider } from './lib/toast'
import { useNow } from './lib/useNow'
import {
  clearLastReservation,
  loadLastReservation,
  LAST_RESERVATION_EVENT,
  type LastReservationSnapshot,
} from './lib/lastReservation'
import flyerUrl from './assets/flyer.webp'
import AudienceBook from './components/AudienceBook'
import Lookup from './components/Lookup'
import ReservationQr from './components/ReservationQr'
import Staff from './components/Staff'

type View = 'book' | 'lookup' | 'staff'

/** 会場名（ヒーローと本日開演カードで共用） */
const VENUE_NAME = '戸塚区民文化センター さくらプラザ・ホール'

function TopHeader({
  perf,
  onLookup,
  onStaff,
}: {
  perf: Performance
  onLookup: () => void
  onStaff: () => void
}) {
  const { data } = useStore()
  // 締切ピルも時刻の経過に追随させる（開いたまま締切を跨いだら表示を切り替える・R4-1）
  const nowMs = useNow(10000)
  const available = ALL_SEATS.filter((s) => seatStatus(data, s.id) === 'available').length
  const bookingClosed = isBookingClosed(data, new Date(nowMs))
  const showDeadline = data.bookingDeadline !== null && !bookingClosed
  return (
    <header className="site-header">
      <img className="hero-art" src={flyerUrl} alt="" aria-hidden="true" />
      <div className="hero-overlay" aria-hidden="true" />
      <div className="hero-scrim-top" aria-hidden="true" />
      <div className="hero-content">
        <div className="header-top">
          <p className="venue-line">{VENUE_NAME}</p>
          <div className="header-actions">
            <button type="button" className="staff-link" onClick={onLookup}>
              予約確認
            </button>
            <button type="button" className="staff-link" onClick={onStaff}>
              スタッフ用
            </button>
          </div>
        </div>
        <h1 className="site-title">{perf.name}</h1>
        <p className="site-when">{formatPerformanceWhen(perf)}</p>
        <p className="site-meta">
          料金：{formatTicketTypes(perf)}（当日現金払い） ／ 空席 {available}席
        </p>
        {showDeadline && (
          <p className="site-deadline" data-booking-deadline-display>
            予約締切：{formatMonthDayTime(data.bookingDeadline!)}まで
          </p>
        )}
        {data.bookingDeadline !== null && bookingClosed && (
          <p className="site-deadline is-closed" data-booking-closed-display>
            予約受付は終了しました
          </p>
        )}
        {perf.priceNote && <p className="site-note">※{perf.priceNote}</p>}
        {perf.note && <p className="site-note">{perf.note}</p>}
      </div>
    </header>
  )
}

/**
 * 公演日が今日のときだけ出す「本日開演」案内カード。
 * 当日は座席表をなるべく早く見せたいので、1〜2行のコンパクト表示にして
 * 「座席を選ぶ」ボタンで座席表へジャンプできるようにする（R4-7 / F10）。
 */
function TodayCard({ perf }: { perf: Performance }) {
  const scrollToSeats = () => {
    document
      .getElementById('seat-picker')
      ?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }
  return (
    <section className="card today-card" data-today-card>
      <div className="today-head">
        <span className="today-badge">♪ 本日開演 ♪</span>
        <span className="today-name">{perf.name}</span>
      </div>
      <p className="today-times">
        開場 {perf.doorsOpen} ／ 開演 {perf.time}
        <span className="today-venue">（{VENUE_NAME}）</span>
      </p>
      <button
        type="button"
        className="btn today-scroll-btn"
        data-today-scroll
        onClick={scrollToSeats}
      >
        座席を選ぶ ↓
      </button>
    </section>
  )
}

/**
 * 「直前の予約」カード（R4・F3）: この端末で直近に完了した予約の控え。
 * 完了画面がリロードで消えても、ここから予約番号・座席・QRを再表示できる。
 * 最新の状態（支払い・キャンセル等）はスナップショットでは分からないため、
 * 予約確認への導線を併記する。
 */
function LastReservationCard({ onLookup }: { onLookup: () => void }) {
  const [snapshot, setSnapshot] = useState<LastReservationSnapshot | null>(loadLastReservation)
  // 予約完了（保存）・消去のたびに読み直す
  useEffect(() => {
    const update = () => setSnapshot(loadLastReservation())
    window.addEventListener(LAST_RESERVATION_EVENT, update)
    return () => window.removeEventListener(LAST_RESERVATION_EVENT, update)
  }, [])
  if (!snapshot) return null
  return (
    <section className="card last-reservation-card" data-last-reservation>
      <h3>直前の予約（この端末の控え）</h3>
      <p className="reservation-code">{snapshot.code}</p>
      <ReservationQr code={snapshot.code} />
      <dl className="detail-list">
        <div>
          <dt>公演</dt>
          <dd>
            {snapshot.performanceName}
            <br />
            {snapshot.whenText}
          </dd>
        </div>
        <div>
          <dt>座席</dt>
          <dd>{snapshot.seatLabels.join('、')}</dd>
        </div>
        <div>
          <dt>合計</dt>
          <dd className="detail-total">{formatYen(snapshot.amount)}</dd>
        </div>
      </dl>
      <p className="muted small">
        最新の状態（お支払い・キャンセルの反映）は「予約確認」でご確認ください。
      </p>
      <div className="btn-row">
        <button type="button" className="btn btn-primary" onClick={onLookup}>
          予約確認で見る
        </button>
        <button
          type="button"
          className="btn btn-ghost"
          data-last-reservation-clear
          onClick={() => {
            clearLastReservation()
            setSnapshot(null)
          }}
        >
          この表示を消す
        </button>
      </div>
    </section>
  )
}

function Shell() {
  const { data, mode, ready, loadError, retryLoad, storageWarning, syncState } = useStore()
  const [view, setView] = useState<View>('book')
  const perf = data.performance

  if (mode === 'cloud' && loadError) {
    return (
      <div className="app-shell">
        <main className="main">
          <section className="card">
            <h2>接続できませんでした</h2>
            <p className="muted">{loadError}</p>
            <button type="button" className="btn btn-primary btn-block" onClick={retryLoad}>
              再読み込みする
            </button>
          </section>
        </main>
      </div>
    )
  }

  if (mode === 'cloud' && !ready) {
    return (
      <div className="app-shell">
        <p className="loading-note">読み込み中…♪</p>
      </div>
    )
  }

  return (
    <div className="app-shell">
      {mode === 'cloud' && syncState !== 'ok' && (
        <div
          className={`sync-banner sync-${syncState}`}
          data-sync-banner={syncState}
          role="status"
        >
          {syncState === 'offline'
            ? '接続が切れています。表示内容が古い場合があります'
            : '再接続しています… 表示内容が古い場合があります'}
        </div>
      )}
      <TopHeader
        perf={perf}
        onLookup={() => setView('lookup')}
        onStaff={() => setView('staff')}
      />
      <main className="main">
        {storageWarning && (
          <p className="storage-warning" data-storage-warning role="alert">
            ⚠ {storageWarning}
          </p>
        )}
        {view === 'book' && perf.date === localDateString() && <TodayCard perf={perf} />}
        {view === 'book' && <LastReservationCard onLookup={() => setView('lookup')} />}
        {view === 'book' && <AudienceBook perf={perf} />}
        {view === 'lookup' && <Lookup onBack={() => setView('book')} />}
        {view === 'staff' && <Staff onExit={() => setView('book')} />}
      </main>
      <footer className="site-footer">
        <p>
          指定席予約 ― 座席表から席を選んで予約し、当日は受付で現金でお支払いいただきます。
        </p>
        <p className="muted small">
          {mode === 'cloud'
            ? '予約データはクラウドに保存され、スタッフ全員の端末で共有されます。'
            : 'このページは試作版です。予約データはこの端末内のみに保存されます。'}
        </p>
      </footer>
    </div>
  )
}

export default function App() {
  return (
    <StoreProvider>
      <ToastProvider>
        <Shell />
      </ToastProvider>
    </StoreProvider>
  )
}
