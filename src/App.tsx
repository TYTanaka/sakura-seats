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
  loadFoldedCodes,
  loadLastReservations,
  setReservationFolded,
  LAST_RESERVATION_EVENT,
  type LastReservationSnapshot,
} from './lib/lastReservation'
import {
  buildSnapshotCalendarUrl,
  buildSnapshotGmailUrl,
  buildSnapshotLineUrl,
} from './lib/share'
import flyerUrl from './assets/flyer.webp'
import AudienceBook from './components/AudienceBook'
import Lookup from './components/Lookup'
import ReservationQr, { useReservationQrUrl } from './components/ReservationQr'
import { encodeQrPayload } from './lib/qrToken'
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
  compact = false,
}: {
  perf: Performance
  onLookup: () => void
  onStaff: () => void
  /** スタッフ表示中は1行程度の簡略ヘッダーにする（R6・D-1） */
  compact?: boolean
}) {
  const { data } = useStore()
  // 締切ピルも時刻の経過に追随させる（開いたまま締切を跨いだら表示を切り替える・R4-1）
  const nowMs = useNow(10000)
  const available = ALL_SEATS.filter((s) => seatStatus(data, s.id) === 'available').length
  const bookingClosed = isBookingClosed(data, new Date(nowMs))
  const showDeadline = data.bookingDeadline !== null && !bookingClosed
  if (compact) {
    // スタッフは開いてすぐ受付リストを見たい。当日運用では大きな
    // お客様用ヒーローは邪魔になるため、公演名・日時だけの細い帯にする
    return (
      <header className="site-header is-compact" data-compact-header>
        <div className="compact-content">
          <p className="compact-title">
            {perf.name}
            <span className="compact-when">{formatPerformanceWhen(perf)}</span>
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
      </header>
    )
  }
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
          料金：{formatTicketTypes(perf)}（当日現金払い） ／{' '}
          <span className="meta-available">空席 {available}席</span>
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
        席の候補を見る ↓
      </button>
    </section>
  )
}

/**
 * 控え1件分: QR サムネイル＋要約＋共有ボタン（LINE / Gmail / カレンダー）。
 * 控えは削除できない（誤操作防止のため削除UI自体を廃止）。代わりに
 * 「小さくする」で1行の要約に折りたためる。折りたたみ状態は予約番号
 * ごとに端末へ保存され、リロード後も保たれる。
 * 共有リンクは完了画面と同じ文面を、この控え自身の内容で作り直す。
 * カレンダーは公演日・開演時刻を持つ控えだけに出す（旧い控えには無い）。
 */
function SavedReservationItem({ snapshot }: { snapshot: LastReservationSnapshot }) {
  const [qrExpanded, setQrExpanded] = useState(false)
  const [folded, setFolded] = useState(() => loadFoldedCodes().has(snapshot.code))
  // QR は予約番号ではなくトークンから作る（R7）。トークンの無い旧い控えは番号表示
  const qrPayload = snapshot.qrToken ? encodeQrPayload(snapshot.qrToken) : null
  const qrUrl = useReservationQrUrl(qrPayload)
  const calendarUrl = buildSnapshotCalendarUrl(snapshot)

  const toggleFolded = () => {
    const next = !folded
    setFolded(next)
    setReservationFolded(snapshot.code, next)
  }

  if (folded) {
    return (
      <article
        className="last-res-item is-folded"
        data-last-reservation-item={snapshot.code}
        data-last-reservation-folded
      >
        <div className="last-res-folded">
          <p className="last-res-folded-line">
            {snapshot.code} ／ {snapshot.performanceName} ／{' '}
            {snapshot.zoneLabel
              ? `${snapshot.zoneLabel} ${snapshot.partySize ?? ''}名`
              : `${snapshot.seatLabels.length}席`}{' '}
            ／ {formatYen(snapshot.amount)}
          </p>
          <button
            type="button"
            className="last-res-fold-toggle"
            data-last-reservation-fold-toggle
            aria-expanded={false}
            onClick={toggleFolded}
          >
            広げる
          </button>
        </div>
      </article>
    )
  }

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
          ) : qrPayload ? (
            <span className="last-res-qr-loading">QR準備中</span>
          ) : (
            <span className="last-res-qr-loading">番号で受付</span>
          )}
          <span className="last-res-qr-hint">{qrExpanded ? 'QRを閉じる' : 'QRを拡大'}</span>
        </button>
        <div className="last-res-summary">
          <div className="last-res-head">
            <p className="last-res-code">{snapshot.code}</p>
            <button
              type="button"
              className="last-res-fold-toggle"
              data-last-reservation-fold-toggle
              aria-expanded={true}
              onClick={toggleFolded}
            >
              小さくする
            </button>
          </div>
          <p className="last-res-line">
            {snapshot.performanceName} ／ {snapshot.whenText}
          </p>
          {snapshot.zoneLabel ? (
            <p className="last-res-line">
              ゾーン：{snapshot.zoneLabel}（{snapshot.partySize}名）
              <br />
              座席はお支払い後に確定します
            </p>
          ) : (
            <p className="last-res-line">座席：{snapshot.seatLabels.join('、')}</p>
          )}
          <p className="last-res-line">合計：{formatYen(snapshot.amount)}</p>
        </div>
      </div>
      {qrExpanded && <ReservationQr code={snapshot.code} token={snapshot.qrToken} />}
      <div className="last-res-share">
        <a
          className="last-res-share-btn is-line"
          data-share="line"
          href={buildSnapshotLineUrl(snapshot)}
          target="_blank"
          rel="noreferrer"
        >
          LINEで送る
        </a>
        <a
          className="last-res-share-btn"
          data-share="mailto"
          href={buildSnapshotGmailUrl(snapshot)}
          target="_blank"
          rel="noreferrer"
        >
          ✉ Gmailで送る
        </a>
        {calendarUrl && (
          <a
            className="last-res-share-btn"
            data-share="calendar"
            href={calendarUrl}
            target="_blank"
            rel="noreferrer"
          >
            📅 カレンダーに追加
          </a>
        )}
      </div>
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
  // 予約完了（保存）・折りたたみ変更のたびに読み直す
  useEffect(() => {
    const update = () => setItems(loadLastReservations())
    window.addEventListener(LAST_RESERVATION_EVENT, update)
    return () => window.removeEventListener(LAST_RESERVATION_EVENT, update)
  }, [])
  if (items.length === 0) return null
  return (
    <section className="card last-reservation-card" data-last-reservation>
      <h3>この端末で予約した控え</h3>
      {items.map((snapshot) => (
        <SavedReservationItem key={snapshot.code} snapshot={snapshot} />
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
  /** 予約完了画面の表示中か（AudienceBook から通知を受ける・R6・C-2） */
  const [bookingDone, setBookingDone] = useState(false)
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
        compact={view === 'staff'}
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
        {/* 完了画面の表示中は控え一覧を完了カードの下へ回す（R6・C-2）:
            「予約が完了しました」と予約番号がファーストビューに入り、
            QR・共有ボタンも完了カード側に一本化されて見える */}
        {view === 'book' && !bookingDone && (
          <SavedReservations onLookup={() => setView('lookup')} />
        )}
        {view === 'book' && (
          <AudienceBook perf={perf} onBookingDoneChange={setBookingDone} />
        )}
        {view === 'book' && bookingDone && (
          <SavedReservations onLookup={() => setView('lookup')} />
        )}
        {view === 'lookup' && <Lookup onBack={() => setView('book')} />}
        {view === 'staff' && <Staff onExit={() => setView('book')} />}
      </main>
      <footer className="site-footer">
        <p>
          指定席予約 ― 人数を選ぶと見やすい席を自動でご用意します。当日は受付で現金でお支払いいただきます。
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
