import { useMemo, useState } from 'react'
import { ALL_SEATS, seatById, type Floor, type SeatDef } from '../data/seats'
import {
  MAX_ONLINE_SEATS,
  availableCountByFloor,
  defaultTicketType,
  findTicketType,
  formatPerformanceWhen,
  formatTicketTypes,
  formatYen,
  isBookingClosed,
  seatStatus,
  type Performance,
  type Reservation,
} from '../lib/logic'
import { useStore } from '../lib/store'
import { buildCalendarUrl, buildMailtoUrl } from '../lib/share'
import SeatMap, { SeatLegend, type SeatVisualState } from './SeatMap'
import TicketTypePicker, { priceOfSeat } from './TicketTypePicker'

type Step = 'seats' | 'form' | 'confirm' | 'done'
const ZOOMS = [1, 1.25, 1.5]

export default function AudienceBook({ perf }: { perf: Performance }) {
  const { data, reserve } = useStore()
  const [step, setStep] = useState<Step>('seats')
  const [floor, setFloor] = useState<Floor>(1)
  const [zoom, setZoom] = useState(1)
  const [selected, setSelected] = useState<string[]>([])
  /** 席ごとの券種指定（未指定はデフォルト券種） */
  const [typeBySeat, setTypeBySeat] = useState<Record<string, string>>({})
  const [name, setName] = useState('')
  const [phone, setPhone] = useState('')
  const [note, setNote] = useState('')
  const [error, setError] = useState('')
  const [completed, setCompleted] = useState<Reservation | null>(null)
  const [submitting, setSubmitting] = useState(false)

  const closed = isBookingClosed(data)
  const remainingByFloor = availableCountByFloor(data)

  const selectedSeats = useMemo(() => selected.map(seatById), [selected])
  const total = selected.reduce((sum, id) => sum + priceOfSeat(perf, typeBySeat, id), 0)
  const includesRestricted = selectedSeats.some((s) => s.restrictedView)
  const typeNameOf = (seatId: string) =>
    findTicketType(perf, typeBySeat[seatId] ?? defaultTicketType(perf).id)?.name ?? ''

  const stateOf = (seat: SeatDef): SeatVisualState => {
    if (selected.includes(seat.id)) return 'selected'
    return seatStatus(data, seat.id)
  }

  const handleSeatTap = (seat: SeatDef) => {
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
        phone,
        note,
        source: 'online',
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
            className="btn btn-ghost"
            data-share="mailto"
            href={buildMailtoUrl(perf, completed)}
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
      <section className="card perf-summary">
        <h2>{perf.name}</h2>
        <p className="perf-when">{formatPerformanceWhen(perf)}</p>
        <p className="perf-price">料金：{formatTicketTypes(perf)}（当日現金払い）</p>
        {perf.priceNote && <p className="muted small">※{perf.priceNote}</p>}
        {perf.note && <p className="muted">{perf.note}</p>}
      </section>

      {step === 'seats' && (
        <>
          <section className="card seat-picker">
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
            <SeatLegend />
            <SeatMap
              floor={floor}
              zoom={zoom}
              stateOf={stateOf}
              onSeatTap={handleSeatTap}
              showRecommended
            />
            <p className="muted small">
              座席表は左右にスクロールできます。全{ALL_SEATS.length}席（1階・2階・サイド席・車椅子席・親子室）
            </p>
          </section>
          <div className="selection-bar">
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
              <button type="button" className="btn btn-ghost" onClick={() => setStep('seats')}>
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
