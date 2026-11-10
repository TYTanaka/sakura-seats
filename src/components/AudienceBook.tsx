import { useEffect, useMemo, useRef, useState } from 'react'
import { ALL_SEATS } from '../data/seats'
import {
  MAX_ONLINE_SEATS,
  accessNeedsSummary,
  defaultTicketType,
  findTicketType,
  formatPerformanceWhen,
  formatYen,
  isBookingClosed,
  isValidPhone,
  normalizeAccessNeeds,
  normalizePhone,
  phoneErrorKind,
  reservationTypeSummary,
  type AccessNeed,
  type Performance,
  type Reservation,
} from '../lib/logic'
import {
  ZONE_DEF_BY_ID,
  ZONE_IDS,
  allZoneAvailability,
  resolveZoneTap,
  zoneAvailability,
  zoneLabel,
  type ZoneId,
} from '../lib/zones'
import { useStore } from '../lib/store'
import SeatsNotice from './SeatsNotice'
import { useNow } from '../lib/useNow'
import { addLastReservation } from '../lib/lastReservation'
import {
  buildCalendarUrl,
  buildGmailUrl,
  buildLineSharePageUrl,
  buildLineShareReservationUrl,
} from '../lib/share'
import posterMainUrl from '../assets/poster-main.webp'
import posterMainJpgUrl from '../assets/poster-main.jpg'
import ReservationQr from './ReservationQr'
import ZoneSeatMap from './ZoneSeatMap'

type Step = 'zone' | 'form' | 'confirm' | 'done'

/**
 * 申込フォームの下書き: 入力途中でリロードしても消えないよう端末内に保持する。
 * 予約が完了したら破棄する。
 * R12 でキーを v2 に更新: 席を選ぶ前提だった v1 の下書き（選択済みの席ID）は
 * 席を確定しないモデルでは意味を持たないため、引き継がず破棄される。
 */
const DRAFT_KEY = 'sakura-seats-booking-draft-v2'

interface BookingDraft {
  name: string
  phone: string
  note: string
  /** 座席の希望（R38・車椅子席/親子室） */
  accessNeeds: AccessNeed[]
  /** 人数分の券種ID（1人目から順に） */
  typeIds: string[]
  /** 申込フロー上のステップも一緒に保持する（リロードでステップだけ戻らないように） */
  step: 'zone' | 'form' | 'confirm'
  /** 人数 */
  partySize: number
  /** 選んだゾーン（未選択は null） */
  zoneId: ZoneId | null
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
    return {
      name: typeof parsed.name === 'string' ? parsed.name : '',
      phone: typeof parsed.phone === 'string' ? parsed.phone : '',
      note: typeof parsed.note === 'string' ? parsed.note : '',
      accessNeeds: normalizeAccessNeeds(parsed.accessNeeds),
      typeIds: Array.isArray(parsed.typeIds)
        ? parsed.typeIds.filter((s): s is string => typeof s === 'string')
        : [],
      step:
        parsed.step === 'form' || parsed.step === 'confirm' ? parsed.step : 'zone',
      partySize: clampPartySize(parsed.partySize, 2),
      zoneId:
        typeof parsed.zoneId === 'string' &&
        (ZONE_IDS as string[]).includes(parsed.zoneId)
          ? (parsed.zoneId as ZoneId)
          : null,
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

/**
 * 入力途中の下書きが「再開すべき状態」で残っているか（R39）。
 * 公演紹介ページ（LP）を入口にしたことで、再訪時に LP を挟むと申込の
 * 途中で離脱した人が LP から入ってしまう。ステップ初期化と同じ条件で
 * 判定し、当てはまる場合は入口側が予約フローへ直接戻すために使う。
 */
export function hasResumableDraft(): boolean {
  const draft = loadDraft()
  return (
    draft !== null &&
    (draft.step === 'form' || draft.step === 'confirm') &&
    draft.zoneId !== null
  )
}

/** 人数分の券種を人数の並びで調整する（足りない分はデフォルト券種で埋める） */
function fitTypeIds(typeIds: string[], partySize: number, fallbackId: string): string[] {
  const next = typeIds.slice(0, partySize)
  while (next.length < partySize) next.push(fallbackId)
  return next
}

/** 人ごとの券種セレクタ（席は未確定なので「1人目」形式で並べる） */
function PartyTypePicker({
  perf,
  typeIds,
  onChange,
}: {
  perf: Performance
  typeIds: string[]
  onChange: (index: number, typeId: string) => void
}) {
  const fallbackId = defaultTicketType(perf).id
  return (
    <div className="seat-type-list">
      {typeIds.map((typeId, index) => {
        const current = typeId || fallbackId
        return (
          <div key={index} className="seat-type-row" data-party-type-row={index}>
            <span className="seat-type-label">{index + 1}人目</span>
            <div className="seg-group" role="group" aria-label={`${index + 1}人目の券種`}>
              {perf.ticketTypes.map((type) => (
                <button
                  key={type.id}
                  type="button"
                  data-party-type={`${index}:${type.id}`}
                  aria-pressed={current === type.id}
                  className={`seg-btn${current === type.id ? ' active' : ''}`}
                  onClick={() => onChange(index, type.id)}
                >
                  {type.name} {formatYen(type.price)}
                </button>
              ))}
            </div>
          </div>
        )
      })}
    </div>
  )
}

/**
 * キャンセル待ち登録フォーム（R38）。全ゾーン完売のときは最初から開き、
 * 一部完売のときはリンクから開ける。登録するとスタッフの受付一覧に載り、
 * キャンセルが出た順に電話連絡を受ける（通知の自動送信はしない）。
 */
function WaitlistForm({
  availability,
  defaultOpen,
}: {
  availability: ReturnType<typeof allZoneAvailability>
  defaultOpen: boolean
}) {
  const { joinWaitlist } = useStore()
  const [open, setOpen] = useState(defaultOpen)
  const [zone, setZone] = useState<string>('any')
  const [partySize, setPartySize] = useState(2)
  const [name, setName] = useState('')
  const [phone, setPhone] = useState('')
  const [error, setError] = useState('')
  const [doneCode, setDoneCode] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)

  const soldOutZones = ZONE_IDS.filter(
    (z) => (availability[z].available) <= 0,
  )

  const handleJoin = async () => {
    setError('')
    if (!name.trim()) {
      setError('お名前を入力してください')
      return
    }
    if (!isValidPhone(normalizePhone(phone))) {
      setError('電話番号の形式が正しくありません')
      return
    }
    setSubmitting(true)
    try {
      const entry = await joinWaitlist({
        zone: zone === 'any' ? null : (zone as ZoneId),
        partySize,
        name,
        phone,
      })
      setDoneCode(entry.id)
    } catch (e) {
      setError(e instanceof Error ? e.message : '登録に失敗しました')
    } finally {
      setSubmitting(false)
    }
  }

  if (doneCode) {
    return (
      <section className="card waitlist-card" data-waitlist-done>
        <h2 className="sec-h">キャンセル待ちを受け付けました</h2>
        <p>
          受付番号は <strong>{doneCode}</strong> です。キャンセルが出ましたら、
          スタッフからお電話でご連絡します（ご連絡できない場合もあります）。
        </p>
      </section>
    )
  }

  if (!open) {
    return (
      <p className="waitlist-open-row">
        <button
          type="button"
          className="btn btn-ghost btn-small"
          data-waitlist-open
          onClick={() => setOpen(true)}
        >
          ご希望のゾーンが満席の場合は、キャンセル待ちに登録できます
        </button>
      </p>
    )
  }

  return (
    <section className="card waitlist-card" data-waitlist-form>
      <h2 className="sec-h">キャンセル待ち登録</h2>
      <p className="muted small">
        満席のゾーンでも、キャンセルが出たらスタッフからお電話します。
        ご希望のゾーンと人数、連絡先をご登録ください。
      </p>
      <label className="field">
        <span>ご希望のゾーン</span>
        <select
          value={zone}
          onChange={(e) => setZone(e.target.value)}
          data-waitlist-zone
        >
          <option value="any">どこでもよい</option>
          {ZONE_IDS.map((z) => (
            <option key={z} value={z} disabled={!soldOutZones.includes(z) && zone !== z}>
              ゾーン{z}
              {soldOutZones.includes(z) ? '（満席）' : '（空きあり・通常予約がおすすめ）'}
            </option>
          ))}
        </select>
      </label>
      <label className="field">
        <span>人数</span>
        <select
          value={partySize}
          onChange={(e) => setPartySize(Number(e.target.value))}
          data-waitlist-party
        >
          {[1, 2, 3, 4, 5, 6, 7, 8].map((n) => (
            <option key={n} value={n}>
              {n}名
            </option>
          ))}
        </select>
      </label>
      <label className="field">
        <span>
          お名前 <em className="required">必須</em>
        </span>
        <input
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="例：山田花子"
          autoComplete="name"
          data-waitlist-name
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
          placeholder="例：090-1111-2222"
          autoComplete="tel"
          data-waitlist-phone
        />
      </label>
      {error && <p className="error-text">{error}</p>}
      <button
        type="button"
        className="btn btn-primary btn-block"
        data-waitlist-submit
        disabled={submitting}
        onClick={() => void handleJoin()}
      >
        {submitting ? '登録中…' : 'キャンセル待ちに登録する'}
      </button>
    </section>
  )
}

export default function AudienceBook({
  perf,
  onBookingDoneChange,
}: {
  perf: Performance
  /** 完了画面の表示状態を親へ伝える（完了中は控え一覧を完了カードの下へ回すため） */
  onBookingDoneChange?: (done: boolean) => void
}) {
  const { data, reserveZone } = useStore()
  const [initialDraft] = useState<BookingDraft | null>(loadDraft)
  // 下書きがあれば入力途中のステップから再開する（ゾーン未選択ならゾーンえらびから）
  const [step, setStep] = useState<Step>(() => {
    const s = initialDraft?.step
    return (s === 'form' || s === 'confirm') && initialDraft?.zoneId ? s : 'zone'
  })
  /** 人数（1〜8名） */
  const [partySize, setPartySize] = useState<number>(() => initialDraft?.partySize ?? 2)
  /** 選んだゾーン（フォーム・確認画面で使う確定済みのゾーン） */
  const [zoneId, setZoneId] = useState<ZoneId | null>(() => initialDraft?.zoneId ?? null)
  /**
   * 仮選択中のゾーン（R14）。座席表の上で光らせ、画面下のバーで確定するまで
   * フォームへは進まない。ゾーン画面で終わった下書きは、次回開いたときに
   * そのゾーンを仮選択済みとして復元する。
   */
  const [selectedZone, setSelectedZone] = useState<ZoneId | null>(() => {
    const s = initialDraft?.step
    return s !== 'form' && s !== 'confirm' ? (initialDraft?.zoneId ?? null) : null
  })
  /** 人ごとの券種指定（人数分。未指定はデフォルト券種） */
  const [typeIds, setTypeIds] = useState<string[]>(() =>
    fitTypeIds(
      initialDraft?.typeIds ?? [],
      initialDraft?.partySize ?? 2,
      defaultTicketType(perf).id,
    ),
  )
  const [name, setName] = useState(() => initialDraft?.name ?? '')
  const [phone, setPhone] = useState(() => initialDraft?.phone ?? '')
  const [note, setNote] = useState(() => initialDraft?.note ?? '')
  /** 座席の希望（R38）: 車椅子席・親子室。申込時に選ぶと受付で専用席が割り当たる */
  const [accessNeeds, setAccessNeeds] = useState<AccessNeed[]>(
    () => initialDraft?.accessNeeds ?? [],
  )
  const toggleAccessNeed = (need: AccessNeed) => {
    setAccessNeeds((prev) =>
      prev.includes(need) ? prev.filter((n) => n !== need) : [...prev, need],
    )
  }
  const [error, setError] = useState('')
  const [completed, setCompleted] = useState<Reservation | null>(null)
  const [submitting, setSubmitting] = useState(false)
  /** 送信時点でゾーンが満席になっていた場合の案内（ゾーン選び直しへ戻す） */
  const [zoneFullNotice, setZoneFullNotice] = useState(false)
  /** 選んだゾーンでは人数分を用意できなかった場合の案内 */
  const [zoneError, setZoneError] = useState<{ zone: ZoneId; remaining: number } | null>(
    null,
  )

  /*
   * ブラウザ履歴との連携（R16・C-5）: ステップを進めるたびに履歴を1つ積み、
   * 端末の「戻る」で申込フローの1つ前のステップへ戻れるようにする。
   * - ゾーン画面での「戻る」は何もしない（通常どおりアプリを離れる）
   * - フォームからの「戻る」はゾーン画面へ（選んでいたゾーンの仮選択も復元・C-4）
   * - 確認画面からの「戻る」はフォームへ（入力はそのまま残る）
   * 「入力に戻る」「ゾーンを選び直す」ボタンも、積んだ履歴があるときは
   * history.back() 経由にして、ボタンと端末の「戻る」の動きを揃える。
   */
  const stepRef = useRef(step)
  stepRef.current = step
  const zoneIdRef = useRef(zoneId)
  zoneIdRef.current = zoneId
  /** 自分で積んだ履歴エントリの残数 */
  const flowDepthRef = useRef(0)
  const historyInitRef = useRef(false)

  const pushFlowEntry = (s: 'form' | 'confirm') => {
    try {
      window.history.pushState({ sakuraBookStep: s }, '')
      flowDepthRef.current += 1
    } catch {
      // 履歴 API が使えない環境では通常のステップ遷移だけ行う
    }
  }

  /** 前へ進む遷移（履歴を積む） */
  const goForward = (next: 'form' | 'confirm') => {
    setStep(next)
    pushFlowEntry(next)
  }

  /** フォーム → ゾーン画面へ戻る（ボタン用。履歴があれば「戻る」と同じ経路） */
  const backToZone = () => {
    setError('')
    if (flowDepthRef.current > 0) {
      window.history.back()
    } else {
      setSelectedZone(zoneId)
      setStep('zone')
    }
  }

  /** 確認画面 → フォームへ戻る（ボタン用） */
  const backToForm = () => {
    if (flowDepthRef.current > 0) {
      window.history.back()
    } else {
      setStep('form')
    }
  }

  // 下書きからフォーム・確認画面で復元された場合は、履歴側も同じ段数だけ
  // 積んでおく（リロード後でも「戻る」が効くように）
  useEffect(() => {
    if (historyInitRef.current) return
    historyInitRef.current = true
    const s = stepRef.current
    if (s === 'form') {
      pushFlowEntry('form')
    } else if (s === 'confirm') {
      pushFlowEntry('form')
      pushFlowEntry('confirm')
    }
  }, [])

  useEffect(() => {
    const onPopState = () => {
      if (flowDepthRef.current > 0) flowDepthRef.current -= 1
      const s = stepRef.current
      if (s === 'confirm') {
        setStep('form')
      } else if (s === 'form') {
        // ゾーン画面へ戻るときは、選んでいたゾーンを仮選択に戻す（C-4）
        setSelectedZone(zoneIdRef.current)
        setStep('zone')
      }
      // ゾーン画面・完了画面では何もしない（通常の離脱に任せる）
    }
    window.addEventListener('popstate', onPopState)
    return () => window.removeEventListener('popstate', onPopState)
  }, [])

  // 締切は「今」を定期的に再評価して判定する（開いたまま締切を跨いでも追随する）
  const nowMs = useNow(10000)
  const closed = isBookingClosed(data, new Date(nowMs))
  /** 開いている間に締切を跨いだことを知らせる表示 */
  const [deadlinePassed, setDeadlinePassed] = useState(false)
  const wasClosedRef = useRef(closed)
  useEffect(() => {
    const was = wasClosedRef.current
    wasClosedRef.current = closed
    if (!closed || was) return
    // 締切を跨いだ瞬間: フォーム途中ならゾーンえらびへ戻して詰み状態を防ぐ
    if (step === 'form' || step === 'confirm') {
      setStep('zone')
      setDeadlinePassed(true)
    }
  }, [closed, step])

  // 入力内容を下書きとして保持する（ステップ・人数・ゾーンも含める。全て空なら破棄）
  // ゾーン画面では「仮選択中のゾーン」を下書きのゾーンとして保存し、
  // 次回開いたときに仮選択済みの状態で復元できるようにする（R14）。
  useEffect(() => {
    if (step === 'done') return
    const draftZoneId = step === 'zone' ? (selectedZone ?? zoneId) : zoneId
    try {
      if (!name && !phone && !note && accessNeeds.length === 0 && draftZoneId === null) {
        localStorage.removeItem(DRAFT_KEY)
      } else {
        const draft: BookingDraft = {
          name,
          phone,
          note,
          accessNeeds,
          typeIds,
          step: step === 'form' || step === 'confirm' ? step : 'zone',
          partySize,
          zoneId: draftZoneId,
        }
        localStorage.setItem(DRAFT_KEY, JSON.stringify(draft))
      }
    } catch {
      // 保存できなくても画面操作は継続する
    }
  }, [name, phone, note, accessNeeds, typeIds, step, partySize, zoneId, selectedZone])

  // 「人数分を用意できない」案内は画面下に一時的に出す（数秒で自動で消える）
  useEffect(() => {
    if (!zoneError) return
    const t = window.setTimeout(() => setZoneError(null), 6000)
    return () => window.clearTimeout(t)
  }, [zoneError])

  // 完了画面の表示中かどうかを親へ伝える（控え一覧の配置切り替え用）
  useEffect(() => {
    onBookingDoneChange?.(step === 'done')
  }, [step, onBookingDoneChange])

  // ゾーンごとの空き状況は現在の占有状態から都度計算する
  // （誰かが予約すれば残り席数・満席表示へ反映される）
  const availability = useMemo(() => allZoneAvailability(data), [data])

  const total = typeIds.reduce(
    (sum, typeId) => sum + (findTicketType(perf, typeId)?.price ?? 0),
    0,
  )
  const zoneDef = zoneId ? ZONE_DEF_BY_ID.get(zoneId) : undefined
  /** 券種内訳の表示（「大人×1・子供×1」） */
  const typeBreakdown = useMemo(() => {
    const counts = new Map<string, number>()
    for (const typeId of typeIds) {
      const typeName = findTicketType(perf, typeId)?.name ?? typeId
      counts.set(typeName, (counts.get(typeName) ?? 0) + 1)
    }
    return [...counts.entries()].map(([n, c]) => `${n}×${c}`).join('・')
  }, [typeIds, perf])

  const changePartySize = (next: number) => {
    const size = Math.min(MAX_ONLINE_SEATS, Math.max(1, next))
    setPartySize(size)
    setTypeIds((prev) => fitTypeIds(prev, size, defaultTicketType(perf).id))
    setZoneFullNotice(false)
    setZoneError(null)
  }

  /**
   * ゾーンのタップ（R14: 2段階選択の1段目）。
   * いきなりフォームへは進まず、座席表の上でゾーンを仮選択するだけにする。
   * お客様は座席表を見たまま、画面下のバーで確認してから進む。
   * - 座席表（セル・バッジ）からのタップではスクロールしない（見ている場所を保つ）
   * - 一覧からのタップでは、そのゾーンのバッジが画面内に入るよう座席表へ寄せる
   * - 人数分を用意できないゾーンは仮選択せず、画面下に案内を出す
   */
  const handleZoneTap = (zone: ZoneId, source: 'map' | 'list') => {
    if (closed) return
    setError('')
    setZoneFullNotice(false)
    const outcome = resolveZoneTap(
      selectedZone,
      zone,
      zoneAvailability(data, zone),
      partySize,
    )
    if (outcome.kind === 'insufficient') {
      setZoneError({ zone: outcome.zone, remaining: outcome.remaining })
      return
    }
    setZoneError(null)
    // 仮選択中のゾーンの再タップは選択維持（R16・C-3）。解除は「やめる」だけ
    setSelectedZone(outcome.zone)
    if (source === 'list') {
      const target =
        document.querySelector(`[data-zone-badge="${outcome.zone}"]`) ??
        document.querySelector('[data-zone-map]')
      target?.scrollIntoView({ behavior: 'smooth', block: 'center' })
    }
  }

  /** 仮選択の解除（画面下のバーの「やめる」） */
  const clearSelection = () => setSelectedZone(null)

  /**
   * ゾーンの確定（2段階選択の2段目）: 残席を再確認してフォームへ進む。
   * 仮選択のあいだに残席が減って人数分を割った場合は、案内を出して
   * 仮選択を解き、ゾーン選び直しに留まる。
   */
  const confirmSelection = () => {
    if (!selectedZone || closed) return
    const avail = zoneAvailability(data, selectedZone)
    if (avail.available < partySize) {
      setZoneError({ zone: selectedZone, remaining: avail.available })
      setSelectedZone(null)
      return
    }
    setZoneError(null)
    setZoneId(selectedZone)
    setSelectedZone(null)
    goForward('form')
    window.scrollTo({ top: 0 })
  }

  /**
   * 二重送信の同期的ガード（R25・ラウンド10 G-3）。
   * submitting state は再描画を経てから効くため、同一タスク内の連続発火
   * （ボタンの同期的3連打など）では素通りしてしまう。ref は代入した瞬間から
   * 効くので、state と二重化して送信そのものを1回に止める。
   */
  const submitGuardRef = useRef(false)

  const handleSubmit = async () => {
    if (!zoneId) return
    if (submitGuardRef.current) return
    submitGuardRef.current = true
    setError('')
    setSubmitting(true)
    try {
      const reservation = await reserveZone({
        zone: zoneId,
        typeIds,
        name,
        // 電話番号は正規化した数字のみで保存する（照会側も同じ形で比較する）
        phone: normalizePhone(phone),
        note,
        // R38: 座席の希望（車椅子席・親子室）
        accessNeeds,
      })
      clearDraft()
      // 完了画面がリロードで消えても再表示できるよう、端末に控えを残す
      addLastReservation({
        code: reservation.id,
        performanceName: perf.name,
        whenText: formatPerformanceWhen(perf),
        seatLabels: [],
        amount: reservation.amount,
        savedAt: new Date().toISOString(),
        perfDate: perf.date,
        perfTime: perf.time,
        qrToken: reservation.qrToken,
        // R12: 席は未確定。控えにはゾーンと人数を残す
        zoneLabel: zoneLabel(zoneId),
        partySize,
        // R25: 控えの現在状態（キャンセル済み等）を後から照会で取り直すため、
        // 申込時の電話番号（正規化済み）も一緒に残す
        phone: normalizePhone(phone),
      })
      setCompleted(reservation)
      setStep('done')
    } catch (e) {
      const message = e instanceof Error ? e.message : '予約に失敗しました'
      if (message.includes('満席')) {
        // 送信時点で満席になっていた: ゾーン選び直しへ戻して案内する
        setZoneFullNotice(true)
        setStep('zone')
        window.scrollTo({ top: 0 })
      } else {
        setError(message)
      }
    } finally {
      setSubmitting(false)
      submitGuardRef.current = false
    }
  }

  const resetFlow = () => {
    clearDraft()
    setTypeIds(fitTypeIds([], 2, defaultTicketType(perf).id))
    setPartySize(2)
    setName('')
    setPhone('')
    setNote('')
    setAccessNeeds([])
    setError('')
    setCompleted(null)
    setZoneId(null)
    setSelectedZone(null)
    setZoneError(null)
    setZoneFullNotice(false)
    setStep('zone')
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
        <ReservationQr code={completed.id} token={completed.qrToken} />
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
            <dt>ゾーン</dt>
            <dd data-done-zone>
              {completed.zone ? (
                <>
                  <span className="u-nowrap">{zoneLabel(completed.zone).split('（')[0]}</span>
                  {zoneLabel(completed.zone).includes('（') && (
                    <span className="u-nowrap">（{zoneLabel(completed.zone).split('（')[1]}</span>
                  )}
                </>
              ) : (
                ''
              )}
              <br />
              {completed.items.length}名（{reservationTypeSummary(completed)}）
            </dd>
          </div>
          {(completed.accessNeeds ?? []).length > 0 && (
            <div>
              <dt>座席の希望</dt>
              <dd data-done-access-needs>
                {accessNeedsSummary(completed.accessNeeds)}
              </dd>
            </div>
          )}
          <div>
            <dt>合計</dt>
            <dd className="detail-total">{formatYen(completed.amount)}</dd>
          </div>
        </dl>
        <div className="notice-box">
          <p data-seats-undecided>
            <SeatsNotice />。<span className="u-nowrap">お支払いまたは受付が済みましたら、</span><span className="u-nowrap">このページの「予約確認」から</span><span className="u-nowrap">座席番号をご確認いただけます。</span>
          </p>
          <p>当日は受付でお名前と予約番号をお伝えのうえ、現金でお支払いください。</p>
          <p>変更は主催者までご連絡ください。キャンセルは『予約確認』からもできます。</p>
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
          ゾーン選択に戻る
        </button>
      </section>
    )
  }

  return (
    <div
      className={`book-flow${
        step === 'zone' && (selectedZone || zoneError) ? ' has-floating-bar' : ''
      }`}
    >
      {step === 'zone' && (
        <>
          {deadlinePassed && (
            <p className="closed-notice deadline-passed-notice" data-deadline-passed role="status">
              予約締切を過ぎたため、受付を終了しました。
            </p>
          )}
          {zoneFullNotice && (
            <p className="seat-taken-notice" data-zone-full role="status">
              申し訳ありません。選んだゾーンは満席になりました。別のゾーンをお選びください
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
            <span className="muted small">家族や友だちにLINEで共有できます</span>
          </div>
          <section id="seat-picker" className={`card zone-card${closed ? ' is-closed' : ''}`}>
            <h2 className="sec-h">ゾーンを選んで予約</h2>
            <p className="muted small zone-lead">
              ゾーンをタップし、画面下の<span className="u-nowrap">「このゾーンで進む」</span>で決定。座席表の下のゾーン一覧からも選べます。座席番号はお支払い時、または当日の受付時に確定します。
            </p>
            <div className="zone-controls">
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
              {/* R25（ラウンド10・G-1）: 上限に達したら理由と次の手を出す。
                  以前はステッパーが8名で静かに止まり、団体客が理由も
                  申し込み方も分からなかった */}
              {/* R26（ラウンド11・N5-1）: role="status"（aria-live="polite" 相当）を
                  付け、スクリーンリーダーにも理由と次の手が能動的に伝わるようにする。
                  同種の一次的な案内（締切・満席の注記、トースト）は既に status 付き */}
              {partySize >= MAX_ONLINE_SEATS && (
                <p className="party-cap-note" data-party-cap-note role="status">
                  一度に申し込めるのは{MAX_ONLINE_SEATS}名までです。
                  9名以上の場合は、続けて2回に分けてお申し込みいただくか、
                  主催者へご連絡ください。
                </p>
              )}
              <p className="zone-price-note muted small">
                料金は全ゾーン一律です（
                {perf.ticketTypes
                  .map((t) => `${t.name} ${formatYen(t.price)}`)
                  .join('／')}
                ）
              </p>
            </div>
            {closed ? (
              <p className="closed-notice" data-booking-closed>
                予約受付は終了しました。当日券は会場受付でお求めください。
              </p>
            ) : (
              <>
                <ZoneSeatMap
                  data={data}
                  availability={availability}
                  onPick={handleZoneTap}
                  disabled={closed}
                  selectedZone={selectedZone}
                />
              </>
            )}
            {error && <p className="error-text">{error}</p>}
            <p className="muted small zone-note">
              車椅子席・親子室は、次の申込フォームで「座席の希望」としてお選びいただけます（選ぶと受付で専用席をご用意します）
            </p>
            <p className="muted small">
              全{ALL_SEATS.length}席（ゾーン対象461席＋車椅子席・親子室）
            </p>
          </section>
          {/* R38: キャンセル待ち。全ゾーン完売なら開いた状態で出し、
              一部完売ならリンクから開ける */}
          {!closed &&
            ZONE_IDS.some((z) => (availability[z].available) <= 0) && (
              <WaitlistForm
                availability={availability}
                defaultOpen={ZONE_IDS.every(
                  (z) => (availability[z].available) <= 0,
                )}
              />
            )}
          <section className="card poster-card">
            <h2 className="sec-h">公演ポスター</h2>
            <a
              className="poster-link"
              href={posterMainUrl}
              target="_blank"
              rel="noreferrer"
              aria-label="公演ポスターを大きく見る"
            >
              <picture>
                <source srcSet={posterMainUrl} type="image/webp" />
                <img
                  src={posterMainJpgUrl}
                  alt="劇団ツインリーブス 2027年5月公演 ポスター"
                  loading="lazy"
                />
              </picture>
            </a>
            <p className="poster-caption">劇団ツインリーブス 2027年5月公演</p>
          </section>

          {/* 仮選択の確定バー（R14）: 座席表を見たまま決められるよう画面下に固定する */}
          {selectedZone && !closed && (
            <div className="zone-decision-bar" data-zone-decision-bar>
              <div className="zdb-info">
                <span className="zdb-zone" data-decision-zone>
                  {/* R31: ゾーン名と（階・位置）を別々の塊にし、塊の途中では割らない */}
                  <span className="u-nowrap">{zoneLabel(selectedZone).split('（')[0]}</span>
                  {zoneLabel(selectedZone).includes('（') && (
                    <span className="u-nowrap">（{zoneLabel(selectedZone).split('（')[1]}</span>
                  )}
                </span>
                <span className="zdb-meta" data-decision-meta>
                  <span className="u-nowrap">残り{availability[selectedZone].available}席</span>・
                  <span className="u-nowrap">{partySize}名で申込</span>
                </span>
              </div>
              <div className="zdb-actions">
                <button
                  type="button"
                  className="btn btn-ghost zdb-btn"
                  data-decision-cancel
                  onClick={clearSelection}
                >
                  やめる
                </button>
                <button
                  type="button"
                  className="btn btn-primary zdb-btn"
                  data-decision-confirm
                  onClick={confirmSelection}
                >
                  このゾーンで進む
                </button>
              </div>
            </div>
          )}

          {/* 人数分を用意できない案内（R14）: タップした場所によらず画面下に出す */}
          {zoneError && (
            <div
              className={`zone-bottom-notice${selectedZone ? ' has-bar' : ''}`}
              data-zone-error
              role="alert"
            >
              <span>
                このゾーンでは{partySize}名分をご用意できません（残り
                {zoneError.remaining}席）。別のゾーンをお選びください
              </span>
              <button
                type="button"
                className="zbn-close"
                aria-label="案内を閉じる"
                onClick={() => setZoneError(null)}
              >
                ×
              </button>
            </div>
          )}
        </>
      )}

      {step === 'form' && zoneId && (
        <section className="card">
          <h2 className="sec-h">お申し込み情報</h2>
          <p className="chosen-seats" data-chosen-zone>
            ゾーン：{zoneLabel(zoneId)}／{partySize}名
          </p>
          {zoneDef && <p className="muted small">{zoneDef.description}</p>}
          <p className="muted small" data-seats-undecided>
            <SeatsNotice />（ゾーンの中で並んだ席をご用意します）
          </p>
          {/* 選んだゾーンの位置を座席表でも確認できるようにする（操作できない静止画） */}
          <div className="form-zone-map">
            <ZoneSeatMap
              data={data}
              availability={availability}
              onPick={() => {}}
              disabled
              mini
              selectedZone={zoneId}
            />
          </div>
          <h3 className="form-subhead">人数と券種</h3>
          <PartyTypePicker
            perf={perf}
            typeIds={typeIds}
            onChange={(index, typeId) =>
              setTypeIds((prev) => prev.map((t, i) => (i === index ? typeId : t)))
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
                // R16・C-2: 形は合っているのに偽番号パターンで弾かれた場合は、
                // 打ち直しても通らないので「別の番号で」と案内を分ける
                setError(
                  phoneErrorKind(phone) === 'fake'
                    ? 'この番号は受付できません。スマートフォンの電話番号など、別の番号でお試しください（お持ちでない場合は主催者へご連絡ください）'
                    : '電話番号の形式をご確認ください（携帯電話・固定電話などの番号を入力してください。全角数字やハイフンはそのまま使えます）',
                )
                return
              }
              // 確認画面・保存は正規化した数字のみの形に統一する
              setPhone(normalizePhone(phone))
              setError('')
              goForward('confirm')
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
                placeholder="例：090-1111-2222"
                autoComplete="tel"
              />
            </label>
            {/* R38（H1）: 車椅子席・親子室の希望申込。選ぶと受付時の割当で
                専用席が割り当たる（従来の備考欄への自由記述だけでは
                割当の仕組みと結びつかなかった） */}
            <fieldset className="field access-needs-field" data-access-needs>
              <legend>座席の希望（任意）</legend>
              <label className="check-row">
                <input
                  type="checkbox"
                  data-access-need="wheelchair"
                  checked={accessNeeds.includes('wheelchair')}
                  onChange={() => toggleAccessNeed('wheelchair')}
                />
                <span>車椅子席を希望します</span>
              </label>
              <label className="check-row">
                <input
                  type="checkbox"
                  data-access-need="parentRoom"
                  checked={accessNeeds.includes('parentRoom')}
                  onChange={() => toggleAccessNeed('parentRoom')}
                />
                <span>親子室を希望します</span>
              </label>
              <p className="muted small">
                希望を選ぶと、当日の受付で専用席をご用意します。車椅子席は
                ご本人様分として1席をご用意し、付き添いの方にはお選びのゾーンの
                席をご用意します。
              </p>
            </fieldset>
            <label className="field">
              <span>備考（任意）</span>
              <textarea
                value={note}
                onChange={(e) => setNote(e.target.value)}
                rows={3}
                placeholder="例：車椅子席の付き添いです、ベビーカーを預けたい、など"
              />
            </label>
            {/* 個人情報の取り扱い（R28）: 名前・電話の入力欄のすぐ近くに置く。
                実際の取り扱い（予約管理と当日受付のみ・アプリのデータベースに
                保存され劇団スタッフが確認する）だけを短く正直に書く */}
            <details className="privacy-note" data-privacy-note>
              <summary>個人情報の取り扱いについて</summary>
              <p>
                お名前と電話番号は、ご予約の管理と当日の受付<span className="u-nowrap">のためにのみ使います。</span>
                予約データはこのアプリの<span className="u-nowrap">データベースに保存され、</span>劇団ツインリーブスの
                スタッフが確認します。それ以外の目的で<span className="u-nowrap">使うことはありません。</span>
              </p>
            </details>
            {error && <p className="error-text">{error}</p>}
            <div className="btn-row">
              <button
                type="button"
                className="btn btn-ghost"
                onClick={backToZone}
              >
                ゾーンを選び直す
              </button>
              <button type="submit" className="btn btn-primary">
                確認画面へ
              </button>
            </div>
          </form>
        </section>
      )}

      {step === 'confirm' && zoneId && (
        <section className="card">
          <h2 className="sec-h">お申し込み内容の確認</h2>
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
              <dt>ゾーン</dt>
              <dd data-confirm-zone>
                {zoneLabel(zoneId)}／{partySize}名
              </dd>
            </div>
            <div>
              <dt>券種内訳</dt>
              <dd>{typeBreakdown}</dd>
            </div>
            <div>
              <dt>お名前</dt>
              <dd>{name} 様</dd>
            </div>
            <div>
              <dt>電話番号</dt>
              <dd>{phone}</dd>
            </div>
            {accessNeeds.length > 0 && (
              <div>
                <dt>座席の希望</dt>
                <dd data-confirm-access-needs>{accessNeedsSummary(accessNeeds)}</dd>
              </div>
            )}
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
          <p className="muted small" data-seats-undecided>
            <SeatsNotice />。お支払いまたは受付の後、「予約確認」ページで<span className="u-nowrap">座席番号をご確認いただけます。</span>
          </p>
          {error && <p className="error-text">{error}</p>}
          <div className="btn-row">
            <button type="button" className="btn btn-ghost" onClick={backToForm}>
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
