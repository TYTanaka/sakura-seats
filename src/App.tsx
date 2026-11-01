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
  loadLastReservations,
  removeLastReservation,
  LAST_RESERVATION_EVENT,
  type LastReservationSnapshot,
} from './lib/lastReservation'
import flyerUrl from './assets/flyer.webp'
import AudienceBook from './components/AudienceBook'
import Lookup from './components/Lookup'
import ReservationQr, { useReservationQrUrl } from './components/ReservationQr'
import Staff from './components/Staff'

type View = 'book' | 'lookup' | 'staff'

/**
 * 会場名はフレーズ単位でのみ改行させる（R6）: 機種幅によって
 * 「さくら / プラザ」のような文節の途中で割れないよう、2つのフレーズを
 * nowrap の inline-block で並べ、割れるならフレーズの境目だけにする。
 */
function VenueName() {
  return (
    <>
      <span className="venue-phrase">戸塚区民文化センター</span>{' '}
      <span className="venue-phrase">さくらプラザ・ホール</span>
    </>
  )
}

/**
 * 劇団ツインリーブスの双葉マーク（ポスターのロゴにある2枚の葉）。
 * タイトルの横に添える小さな装飾。装飾専用なので aria-hidden。
 */
function TwinLeavesMark() {
  return (
    <svg className="twin-leaves-mark" viewBox="0 0 48 26" aria-hidden="true" focusable="false">
      <path
        d="M22.6 23.5C14.5 22.8 6.8 17.6 4.6 6.6 15 7.4 21.4 13.6 22.6 23.5Z"
        fill="#ffffff"
      />
      <path
        d="M25.4 23.5c8.1-.7 15.8-5.9 18-16.9-10.4.8-16.8 7-18 16.9Z"
        fill="#f5c451"
      />
      <path
        d="M24 24.6c-5.5.9-10.8.4-16-1.5 5.6 2.9 11 4 16 3.4 5 .6 10.4-.5 16-3.4-5.2 1.9-10.5 2.4-16 1.5Z"
        fill="#ffffff"
        opacity="0.85"
      />
    </svg>
  )
}

/**
 * ヒーローの瞬く星（装飾のみ・ポスターの星空に合わせた控えめなきらめき）。
 * アニメーションは opacity / transform のみで、座席表の描画には影響しない。
 */
function HeroSparkles() {
  return (
    <div className="hero-sparkles" aria-hidden="true">
      <span className="sparkle sp-1">✦</span>
      <span className="sparkle sp-2 violet">✦</span>
      <span className="sparkle sp-3">✦</span>
      <span className="sparkle sp-4">✦</span>
      <span className="sparkle sp-5 violet">✦</span>
      <span className="sparkle sp-6">✦</span>
      <span className="sparkle sp-7">✦</span>
    </div>
  )
}

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
      <HeroSparkles />
      <div className="hero-content">
        <div className="header-top">
          <p className="venue-line">
            <VenueName />
          </p>
          <div className="header-actions">
            <button type="button" className="staff-link" onClick={onLookup}>
              予約確認
            </button>
            <button type="button" className="staff-link" onClick={onStaff}>
              スタッフ用
            </button>
          </div>
        </div>
        <h1 className="site-title">
          <TwinLeavesMark />
          {perf.name}
        </h1>
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
        <span className="today-venue">
          （<VenueName />）
        </span>
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
 * 控え1件分（R6）: QR サムネイル＋要約＋小さな「控えを消す」。
 * 消去は誤操作防止のため2段階にする: 小さなテキストボタンを押すと
 * その場が確認表示（本当に消しますか？／消す／やめる）に切り替わり、
 * 約4秒放置か他の場所のタップで自動的に元へ戻る。1回のタップでは消えない。
 */
function SavedReservationItem({
  snapshot,
  confirming,
  onArmRemove,
  onCancelRemove,
  onConfirmRemove,
}: {
  snapshot: LastReservationSnapshot
  confirming: boolean
  onArmRemove: () => void
  onCancelRemove: () => void
  onConfirmRemove: () => void
}) {
  const [qrExpanded, setQrExpanded] = useState(false)
  const qrUrl = useReservationQrUrl(snapshot.code)
  return (
    <article className="last-res-item" data-last-reservation-item={snapshot.code}>
      <div className="last-res-main">
        <button
          type="button"
          className="last-res-qr-toggle"
          data-last-reservation-qr-toggle
          aria-expanded={qrExpanded}
          onClick={() => setQrExpanded((v) => !v)}
        >
          {qrUrl ? (
            <img
              src={qrUrl}
              alt={`予約番号 ${snapshot.code} のQRコード`}
              width={64}
              height={64}
            />
          ) : (
            <span className="last-res-qr-loading">QR準備中</span>
          )}
          <span className="last-res-qr-hint">{qrExpanded ? 'QRを閉じる' : 'QRを拡大'}</span>
        </button>
        <div className="last-res-summary">
          <div className="last-res-head">
            <p className="last-res-code">{snapshot.code}</p>
            {confirming ? (
              <span className="last-res-confirm" data-last-reservation-remove-area>
                <span className="last-res-confirm-text">本当に消しますか？</span>
                <button
                  type="button"
                  className="last-res-confirm-btn is-danger"
                  data-last-reservation-remove-confirm
                  onClick={onConfirmRemove}
                >
                  消す
                </button>
                <button
                  type="button"
                  className="last-res-confirm-btn"
                  onClick={onCancelRemove}
                >
                  やめる
                </button>
              </span>
            ) : (
              <button
                type="button"
                className="last-res-remove"
                data-last-reservation-remove
                onClick={onArmRemove}
              >
                控えを消す
              </button>
            )}
          </div>
          <p className="last-res-line">
            {snapshot.performanceName} ／ {snapshot.whenText}
          </p>
          <p className="last-res-line">座席：{snapshot.seatLabels.join('、')}</p>
          <p className="last-res-line">合計：{formatYen(snapshot.amount)}</p>
        </div>
      </div>
      {qrExpanded && <ReservationQr code={snapshot.code} />}
    </article>
  )
}

/**
 * 「この端末で予約した控え」一覧（R4・F3 のリスト化 / R6）: この端末で
 * 完了した予約の控えを新しい順に並べる。完了画面がリロードで消えても、
 * ここから予約番号・座席・QRを再表示できる。1人で2回以上買っても
 * 前の控えは消えない（保持上限つき）。
 * 最新の状態（支払い・キャンセル等）はスナップショットでは分からないため、
 * 予約確認への導線を併記する。
 * 各カードは QR を小さなサムネイルで出すコンパクト表示にし（R5-3: 当日の
 * カード積み重なりで座席表が遠くならないように）、タップでその場に
 * 大きな QR を展開する。完了画面の QR は従来どおり大きいまま。
 */
function SavedReservations({ onLookup }: { onLookup: () => void }) {
  const [items, setItems] = useState<LastReservationSnapshot[]>(loadLastReservations)
  const [confirmingCode, setConfirmingCode] = useState<string | null>(null)
  // 予約完了（保存）・削除のたびに読み直す
  useEffect(() => {
    const update = () => setItems(loadLastReservations())
    window.addEventListener(LAST_RESERVATION_EVENT, update)
    return () => window.removeEventListener(LAST_RESERVATION_EVENT, update)
  }, [])
  // 消去の確認表示は約4秒で自動的に戻す＋他の場所をタップしても戻す
  useEffect(() => {
    if (!confirmingCode) return
    const timer = window.setTimeout(() => setConfirmingCode(null), 4000)
    const onPointerDown = (e: PointerEvent) => {
      const target = e.target as Element | null
      if (
        target?.closest('[data-last-reservation-remove-area]') ||
        target?.closest('[data-last-reservation-remove]')
      ) {
        return
      }
      setConfirmingCode(null)
    }
    document.addEventListener('pointerdown', onPointerDown)
    return () => {
      window.clearTimeout(timer)
      document.removeEventListener('pointerdown', onPointerDown)
    }
  }, [confirmingCode])
  if (items.length === 0) return null
  return (
    <section className="card last-reservation-card" data-last-reservation>
      <h3>この端末で予約した控え</h3>
      {items.map((snapshot) => (
        <SavedReservationItem
          key={snapshot.code}
          snapshot={snapshot}
          confirming={confirmingCode === snapshot.code}
          onArmRemove={() => setConfirmingCode(snapshot.code)}
          onCancelRemove={() => setConfirmingCode(null)}
          onConfirmRemove={() => {
            removeLastReservation(snapshot.code)
            setConfirmingCode(null)
          }}
        />
      ))}
      <p className="muted small">
        最新の状態（お支払い・キャンセルの反映）は「予約確認」でご確認ください。
      </p>
      <div className="btn-row">
        <button type="button" className="btn btn-primary" onClick={onLookup}>
          予約確認で見る
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
        {view === 'book' && <SavedReservations onLookup={() => setView('lookup')} />}
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
