import { useEffect, useMemo, useRef, useState } from 'react'
import { ALL_SEATS, seatById } from '../data/seats'
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
import {
  buildCandidateSets,
  type FloorPreference,
  type OmakaseCandidate,
} from '../lib/omakase'
import { useStore } from '../lib/store'
import { useNow } from '../lib/useNow'
import { addLastReservation } from '../lib/lastReservation'
import {
  buildCalendarUrl,
  buildGmailUrl,
  buildLineSharePageUrl,
  buildLineShareReservationUrl,
} from '../lib/share'
import flyerUrl from '../assets/flyer.webp'
import flyerJpgUrl from '../assets/flyer.jpg'
import MiniMap from './MiniMap'
import TicketTypePicker, { priceOfSeat } from './TicketTypePicker'
import ReservationQr from './ReservationQr'

type Step = 'omakase' | 'form' | 'confirm' | 'done'

/**
 * 申込フォームの下書き（R3-8）: 入力途中でリロードしても消えないよう
 * 端末内に保持する。予約が完了したら破棄する。
 * おまかせ化に伴い、人数と階の希望も一緒に保持する。
 */
const DRAFT_KEY = 'sakura-seats-booking-draft-v1'

interface BookingDraft {
  name: string
  phone: string
  note: string
  selected: string[]
  typeBySeat: Record<string, string>
  /** 申込フロー上のステップも一緒に保持する（R4-8: リロードでステップだけ戻らないように） */
  step: 'omakase' | 'form' | 'confirm'
  /** おまかせの人数 */
  partySize: number
  /** おまかせの階の希望 */
  floorPref: FloorPreference
}

function clampPartySize(n: unknown, fallback: number): number {
  return typeof n === 'number' && Number.isFinite(n)
    ? Math.min(MAX_ONLINE_SEATS, Math.max(1, Math.floor(n)))
    : fallback
}

function loadDraft(): BookingDraft | null {
  try {
    const raw = localStorage.getItem(DRAFT_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as Partial<BookingDraft> & { step?: string }
    const selected = Array.isArray(parsed.selected)
      ? parsed.selected.filter((s): s is string => typeof s === 'string')
      : []
    return {
      name: typeof parsed.name === 'string' ? parsed.name : '',
      phone: typeof parsed.phone === 'string' ? parsed.phone : '',
      note: typeof parsed.note === 'string' ? parsed.note : '',
      selected,
      typeBySeat:
        parsed.typeBySeat && typeof parsed.typeBySeat === 'object' ? parsed.typeBySeat : {},
      // 旧バージョンの 'seats'（座席表で選ぶステップ）は 'omakase' として読み替える
      step:
        parsed.step === 'form' || parsed.step === 'confirm' ? parsed.step : 'omakase',
      partySize: clampPartySize(parsed.partySize, selected.length > 0 ? selected.length : 2),
      floorPref:
        parsed.floorPref === 1 || parsed.floorPref === 2 ? parsed.floorPref : 'any',
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
  // 下書きがあれば、入力途中のステップから再開する（席が無ければ候補えらびから）
  const [step, setStep] = useState<Step>(() => {
    const s = initialDraft?.step
    return (s === 'form' || s === 'confirm') && (initialDraft?.selected.length ?? 0) > 0
      ? s
      : 'omakase'
  })
  /** おまかせの人数（1〜8名） */
  const [partySize, setPartySize] = useState<number>(() => initialDraft?.partySize ?? 2)
  /** おまかせの階の希望 */
  const [floorPref, setFloorPref] = useState<FloorPreference>(
    () => initialDraft?.floorPref ?? 'any',
  )
  /** 「席の候補を見る」を押して候補を表示中か */
  const [searched, setSearched] = useState(false)
  /** 選んだ候補の席（=申込対象の席） */
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
  /** 送信直前に席が取られてしまった場合の案内（新しい候補を出し直す） */
  const [seatTakenNotice, setSeatTakenNotice] = useState(false)

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
    // 締切を跨いだ瞬間: 選択を解除し、フォーム途中なら候補えらびへ戻して詰み状態を防ぐ
    if (selected.length > 0) {
      setSelected([])
      setDeadlinePassed(true)
    }
    if (step === 'form' || step === 'confirm') setStep('omakase')
  }, [closed, selected.length, step])

  // 下書きから復元した候補の席のうち、1席でも埋まっていたら候補ごと選び直しにする。
  // 外れたことが分かるよう一言表示する（R4-6 のおまかせ版）
  const [draftPruned, setDraftPruned] = useState(false)
  const prunedDraftRef = useRef(false)
  useEffect(() => {
    if (prunedDraftRef.current) return
    prunedDraftRef.current = true
    const initialSelected = initialDraft?.selected ?? []
    if (initialSelected.length === 0) return
    const allAvailable = initialSelected.every(
      (id) => seatStatus(data, id) === 'available',
    )
    if (isBookingClosed(data)) {
      // 戻ってきた時点で既に締切を過ぎていたら、選択は持たずに受付終了として出す
      setSelected([])
      setDeadlinePassed(true)
      setStep('omakase')
    } else if (!allAvailable) {
      setSelected([])
      setDraftPruned(true)
      setStep('omakase')
    }
    // 初回マウント時のデータでのみ判定する
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // 入力内容を下書きとして保持する（ステップ・人数・階の希望も含める。全て空なら破棄）
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
          step: step === 'form' || step === 'confirm' ? step : 'omakase',
          partySize,
          floorPref,
        }
        localStorage.setItem(DRAFT_KEY, JSON.stringify(draft))
      }
    } catch {
      // 保存できなくても画面操作は継続する
    }
  }, [name, phone, note, selected, typeBySeat, step, partySize, floorPref])

  // 候補は現在の占有状態から都度計算する（誰かが予約すれば即座に反映される）。
  // お客様に見せるのは最初の1組（最大3候補）だけ。気に入らなければ
  // 人数・階の希望を変えて「席の候補を見る」で探し直してもらう。
  const candidates = useMemo(
    () => (closed ? [] : buildCandidateSets(data, partySize, floorPref)[0] ?? []),
    [data, partySize, floorPref, closed],
  )

  const selectedSeats = useMemo(() => selected.map(seatById), [selected])
  const total = selected.reduce((sum, id) => sum + priceOfSeat(perf, typeBySeat, id), 0)
  const includesRestricted = selectedSeats.some((s) => s.restrictedView)
  const typeNameOf = (seatId: string) =>
    findTicketType(perf, typeBySeat[seatId] ?? defaultTicketType(perf).id)?.name ?? ''

  const changePartySize = (next: number) => {
    setPartySize(Math.min(MAX_ONLINE_SEATS, Math.max(1, next)))
    setSeatTakenNotice(false)
  }
  const changeFloorPref = (next: FloorPreference) => {
    setFloorPref(next)
    setSeatTakenNotice(false)
  }

  const pickCandidate = (cand: OmakaseCandidate) => {
    setError('')
    setSeatTakenNotice(false)
    setSelected(cand.seatIds)
    // 券種の指定は、選んだ候補の席分だけを引き継ぐ
    setTypeBySeat((prev) =>
      Object.fromEntries(Object.entries(prev).filter(([id]) => cand.seatIds.includes(id))),
    )
    setStep('form')
    window.scrollTo({ top: 0 })
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
      // 2回目以降の予約でも前の控えは消さず、一覧へ追加する（R6）
      addLastReservation({
        code: reservation.id,
        performanceName: perf.name,
        whenText: formatPerformanceWhen(perf),
        seatLabels: reservation.items.map((item) => seatById(item.seatId).label),
        amount: reservation.amount,
        savedAt: new Date().toISOString(),
        // 控えからカレンダー登録できるよう、公演日・開演時刻も一緒に残す
        perfDate: perf.date,
        perfTime: perf.time,
      })
      setCompleted(reservation)
      setStep('done')
    } catch (e) {
      const message = e instanceof Error ? e.message : '予約に失敗しました'
      // 席が他の人に取られた場合は、古い候補を持たず新しい候補を出し直す
      const seatGone =
        message.includes('予約されてしまいました') ||
        message.includes('すでに予約・販売済み') ||
        message.includes('販売していない席')
      if (seatGone) {
        setSelected([])
        setSearched(true)
        setSeatTakenNotice(true)
        setStep('omakase')
        window.scrollTo({ top: 0 })
      } else {
        setError(message)
      }
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
    setSearched(false)
    setSeatTakenNotice(false)
    setStep('omakase')
    window.scrollTo({ top: 0 })
  }

  if (step === 'done' && completed) {
    return (
      <section className="card done-card">
        <div className="done-sparkles" aria-hidden="true">
          <span className="ds ds-1">✦</span>
          <span className="ds ds-2 violet">✦</span>
          <span className="ds ds-3">✦</span>
          <span className="ds ds-4">✦</span>
          <span className="ds ds-5 violet">✦</span>
          <span className="ds ds-6">✦</span>
          <span className="ds ds-7">✦</span>
          <span className="ds ds-8 violet">✦</span>
        </div>
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
          席の候補に戻る
        </button>
      </section>
    )
  }

  return (
    <div className="book-flow">
      {step === 'omakase' && (
        <>
          {deadlinePassed && (
            <p className="closed-notice deadline-passed-notice" data-deadline-passed role="status">
              予約締切を過ぎたため、受付を終了しました。選択していた座席は解除されました。
            </p>
          )}
          {draftPruned && (
            <p className="draft-pruned-notice" data-draft-pruned role="status">
              選んでいた座席は予約済みになったため、選択を解除しました。新しい候補からお選びください
            </p>
          )}
          {seatTakenNotice && (
            <p className="seat-taken-notice" data-seat-taken role="status">
              先ほどの席は他の方に予約されました。新しい候補です
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
          <section id="seat-picker" className={`card omakase-card${closed ? ' is-closed' : ''}`}>
            <h3>おまかせ予約</h3>
            <p className="muted small omakase-lead">
              人数とご希望を選ぶと、見やすい席を自動でご用意します。席は候補の中からお選びいただけます。
            </p>
            <div className="omakase-controls">
              <div className="party-row">
                <span className="party-label" id="party-label">
                  人数
                </span>
                <div className="party-stepper" role="group" aria-labelledby="party-label">
                  <button
                    type="button"
                    className="stepper-btn"
                    data-party-dec
                    aria-label="人数を減らす"
                    disabled={closed || partySize <= 1}
                    onClick={() => changePartySize(partySize - 1)}
                  >
                    −
                  </button>
                  <span className="party-size" data-party-size>
                    {partySize}名
                  </span>
                  <button
                    type="button"
                    className="stepper-btn"
                    data-party-inc
                    aria-label="人数を増やす"
                    disabled={closed || partySize >= MAX_ONLINE_SEATS}
                    onClick={() => changePartySize(partySize + 1)}
                  >
                    ＋
                  </button>
                </div>
              </div>
              <div className="floor-pref-row">
                <span className="party-label">階の希望</span>
                <div className="seg-group floor-pref" role="group" aria-label="階の希望">
                  {(
                    [
                      { value: 'any', label: 'おまかせ' },
                      { value: 1, label: '1階席' },
                      { value: 2, label: '2階席' },
                    ] as { value: FloorPreference; label: string }[]
                  ).map((opt) => (
                    <button
                      key={String(opt.value)}
                      type="button"
                      className={`seg-btn${floorPref === opt.value ? ' active' : ''}`}
                      data-floor-pref={String(opt.value)}
                      aria-pressed={floorPref === opt.value}
                      disabled={closed}
                      onClick={() => changeFloorPref(opt.value)}
                    >
                      {opt.label}
                    </button>
                  ))}
                </div>
              </div>
              <p className="omakase-remaining muted small">
                <span className="remaining-floor">
                  1階席 残り{remainingByFloor[1]}席
                  {remainingByFloor[1] < 20 && (
                    <span className="low-seats-badge" data-low-seats={1}>
                      残りわずか
                    </span>
                  )}
                </span>
                <span className="remaining-sep" aria-hidden="true">
                  ／
                </span>
                <span className="remaining-floor">
                  2階席 残り{remainingByFloor[2]}席
                  {remainingByFloor[2] < 20 && (
                    <span className="low-seats-badge" data-low-seats={2}>
                      残りわずか
                    </span>
                  )}
                </span>
              </p>
              {closed ? (
                <p className="closed-notice" data-booking-closed>
                  予約受付は終了しました。当日券は会場受付でお求めください。
                </p>
              ) : (
                <button
                  type="button"
                  className="btn btn-primary btn-block"
                  data-omakase-search
                  onClick={() => {
                    setSearched(true)
                    setSeatTakenNotice(false)
                    setError('')
                  }}
                >
                  席の候補を見る
                </button>
              )}
              {error && <p className="error-text">{error}</p>}
            </div>

            {searched && !closed && (
              <div className="omakase-results">
                {candidates.length === 0 ? (
                  <p className="omakase-soldout" data-omakase-soldout role="status">
                    申し訳ありません。{partySize}名分の席がご用意できませんでした。
                    人数を変えてお試しいただくか、当日券を会場受付でお求めください。
                  </p>
                ) : (
                  <>
                    <div className="candidate-list" data-candidate-list>
                      {candidates.map((cand) => (
                        <article
                          className="candidate-card"
                          key={cand.seatIds.join(',')}
                          data-candidate
                          data-candidate-seats={cand.seatIds.join(',')}
                          data-candidate-class={cand.areaClass}
                        >
                          <h4 className="candidate-label">
                            {cand.label}
                            {cand.split && (
                              <span className="candidate-split-badge">2か所に分かれます</span>
                            )}
                            {cand.restricted && (
                              <span className="candidate-restricted-badge">見切れ席あり</span>
                            )}
                          </h4>
                          <p className="candidate-reason">{cand.reason}</p>
                          <p className="candidate-seats" data-candidate-summary>
                            {cand.summary}
                          </p>
                          {([...new Set(cand.seatIds.map((id) => seatById(id).floor))] as (
                            | 1
                            | 2
                          )[]).map((f) => (
                            <MiniMap
                              key={f}
                              floor={f}
                              highlight={cand.seatIds.filter(
                                (id) => seatById(id).floor === f,
                              )}
                              data={data}
                            />
                          ))}
                          <button
                            type="button"
                            className="btn btn-primary btn-block"
                            data-candidate-pick
                            onClick={() => pickCandidate(cand)}
                          >
                            この席にする
                          </button>
                        </article>
                      ))}
                    </div>
                  </>
                )}
              </div>
            )}
            <p className="muted small omakase-note">
              車椅子席・親子室をご希望の方は、申込フォームの備考欄にご記入ください
            </p>
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
        </>
      )}

      {step === 'form' && (
        <section className="card">
          <h3>お申し込み情報</h3>
          <p className="chosen-seats" data-chosen-seats>
            座席：{selectedSeats.map((s) => s.label).join('、')}
          </p>
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
                  setStep('omakase')
                }}
              >
                候補を選び直す
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
