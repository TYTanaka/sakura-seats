import { useEffect, useMemo, useRef, useState } from 'react'
import { ALL_SEATS, seatById, type Floor, type SeatDef } from '../data/seats'
import {
  MAX_ONLINE_SEATS,
  availableCountByFloor,
  defaultTicketType,
  findTicketType,
  formatPerformanceWhen,
  formatYen,
  isBookingClosed,
  isValidPhone,
  normalizePhone,
  seatStatus,
  type Performance,
  type Reservation,
} from '../lib/logic'
import { useStore } from '../lib/store'
import { useNow } from '../lib/useNow'
import { saveLastReservation } from '../lib/lastReservation'
import {
  buildCalendarUrl,
  buildGmailUrl,
  buildLineSharePageUrl,
  buildLineShareReservationUrl,
} from '../lib/share'
import flyerUrl from '../assets/flyer.webp'
import flyerJpgUrl from '../assets/flyer.jpg'
import SeatMap, {
  SeatLegend,
  ZoomControls,
  type SeatVisualState,
  type SeatZoom,
} from './SeatMap'
import TicketTypePicker, { priceOfSeat } from './TicketTypePicker'
import ReservationQr from './ReservationQr'

type Step = 'seats' | 'form' | 'confirm' | 'done'

/**
 * 申込フォームの下書き（R3-8）: 入力途中でリロードしても消えないよう
 * 端末内に保持する。予約が完了したら破棄する。
 */
const DRAFT_KEY = 'sakura-seats-booking-draft-v1'

interface BookingDraft {
  name: string
  phone: string
  note: string
  selected: string[]
  typeBySeat: Record<string, string>
  /** 申込フロー上のステップも一緒に保持する（R4-8: リロードでステップだけ戻らないように） */
  step: 'seats' | 'form' | 'confirm'
}

function loadDraft(): BookingDraft | null {
  try {
    const raw = localStorage.getItem(DRAFT_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as Partial<BookingDraft>
    return {
      name: typeof parsed.name === 'string' ? parsed.name : '',
      phone: typeof parsed.phone === 'string' ? parsed.phone : '',
      note: typeof parsed.note === 'string' ? parsed.note : '',
      selected: Array.isArray(parsed.selected)
        ? parsed.selected.filter((s): s is string => typeof s === 'string')
        : [],
      typeBySeat:
        parsed.typeBySeat && typeof parsed.typeBySeat === 'object' ? parsed.typeBySeat : {},
      step:
        parsed.step === 'form' || parsed.step === 'confirm' || parsed.step === 'seats'
          ? parsed.step
          : 'seats',
    }
  } catch {
    return null
  }
}

function clearDraft() {
  try {
    localStorage.removeItem(DRAFT_KEY)
  } catch {
    // 保存できなくても画面操作は継続する
  }
}

export default function AudienceBook({ perf }: { perf: Performance }) {
  const { data, reserve } = useStore()
  const [initialDraft] = useState<BookingDraft | null>(loadDraft)
  // 下書きがあれば、入力途中のステップから再開する（席が無ければ座席選択から）
  const [step, setStep] = useState<Step>(() => {
    const s = initialDraft?.step
    return (s === 'form' || s === 'confirm') && (initialDraft?.selected.length ?? 0) > 0
      ? s
      : 'seats'
  })
  const [floor, setFloor] = useState<Floor>(1)
  const [zoom, setZoom] = useState<SeatZoom>('fit')
  /** 全体表示の実測倍率（SeatMap が通知）。倍率表示（約○○%）に使う */
  const [fitScale, setFitScale] = useState<number | null>(null)
  const [selected, setSelected] = useState<string[]>(() => initialDraft?.selected ?? [])
  /** 席ごとの券種指定（未指定はデフォルト券種） */
  const [typeBySeat, setTypeBySeat] = useState<Record<string, string>>(
    () => initialDraft?.typeBySeat ?? {},
  )
  const [name, setName] = useState(() => initialDraft?.name ?? '')
  const [phone, setPhone] = useState(() => initialDraft?.phone ?? '')
  const [note, setNote] = useState(() => initialDraft?.note ?? '')
  const [error, setError] = useState('')
  const [completed, setCompleted] = useState<Reservation | null>(null)
  const [submitting, setSubmitting] = useState(false)
  /** 画面下部固定の選択バーの高さ（本文側に同じ高さの余白を確保して隠れを防ぐ） */
  const barRef = useRef<HTMLDivElement | null>(null)
  const [barHeight, setBarHeight] = useState(0)
  useEffect(() => {
    const el = barRef.current
    if (!el) return
    const update = () => setBarHeight(el.offsetHeight)
    update()
    const ro = new ResizeObserver(update)
    ro.observe(el)
    return () => ro.disconnect()
  }, [step])

  // 締切は「今」を定期的に再評価して判定する（開いたまま締切を跨いでも追随する・R4-1）
  const nowMs = useNow(10000)
  const closed = isBookingClosed(data, new Date(nowMs))
  const remainingByFloor = availableCountByFloor(data)
  /** 開いている間に締切を跨いだことを知らせる表示 */
  const [deadlinePassed, setDeadlinePassed] = useState(false)
  const wasClosedRef = useRef(closed)
  useEffect(() => {
    const was = wasClosedRef.current
    wasClosedRef.current = closed
    if (!closed || was) return
    // 締切を跨いだ瞬間: 選択を解除し、フォーム途中なら座席選択へ戻して詰み状態を防ぐ
    if (selected.length > 0) {
      setSelected([])
      setDeadlinePassed(true)
    }
    if (step === 'form' || step === 'confirm') setStep('seats')
  }, [closed, selected.length, step])

  // 下書きから復元した選択席のうち、すでに埋まっている席は一度だけ取り除く。
  // 外れたことが分かるよう一言表示する（R4-6）
  const [draftPruned, setDraftPruned] = useState(false)
  const prunedDraftRef = useRef(false)
  useEffect(() => {
    if (prunedDraftRef.current) return
    prunedDraftRef.current = true
    const initialSelected = initialDraft?.selected ?? []
    const kept = initialSelected.filter((id) => seatStatus(data, id) === 'available')
    if (kept.length !== initialSelected.length) setDraftPruned(true)
    if (isBookingClosed(data)) {
      // 戻ってきた時点で既に締切を過ぎていたら、選択は持たずに受付終了として出す
      if (initialSelected.length > 0) {
        setSelected([])
        setDeadlinePassed(true)
      }
      setStep('seats')
    } else {
      if (kept.length !== initialSelected.length) setSelected(kept)
      if (kept.length === 0 && initialSelected.length > 0) setStep('seats')
    }
    // 初回マウント時のデータでのみ判定する
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // 入力内容を下書きとして保持する（ステップも含める。全て空なら破棄）
  useEffect(() => {
    if (step === 'done') return
    try {
      if (!name && !phone && !note && selected.length === 0) {
        localStorage.removeItem(DRAFT_KEY)
      } else {
        const draft: BookingDraft = {
          name,
          phone,
          note,
          selected,
          typeBySeat,
          step: step === 'form' || step === 'confirm' ? step : 'seats',
        }
        localStorage.setItem(DRAFT_KEY, JSON.stringify(draft))
      }
    } catch {
      // 保存できなくても画面操作は継続する
    }
  }, [name, phone, note, selected, typeBySeat, step])

  const selectedSeats = useMemo(() => selected.map(seatById), [selected])
  const total = selected.reduce((sum, id) => sum + priceOfSeat(perf, typeBySeat, id), 0)
  const includesRestricted = selectedSeats.some((s) => s.restrictedView)
  const typeNameOf = (seatId: string) =>
    findTicketType(perf, typeBySeat[seatId] ?? defaultTicketType(perf).id)?.name ?? ''

  const stateOf = (seat: SeatDef): SeatVisualState => {
    if (selected.includes(seat.id)) return 'selected'
    const status = seatStatus(data, seat.id)
    // お客様マップでは支払済席も予約済席と同じ見た目にする（どちらも「選べない席」。
    // 凡例の1スウォッチとも一致させる。スタッフ画面では従来どおり区別する）
    return status === 'paid' ? 'reserved' : status
  }

  const handleSeatTap = (seat: SeatDef) => {
    // 予約締切後は席タップも無効（選べるのに進めない状態にしない）
    if (closed) return
    setError('')
    if (selected.includes(seat.id)) {
      setSelected(selected.filter((id) => id !== seat.id))
      return
    }
    if (seatStatus(data, seat.id) !== 'available') return
    if (selected.length >= MAX_ONLINE_SEATS) {
      setError(`一度に申し込めるのは${MAX_ONLINE_SEATS}席までです`)
      return
    }
    setSelected([...selected, seat.id])
  }

  const handleSubmit = async () => {
    setError('')
    setSubmitting(true)
    try {
      const reservation = await reserve({
        seats: selected.map((seatId) => ({
          seatId,
          typeId: typeBySeat[seatId] ?? defaultTicketType(perf).id,
        })),
        name,
        // 電話番号は正規化した数字のみで保存する（照会側も同じ形で比較する）
        phone: normalizePhone(phone),
        note,
        source: 'online',
      })
      clearDraft()
      // 完了画面がリロードで消えても再表示できるよう、端末に控えを残す（R4・F3）
      saveLastReservation({
        code: reservation.id,
        performanceName: perf.name,
        whenText: formatPerformanceWhen(perf),
        seatLabels: reservation.items.map((item) => seatById(item.seatId).label),
        amount: reservation.amount,
        savedAt: new Date().toISOString(),
      })
      setCompleted(reservation)
      setStep('done')
    } catch (e) {
      setError(e instanceof Error ? e.message : '予約に失敗しました')
      // 取れなかった席を選択から外して座席選択に戻す
      setSelected((prev) => prev.filter((id) => seatStatus(data, id) === 'available'))
      setStep('seats')
    } finally {
      setSubmitting(false)
    }
  }

  const resetFlow = () => {
    clearDraft()
    setSelected([])
    setTypeBySeat({})
    setName('')
    setPhone('')
    setNote('')
    setError('')
    setCompleted(null)
    setStep('seats')
    window.scrollTo({ top: 0 })
  }

  if (step === 'done' && completed) {
    return (
      <section className="card done-card">
        <p className="done-badge">予約が完了しました</p>
        <p className="done-lead">ご予約ありがとうございます。予約番号をお控えください。</p>
        <p className="reservation-code">{completed.id}</p>
        <ReservationQr code={completed.id} />
        <dl className="detail-list">
          <div>
            <dt>公演</dt>
            <dd>
              {perf.name}
              <br />
              {formatPerformanceWhen(perf)}
            </dd>
          </div>
          <div>
            <dt>お名前</dt>
            <dd>{completed.name} 様</dd>
          </div>
          <div>
            <dt>座席</dt>
            <dd>
              {completed.items.map((item) => (
                <span key={item.seatId} className="detail-seat-line">
                  {seatById(item.seatId).label}（{item.typeName} {formatYen(item.price)}）
                </span>
              ))}
            </dd>
          </div>
          <div>
            <dt>合計</dt>
            <dd className="detail-total">{formatYen(completed.amount)}</dd>
          </div>
        </dl>
        <div className="notice-box">
          <p>当日は受付でお名前と予約番号をお伝えのうえ、現金でお支払いください。</p>
          <p>変更・キャンセルは主催者までご連絡ください。</p>
        </div>
        <div className="share-actions">
          <a
            className="btn btn-line"
            data-share="line"
            href={buildLineShareReservationUrl(perf, completed)}
            target="_blank"
            rel="noreferrer"
          >
            LINEで予約内容を送る
          </a>
          <a
            className="btn btn-ghost"
            data-share="mailto"
            href={buildGmailUrl(perf, completed)}
            target="_blank"
            rel="noreferrer"
          >
            ✉ Gmailで自分に送る
          </a>
          <a
            className="btn btn-ghost"
            data-share="calendar"
            href={buildCalendarUrl(perf, completed)}
            target="_blank"
            rel="noreferrer"
          >
            📅 カレンダーに追加
          </a>
        </div>
        <p className="muted small">
          控えをメールで送っておくと、後から予約番号を確認できて安心です。
          予約の確認はトップページの「予約確認」からもできます。
        </p>
        <button type="button" className="btn btn-primary btn-block" onClick={resetFlow}>
          座席の選択に戻る
        </button>
      </section>
    )
  }

  return (
    <div className="book-flow">
      {step === 'seats' && (
        <>
          {deadlinePassed && (
            <p className="closed-notice deadline-passed-notice" data-deadline-passed role="status">
              予約締切を過ぎたため、受付を終了しました。選択していた座席は解除されました。
            </p>
          )}
          {draftPruned && (
            <p className="draft-pruned-notice" data-draft-pruned role="status">
              一部の座席は予約済みになったため、選択から外れました
            </p>
          )}
          <div className="page-share">
            <a
              className="btn btn-line"
              data-line-share-page
              href={buildLineSharePageUrl()}
              target="_blank"
              rel="noreferrer"
            >
              LINEで送る
            </a>
            <span className="muted small">家族や友だちに、この予約ページをLINEで共有できます</span>
          </div>
          <section id="seat-picker" className={`card seat-picker${closed ? ' is-closed' : ''}`}>
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
                    {f}階席（残り{remainingByFloor[f]}席）
                    {remainingByFloor[f] < 20 && (
                      <span className="low-seats-badge" data-low-seats={f}>
                        残りわずか
                      </span>
                    )}
                  </button>
                ))}
              </div>
              <ZoomControls zoom={zoom} setZoom={setZoom} fitScale={fitScale} />
            </div>
            {zoom === 'fit' && (
              <p className="fit-hint">
                全体表示は俯瞰用です。座席表をピンチ（2本指で広げる・つまむ）するか、100%表示にすると拡大して選べます
              </p>
            )}
            <SeatLegend />
            <SeatMap
              floor={floor}
              zoom={zoom}
              stateOf={stateOf}
              onSeatTap={handleSeatTap}
              showRecommended
              onFitScale={setFitScale}
              onZoomChange={setZoom}
            />
            <p className="muted small">
              全{ALL_SEATS.length}席（1階・2階・サイド席・車椅子席・親子室）
            </p>
          </section>
          <section className="card poster-card">
            <h3>公演ポスター</h3>
            <a
              className="poster-link"
              href={flyerUrl}
              target="_blank"
              rel="noreferrer"
              aria-label="公演ポスターを大きく見る"
            >
              <picture>
                <source srcSet={flyerUrl} type="image/webp" />
                <img
                  src={flyerJpgUrl}
                  alt="劇団ツインリーブス 2027年5月公演 ポスター"
                  loading="lazy"
                />
              </picture>
            </a>
            <p className="poster-caption">劇団ツインリーブス 2027年5月公演</p>
          </section>
          <div className="selection-bar" ref={barRef}>
            {selected.length === 0 ? (
              <p className="selection-empty">座席表から席を選んでください（最大{MAX_ONLINE_SEATS}席）</p>
            ) : (
              <>
                <p className="selection-seats">
                  {selectedSeats.map((s) => s.label).join('、')}
                </p>
                <p className="selection-total">
                  {selected.length}席 ／ 合計 {formatYen(total)}
                </p>
                <p className="muted small selection-type-note">
                  券種（{perf.ticketTypes.map((t) => t.name).join('・')}）は次の画面で席ごとに選べます
                </p>
                {includesRestricted && (
                  <p className="selection-warn">
                    ※見切れ席（舞台の一部が見えにくい席）が含まれています
                  </p>
                )}
              </>
            )}
            {error && <p className="error-text">{error}</p>}
            {closed && (
              <p className="closed-notice" data-booking-closed>
                予約受付は終了しました。当日券は会場受付でお求めください。
              </p>
            )}
            <button
              type="button"
              className="btn btn-primary btn-block"
              disabled={selected.length === 0 || closed}
              onClick={() => setStep('form')}
            >
              申込手続きへ進む
            </button>
          </div>
          <div aria-hidden="true" style={{ height: barHeight + 12 }} />
        </>
      )}

      {step === 'form' && (
        <section className="card">
          <h3>お申し込み情報</h3>
          <h4 className="form-subhead">座席と券種</h4>
          <TicketTypePicker
            perf={perf}
            seatIds={selected}
            typeBySeat={typeBySeat}
            onChange={(seatId, typeId) =>
              setTypeBySeat((prev) => ({ ...prev, [seatId]: typeId }))
            }
          />
          {perf.priceNote && <p className="muted small">※{perf.priceNote}</p>}
          <p className="selection-total" data-form-total>
            合計 {formatYen(total)}（当日現金払い）
          </p>
          <form
            onSubmit={(e) => {
              e.preventDefault()
              if (!name.trim()) {
                setError('お名前を入力してください')
                return
              }
              if (!phone.trim()) {
                setError('電話番号を入力してください')
                return
              }
              if (!isValidPhone(phone)) {
                setError(
                  '電話番号は10〜11桁の数字で入力してください（全角数字やハイフンはそのまま使えます）',
                )
                return
              }
              // 確認画面・保存は正規化した数字のみの形に統一する
              setPhone(normalizePhone(phone))
              setError('')
              setStep('confirm')
            }}
          >
            <label className="field">
              <span>
                お名前 <em className="required">必須</em>
              </span>
              <input
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="例：山田 花子"
                autoComplete="name"
              />
            </label>
            <label className="field">
              <span>
                電話番号 <em className="required">必須</em>
              </span>
              <input
                type="tel"
                value={phone}
                onChange={(e) => setPhone(e.target.value)}
                placeholder="例：090-0000-0000"
                autoComplete="tel"
              />
            </label>
            <label className="field">
              <span>備考（任意）</span>
              <textarea
                value={note}
                onChange={(e) => setNote(e.target.value)}
                rows={3}
                placeholder="例：車椅子席の付き添いです、など"
              />
            </label>
            {error && <p className="error-text">{error}</p>}
            <div className="btn-row">
              <button
                type="button"
                className="btn btn-ghost"
                onClick={() => {
                  setError('')
                  setStep('seats')
                }}
              >
                席の選択に戻る
              </button>
              <button type="submit" className="btn btn-primary">
                確認画面へ
              </button>
            </div>
          </form>
        </section>
      )}

      {step === 'confirm' && (
        <section className="card">
          <h3>お申し込み内容の確認</h3>
          <dl className="detail-list">
            <div>
              <dt>公演</dt>
              <dd>
                {perf.name}
                <br />
                {formatPerformanceWhen(perf)}
              </dd>
            </div>
            <div>
              <dt>座席</dt>
              <dd>
                {selectedSeats.map((s) => (
                  <span key={s.id} className="detail-seat-line">
                    {s.label}（{typeNameOf(s.id)} {formatYen(priceOfSeat(perf, typeBySeat, s.id))}）
                  </span>
                ))}
              </dd>
            </div>
            <div>
              <dt>お名前</dt>
              <dd>{name} 様</dd>
            </div>
            <div>
              <dt>電話番号</dt>
              <dd>{phone}</dd>
            </div>
            {note && (
              <div>
                <dt>備考</dt>
                <dd>{note}</dd>
              </div>
            )}
            <div>
              <dt>合計</dt>
              <dd className="detail-total">{formatYen(total)}（当日現金払い）</dd>
            </div>
          </dl>
          {includesRestricted && (
            <p className="selection-warn">
              ※見切れ席（舞台の一部が見えにくい席）が含まれています
            </p>
          )}
          {error && <p className="error-text">{error}</p>}
          <div className="btn-row">
            <button type="button" className="btn btn-ghost" onClick={() => setStep('form')}>
              入力に戻る
            </button>
            <button
              type="button"
              className="btn btn-primary"
              onClick={handleSubmit}
              disabled={submitting}
            >
              {submitting ? '予約処理中…' : 'この内容で予約する'}
            </button>
          </div>
        </section>
      )}
    </div>
  )
}
