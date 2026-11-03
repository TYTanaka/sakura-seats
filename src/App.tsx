import { useEffect, useRef, useState } from 'react'
import {
  formatMonthDayTime,
  formatPerformanceWhen,
  formatYen,
  isBookingClosed,
  localDateString,
  type Performance,
} from './lib/logic'
import { StoreProvider, useStore } from './lib/store'
import { lookupReceiptCancelled } from './lib/receiptStatus'
import { totalAvailableSeats } from './lib/zones'
import SeatsNotice from './components/SeatsNotice'
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
import posterHeroUrl from './assets/poster-hero.webp'
import AudienceBook from './components/AudienceBook'
import Lookup from './components/Lookup'
import ReservationQr, { useReservationQrUrl } from './components/ReservationQr'
import { encodeQrPayload } from './lib/qrToken'
import Staff, { hasStaffSession } from './components/Staff'

type View = 'book' | 'lookup' | 'staff'

/* 文字サイズ設定（R27・お客様側のみ）: アプリは px 指定のため OS の文字
   サイズ設定が効かない。高齢のお客様向けに端末へ保存する切り替えを持つ。
   スタッフ画面では Shell が data-textsize を常に standard に固定する。 */
type TextSize = 'standard' | 'large'
const TEXT_SIZE_KEY = 'sakura-seats-text-size-v1'
function loadTextSize(): TextSize {
  try {
    return localStorage.getItem(TEXT_SIZE_KEY) === 'large' ? 'large' : 'standard'
  } catch {
    return 'standard'
  }
}

function TextSizeToggle({
  value,
  onChange,
}: {
  value: TextSize
  onChange: (v: TextSize) => void
}) {
  return (
    <div className="textsize-bar" data-textsize-toggle>
      <span className="textsize-label" id="textsize-label">
        文字サイズ
      </span>
      <div className="textsize-seg" role="group" aria-labelledby="textsize-label">
        <button
          type="button"
          data-textsize-option="standard"
          aria-pressed={value === 'standard'}
          onClick={() => onChange('standard')}
        >
          標準
        </button>
        <button
          type="button"
          data-textsize-option="large"
          aria-pressed={value === 'large'}
          onClick={() => onChange('large')}
        >
          大
        </button>
      </div>
    </div>
  )
}

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
  // 空席数はゾーン別表示と計算経路を1本化する（R24・ラウンド9 R-1:
  // 未割当のゾーン予約＝カウントホールドも差し引く totalAvailableSeats）
  const available = totalAvailableSeats(data)
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
      {/* 緞帳帯: 会場名と導線ボタン。ポスター上部の赤い幕に合わせた帯で、
          ポスター本体の文字には何も重ねない（R23） */}
      <div className="hero-band">
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
      </div>
      <div className="marquee-trim" aria-hidden="true" />
      {/* メインポスター（R23）: 作品タイトル等はポスター自体に含まれるため、
          画像の上には文字を重ねない。ポスターは切り取らず額縁ごと置き、
          実情報は右隣の情報カラムに寄せる（劇場の掲示風レイアウト）。
          ヒーロー全体の高さは、予約の入口がファーストビューに入る
          従来の上限（R16）に収める */}
      <div className="hero-main">
        <img
          className="hero-art"
          src={posterHeroUrl}
          alt=""
          aria-hidden="true"
          fetchPriority="high"
        />
        <div className="hero-info">
        <h1 className="site-title">
          <TwinLeavesMark />
          {perf.name}
        </h1>
        <p className="site-when">{formatPerformanceWhen(perf)}</p>
        <p className="site-meta">
          料金：
          {perf.ticketTypes.map((t, i) => (
            <span key={t.id}>
              <span className="u-nowrap">
                {t.name} {formatYen(t.price)}
              </span>
              {/* R35: 区切りの「／」は前の単位の末尾に置く。
                 行頭に「／」が来る折れ方をしないようにするため */}
              {i < perf.ticketTypes.length - 1 && '／'}
            </span>
          ))}
          <span className="u-nowrap">（当日現金払い）／</span>{' '}
          <span className="meta-available u-nowrap">空席 {available}席</span>
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
  const { data, mode, lookupReservation } = useStore()
  const [qrExpanded, setQrExpanded] = useState(false)
  const [folded, setFolded] = useState(() => loadFoldedCodes().has(snapshot.code))
  // QR は予約番号ではなくトークンから作る（R7）。トークンの無い旧い控えは番号表示
  const qrPayload = snapshot.qrToken ? encodeQrPayload(snapshot.qrToken) : null
  const qrUrl = useReservationQrUrl(qrPayload)
  const calendarUrl = buildSnapshotCalendarUrl(snapshot)

  /**
   * R25（ラウンド10・C-1）: 控えに現在状態（キャンセル済み）を反映する。
   * 控え自体は予約時点のスナップショットで状態を持たないため、取得できる
   * 最も新しい状態を使う:
   * - 端末内ストアにその予約がある場合（ローカルモード／スタッフ入室中の
   *   クラウド）は、その状態が最新で、そのまま追随する
   * - クラウドのお客様画面ではストアに自分の予約が無いため、控えに残した
   *   電話番号（R25〜の控えのみ）で照会 RPC から状態を取り直す
   * 取得できない・失敗した場合は「不明」として従来表示を保つ
   * （有効な予約を誤ってキャンセル扱いする方が悪いため）。
   *
   * R26（ラウンド11・C-1R）: 照会は receiptStatus の共有キャッシュ経由に
   * 変えた。旧実装は「照会済み」の印を立ててから await し、応答前に
   * ストア再描画で effect が cleanup されると in-flight な結果が破棄され、
   * 再実行も印に阻まれて二度と反映されなかった（応答が遅いと控えが
   * キャンセル済みに反転しない）。共有キャッシュでは Promise が
   * コンポーネントの外に残るため、cleanup 後に再実行された effect が
   * 購読し直せば遅れた応答も届く。「不明」の間は従来表示のまま（安全側）。
   */
  const storeRes = data.reservations.find((r) => r.id === snapshot.code)
  const [remoteCancelled, setRemoteCancelled] = useState<boolean | null>(null)
  useEffect(() => {
    if (storeRes || mode !== 'cloud' || !snapshot.phone) return
    let subscribed = true
    void lookupReceiptCancelled(lookupReservation, snapshot.code, snapshot.phone).then(
      (v) => {
        if (subscribed && v !== null) setRemoteCancelled(v)
      },
    )
    return () => {
      subscribed = false
    }
  }, [storeRes, mode, snapshot.code, snapshot.phone, lookupReservation])
  const cancelled = storeRes ? storeRes.cancelled : remoteCancelled === true

  const toggleFolded = () => {
    const next = !folded
    setFolded(next)
    setReservationFolded(snapshot.code, next)
  }

  if (folded) {
    return (
      <article
        className={`last-res-item is-folded${cancelled ? ' is-cancelled' : ''}`}
        data-last-reservation-item={snapshot.code}
        data-last-reservation-folded
        {...(cancelled ? { 'data-last-reservation-cancelled': true } : {})}
      >
        <div className="last-res-folded">
          <p className="last-res-folded-line">
            {snapshot.code} ／ {snapshot.performanceName} ／{' '}
            {snapshot.zoneLabel
              ? `${snapshot.zoneLabel} ${snapshot.partySize ?? ''}名`
              : `${snapshot.seatLabels.length}席`}{' '}
            ／ {formatYen(snapshot.amount)}
            {cancelled && <span className="last-res-folded-cancelled"> ／ キャンセル済み</span>}
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
    <article
      className={`last-res-item${cancelled ? ' is-cancelled' : ''}`}
      data-last-reservation-item={snapshot.code}
      {...(cancelled ? { 'data-last-reservation-cancelled': true } : {})}
    >
      <div className="last-res-main">
        {cancelled ? (
          // キャンセル済みの控えには QR を出さない（有効なチケットと
          // 見分けがつくよう、QR の場所自体を「キャンセル済み」の印にする）
          <div className="last-res-cancelled-mark" aria-hidden="true">
            キャンセル済み
          </div>
        ) : (
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
        )}
        <div className="last-res-summary">
          <div className="last-res-head">
            <p className="last-res-code">{snapshot.code}</p>
            {cancelled && (
              <span className="cancelled-chip" data-last-reservation-cancelled-chip>
                キャンセル済み
              </span>
            )}
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
            {snapshot.performanceName} ／{' '}
            <span className="u-nowrap">{snapshot.whenText}</span>
          </p>
          {snapshot.zoneLabel ? (
            <p className="last-res-line">
              ゾーン：
              <span className="u-nowrap">{snapshot.zoneLabel.split('（')[0]}</span>
              {snapshot.zoneLabel.includes('（') && (
                <span className="u-nowrap">（{snapshot.zoneLabel.split('（')[1]}</span>
              )}
              <span className="u-nowrap">（{snapshot.partySize}名）</span>
              <br />
              <SeatsNotice />
            </p>
          ) : (
            <p className="last-res-line">座席：{snapshot.seatLabels.join('、')}</p>
          )}
          <p className="last-res-line">合計：{formatYen(snapshot.amount)}</p>
          {cancelled && (
            <p className="last-res-cancelled-note">
              この予約はキャンセルされています。当日、受付ではご利用いただけません。
              再度ご予約をご希望の場合は、新しくお申し込みください。
            </p>
          )}
        </div>
      </div>
      {!cancelled && qrExpanded && (
        <ReservationQr code={snapshot.code} token={snapshot.qrToken} />
      )}
      {!cancelled && (
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
      )}
    </article>
  )
}

/**
 * 「この端末で予約した控え」一覧（R4・F3 のリスト化 / R6）: この端末で
 * 完了した予約の控えを新しい順に並べる。完了画面がリロードで消えても、
 * ここから予約番号・座席・QRを再表示できる。1人で2回以上買っても
 * 前の控えは消えない（保持上限つき）。
 * 支払い等の最新状態はスナップショットでは分からないため、予約確認への
 * 導線を併記する。キャンセル済みだけは R25 で控え自体に反映する
 * （有効なチケットと見分けがつかない事故を防ぐため。SavedReservationItem 参照）。
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
  const { data, mode, ready, loadError, retryLoad, storageWarning, syncState, staffSessionEmail } =
    useStore()
  /**
   * 初期ビュー（R21・ラウンド8 S-4）: スタッフセッションがこのタブに
   * 残っていれば、再読み込み後もスタッフ画面へ直接戻る。当日スタッフは
   * リロードで毎回お客様画面から入り直していた。セッションは元々
   * スタッフ画面に入れば無操作で自動解除される設計（タブ内限定）で、
   * 初期ビューの分岐追加は実質的な露出を変えない。
   */
  const [view, setView] = useState<View>(() => (hasStaffSession() ? 'staff' : 'book'))
  /** ユーザーが明示的に画面遷移したか（自動復帰で上書きしないための印） */
  const navigatedRef = useRef(false)
  const go = (v: View) => {
    navigatedRef.current = true
    setView(v)
  }
  // クラウド（Google ログイン）のセッションが後から判明した場合も、
  // まだ手動遷移していない初回だけスタッフ画面へ戻す
  useEffect(() => {
    if (staffSessionEmail && !navigatedRef.current) {
      setView('staff')
    }
  }, [staffSessionEmail])
  /** 予約完了画面の表示中か（AudienceBook から通知を受ける・R6・C-2） */
  const [bookingDone, setBookingDone] = useState(false)
  /* 文字サイズ（R27）: 初期値は端末の保存値。初回描画から正しい大きさで
     出るよう、遅延初期化で読み込む（描画後の切り替えちらつきなし） */
  const [textSize, setTextSizeState] = useState<TextSize>(loadTextSize)
  const setTextSize = (v: TextSize) => {
    setTextSizeState(v)
    try {
      localStorage.setItem(TEXT_SIZE_KEY, v)
    } catch {
      /* 保存できなくても切り替え自体は有効 */
    }
  }
  const perf = data.performance

  if (mode === 'cloud' && loadError) {
    return (
      <div className="app-shell" data-textsize={textSize}>
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
      <div className="app-shell" data-textsize={textSize}>
        <p className="loading-note">読み込み中…♪</p>
      </div>
    )
  }

  return (
    <div className="app-shell" data-textsize={view === 'staff' ? 'standard' : textSize}>
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
        onLookup={() => go('lookup')}
        onStaff={() => go('staff')}
      />
      {/* 文字サイズ切り替え（R27）: ヒーロー帯の直下に常置し、予約画面と
          予約確認の両方で同じ場所から切り替えられるようにする。
          スタッフ画面には出さない（スタッフ側は標準サイズで固定） */}
      {view !== 'staff' && <TextSizeToggle value={textSize} onChange={setTextSize} />}
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
          <SavedReservations onLookup={() => go('lookup')} />
        )}
        {view === 'book' && (
          <AudienceBook perf={perf} onBookingDoneChange={setBookingDone} />
        )}
        {view === 'book' && bookingDone && (
          <SavedReservations onLookup={() => go('lookup')} />
        )}
        {view === 'lookup' && <Lookup onBack={() => go('book')} />}
        {view === 'staff' && <Staff onExit={() => go('book')} />}
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
