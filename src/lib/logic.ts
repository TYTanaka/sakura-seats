import { ALL_SEATS, SEAT_BY_ID, type Floor } from '../data/seats'
import { generateQrToken, isQrToken } from './qrToken'

/**
 * 予約・販売ロジック（純粋関数群）。
 * 公演は1回のみという前提のため、公演は単一の設定オブジェクトとして保持する。
 * ストア（localStorage）はこのデータ構造を保持するだけにし、
 * 将来 Supabase バックエンドへ差し替える際もこの層をサーバ側へ移せるようにする。
 *
 * 料金は「券種」（大人・子供など）ごとに設定し、予約は席ごとに
 * 券種名と料金をスナップショットとして記録する。後から公演設定の
 * 券種を変更・削除しても、記録済み予約の金額は変わらない。
 */

export interface TicketType {
  id: string
  name: string
  /** 1席あたりの料金（円・整数） */
  price: number
}

export interface Performance {
  name: string
  /** YYYY-MM-DD */
  date: string
  /** 開演時刻 HH:mm */
  time: string
  /** 開場時刻 HH:mm */
  doorsOpen: string
  /** 券種リスト。先頭がデフォルト券種 */
  ticketTypes: TicketType[]
  /** 料金に関する自由記述の注記（お客様画面の券種選択付近に表示） */
  priceNote: string
  note: string
  /**
   * 販売者名リスト（手売り・当日販売の記録用）。
   * 設定は JSON のまま保存され、スタッフの当日販売で選択して予約に記録する。
   */
  sellerNames: string[]
}

export type ReservationSource = 'online' | 'door'

/**
 * 座席の希望（R38）: 車椅子席・親子室はゾーンに属さない専用席のため、
 * ゾーン予約とは別に「希望」として申込時に受け付け、受付時の割当で
 * 専用席を割り当てられるようにする。値は DB の access_needs（text[]）と一致。
 */
export type AccessNeed = 'wheelchair' | 'parentRoom'

export const ACCESS_NEEDS: AccessNeed[] = ['wheelchair', 'parentRoom']

export const ACCESS_NEED_LABELS: Record<AccessNeed, string> = {
  wheelchair: '車椅子席',
  parentRoom: '親子室',
}

/** 希望の正規化: 'wheelchair' / 'parentRoom' の文字列だけを重複なく拾う */
export function normalizeAccessNeeds(raw: unknown): AccessNeed[] {
  if (!Array.isArray(raw)) return []
  const out: AccessNeed[] = []
  for (const value of raw) {
    if (
      (value === 'wheelchair' || value === 'parentRoom') &&
      !out.includes(value)
    ) {
      out.push(value)
    }
  }
  return out
}

/** 希望の表示文（「車椅子席・親子室」の形。無ければ空文字） */
export function accessNeedsSummary(needs: readonly AccessNeed[] | undefined): string {
  if (!needs || needs.length === 0) return ''
  return needs.map((n) => ACCESS_NEED_LABELS[n]).join('・')
}

/** 予約の明細行：席ごとの券種スナップショット */
export interface ReservationItem {
  seatId: string
  /** 予約時点の券種ID（設定から削除されても参照用に残す） */
  typeId: string
  /** 予約時点の券種名（スナップショット） */
  typeName: string
  /** 予約時点の料金（円・スナップショット） */
  price: number
}

export interface Reservation {
  /** 予約番号 SK-0001 形式 */
  id: string
  /** クラウドモード時の Supabase 行 UUID（ローカルモードでは未設定） */
  cloudId?: string
  seatIds: string[]
  /** 席ごとの券種明細。seatIds と同じ順序・同じ席集合 */
  items: ReservationItem[]
  name: string
  phone: string
  note: string
  source: ReservationSource
  /** 記録された金額（円）= 明細の料金合計。金額の正はこの値 */
  amount: number
  checkedIn: boolean
  paid: boolean
  cancelled: boolean
  createdAt: string
  /**
   * 販売者（手売り・当日販売でスタッフが選択した場合のみ記録）。
   * Web予約や販売者を選ばなかった販売では未設定。
   */
  seller?: string
  /**
   * 受付用 QR トークン（R7）。予約ごとに発行する推測不能な値で、
   * QR にはこのトークンだけを入れる（予約番号は入れない＝偽装防止）。
   * この項目が追加される前に作られた予約・控えには無いため任意項目。
   */
  qrToken?: string
  /** 受付（来場チェックイン）した日時 ISO。未受付は null/未設定 */
  checkedInAt?: string | null
  /** 予約時点の公演日スナップショット（YYYY-MM-DD）。QR受付の公演照合用 */
  perfDate?: string
  /** 予約時点の公演名スナップショット。QR受付の公演照合用 */
  perfName?: string
  /**
   * ゾーン予約のゾーンID（R12・'A'〜'I'）。未設定は従来型の予約
   * （席が予約時点で確定している予約・当日販売）。
   * ゾーン予約は支払いまで明細の seatId が空文字＝席未確定で、
   * 支払い時に席が割り当てられて初めて seatIds が入る。
   */
  zone?: string
  /**
   * 座席の希望（R38）: 車椅子席・親子室の希望。申込時に受け付け、
   * 受付時の割当で専用席を割り当てるために使う。希望なしは未設定/空。
   */
  accessNeeds?: AccessNeed[]
  /**
   * 返金済みかどうか（R38・公演中止時の返金管理用）。
   * 支払済みの予約に対してスタッフが返金したら記録する。
   */
  refunded?: boolean
  /** 返金済みにした日時 ISO（未返金は null/未設定） */
  refundedAt?: string | null
  /**
   * 受付（来場チェックイン）を処理した担当者名（R38）。
   * スタッフ画面で選択中の担当者（販売者リスト流用）が記録される。
   * 記録がない予約・担当者未選択時は未設定。
   */
  checkedInBy?: string
  /**
   * 支払い確定を処理した担当者名（R38）。checkedInBy と同じ作法。
   * 集計の「担当者別内訳（受取）」の根拠になる。
   */
  paidBy?: string
}

/**
 * キャンセル待ちの登録（R38）。完売時に観客がゾーン＋人数＋電話番号で
 * 登録し、スタッフがキャンセル発生時に電話連絡するための一覧。
 * 通知送信は行わない（一覧までが役割）。
 */
export interface WaitlistEntry {
  /** 登録番号 WL-0001 形式 */
  id: string
  /** 希望ゾーン（'A'〜'I'）。null は「どこでもよい」 */
  zone: string | null
  /** 人数（1〜8） */
  partySize: number
  name: string
  /** 正規化済みの電話番号（数字のみ） */
  phone: string
  createdAt: string
}

export interface AppData {
  performance: Performance
  reservations: Reservation[]
  /** 販売しない席IDの配列 */
  blocked: string[]
  /** 予約番号の採番カウンタ */
  seq: number
  /**
   * 予約締切（datetime-local 形式 'YYYY-MM-DDTHH:mm' または ISO文字列）。
   * null は締切なし。過ぎたらオンライン予約は受け付けない（当日販売は影響なし）。
   */
  bookingDeadline: string | null
  /**
   * クラウドモード専用: サーバから取得した座席の占有状態。
   * 設定されている場合は reservations よりこちらを優先して席状態を決める
   * （お客様画面では他人の予約明細を持たないため）。
   */
  seatStates?: Record<string, 'reserved' | 'sold'>
  /**
   * クラウドモード専用（R12）: ゾーンごとの「未割当ホールド人数」の集計。
   * サーバの get_public_state が集計だけを返す（誰の予約かは含まない）。
   * ゾーン残席の計算に使う。ローカルモードでは未設定で、
   * reservations から同じ数を導出する（zones.ts の zoneAvailability）。
   */
  zoneHolds?: Record<string, number>
  /** キャンセル待ち登録の一覧（R38） */
  waitlist: WaitlistEntry[]
  /** キャンセル待ちの採番カウンタ（R38） */
  waitlistSeq: number
}

export type SeatStatus = 'available' | 'reserved' | 'paid' | 'blocked'

/** オンライン申込の最大選択席数 */
export const MAX_ONLINE_SEATS = 8

export function defaultTicketTypes(): TicketType[] {
  return [
    { id: 'adult', name: '大人', price: 2000 },
    { id: 'child', name: '子供', price: 1000 },
  ]
}

/** 開場時刻のデフォルト: 開演の30分前 */
export function defaultDoorsOpen(time: string): string {
  const m = /^(\d{1,2}):(\d{2})$/.exec(time.trim())
  if (!m) return '12:30'
  const total = Number(m[1]) * 60 + Number(m[2]) - 30
  const wrapped = ((total % 1440) + 1440) % 1440
  const hh = String(Math.floor(wrapped / 60)).padStart(2, '0')
  const mm = String(wrapped % 60).padStart(2, '0')
  return `${hh}:${mm}`
}

export function defaultPerformance(): Performance {
  return {
    name: 'サンプル公演',
    date: '2026-12-19',
    time: '13:00',
    doorsOpen: '12:30',
    ticketTypes: defaultTicketTypes(),
    priceNote: '子供料金は小学生以下が対象です。',
    note: '劇団ツインリーブス 2027年5月公演。おとぎ話の世界でお待ちしています！',
    sellerNames: [],
  }
}

export function emptyData(): AppData {
  return {
    performance: defaultPerformance(),
    reservations: [],
    blocked: [],
    seq: 0,
    bookingDeadline: null,
    waitlist: [],
    waitlistSeq: 0,
  }
}

/** 券種IDから現在の設定を引く（削除済みなら undefined） */
export function findTicketType(perf: Performance, typeId: string): TicketType | undefined {
  return perf.ticketTypes.find((t) => t.id === typeId)
}

/** デフォルト券種（リスト先頭）。設定は常に1件以上ある前提 */
export function defaultTicketType(perf: Performance): TicketType {
  return perf.ticketTypes[0]
}

/* ---------------- 旧データ移行（localStorage の正規化） ---------------- */

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null
    ? (value as Record<string, unknown>)
    : null
}

function asString(value: unknown, fallback: string): string {
  return typeof value === 'string' ? value : fallback
}

function asPrice(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? Math.floor(value)
    : null
}

function normalizeTicketTypes(rawTypes: unknown, legacyPrice: unknown): TicketType[] {
  if (Array.isArray(rawTypes)) {
    const types: TicketType[] = []
    for (const raw of rawTypes) {
      const rec = asRecord(raw)
      if (!rec) continue
      const price = asPrice(rec.price)
      const name = asString(rec.name, '').trim()
      const id = asString(rec.id, '').trim()
      if (price !== null && name && id) types.push({ id, name, price })
    }
    if (types.length > 0) return types
  }
  // 旧形式（単価のみ）からの移行: 大人 = 旧単価、子供 = 1,000円 を種別として作る
  const adultPrice = asPrice(legacyPrice) ?? 2000
  return [
    { id: 'adult', name: '大人', price: adultPrice },
    { id: 'child', name: '子供', price: 1000 },
  ]
}

/** 販売者名リストの正規化: 文字列だけ・前後空白除去・空と重複を除く */
export function normalizeSellerNames(raw: unknown): string[] {
  if (!Array.isArray(raw)) return []
  const seen = new Set<string>()
  const names: string[] = []
  for (const value of raw) {
    if (typeof value !== 'string') continue
    const name = value.trim()
    if (!name || seen.has(name)) continue
    seen.add(name)
    names.push(name)
  }
  return names
}

export function normalizePerformance(raw: unknown): Performance {
  const rec = asRecord(raw)
  if (!rec) return defaultPerformance()
  const fallback = defaultPerformance()
  const time = asString(rec.time, fallback.time)
  const rawDoors = asString(rec.doorsOpen, '')
  return {
    name: asString(rec.name, fallback.name),
    date: asString(rec.date, fallback.date),
    time,
    // 旧データ（開場時刻なし）は開演の30分前をデフォルトにする
    doorsOpen: /^\d{1,2}:\d{2}$/.test(rawDoors.trim())
      ? rawDoors.trim()
      : defaultDoorsOpen(time),
    ticketTypes: normalizeTicketTypes(rec.ticketTypes, rec.price),
    priceNote: asString(rec.priceNote, ''),
    note: asString(rec.note, ''),
    sellerNames: normalizeSellerNames(rec.sellerNames),
  }
}

/** 金額を席数で均等に割り、端数は先頭の席から1円ずつ配る（旧予約の明細合成用） */
function distributeAmount(seatIds: string[], amount: number, type: TicketType): ReservationItem[] {
  const n = seatIds.length
  const base = Math.floor(amount / n)
  const remainder = amount - base * n
  return seatIds.map((seatId, i) => ({
    seatId,
    typeId: type.id,
    typeName: type.name,
    price: base + (i < remainder ? 1 : 0),
  }))
}

export function normalizeReservation(
  raw: unknown,
  defaultType: TicketType,
  fallbackUnitPrice: number,
): Reservation | null {
  const rec = asRecord(raw)
  if (!rec) return null
  const id = asString(rec.id, '')
  if (!id) return null

  /** R12: ゾーン予約のゾーンID（従来型の予約には無い） */
  const zone =
    typeof rec.zone === 'string' && rec.zone.trim() ? rec.zone.trim() : undefined

  const rawItems = Array.isArray(rec.items) ? rec.items : []
  const itemSeatIds: string[] = []
  const items: ReservationItem[] = []
  let itemsValid = rawItems.length > 0
  for (const rawItem of rawItems) {
    const itemRec = asRecord(rawItem)
    const seatId = itemRec ? asString(itemRec.seatId, '') : ''
    const price = itemRec ? asPrice(itemRec.price) : null
    // seatId はゾーン予約（未割当）では空文字が正しい形なので、
    // 空そのものは不正にしない（価格が読めない明細だけを不正とする）
    if (!itemRec || price === null) {
      itemsValid = false
      break
    }
    itemSeatIds.push(seatId)
    items.push({
      seatId,
      typeId: asString(itemRec.typeId, defaultType.id) || defaultType.id,
      typeName: asString(itemRec.typeName, defaultType.name) || defaultType.name,
      price,
    })
  }

  const seatIds = (
    Array.isArray(rec.seatIds)
      ? rec.seatIds.filter((s): s is string => typeof s === 'string' && s.length > 0)
      : itemSeatIds
  ).filter((s) => s.length > 0)

  // R12: ゾーン予約で席がまだ割り当たっていない形（明細はあるが席が無い）
  const isUnassignedZone =
    zone !== undefined &&
    seatIds.length === 0 &&
    itemsValid &&
    items.length > 0 &&
    items.every((i) => i.seatId === '')
  if (seatIds.length === 0 && !isUnassignedZone) return null

  const recordedAmount = asPrice(rec.amount)
  let finalItems: ReservationItem[]
  let amount: number
  if (isUnassignedZone) {
    finalItems = items
    amount = recordedAmount ?? items.reduce((sum, i) => sum + i.price, 0)
  } else if (itemsValid && JSON.stringify(itemSeatIds) === JSON.stringify(seatIds)) {
    const itemsSum = items.reduce((sum, i) => sum + i.price, 0)
    if (recordedAmount !== null && recordedAmount !== itemsSum) {
      // 記録金額が正。明細合計とズレる場合は金額に合わせて明細を組み直す
      finalItems = distributeAmount(seatIds, recordedAmount, defaultType)
      amount = recordedAmount
    } else {
      finalItems = items
      amount = recordedAmount ?? itemsSum
    }
  } else {
    // 旧形式（明細なし）: 金額をデフォルト券種で明細化する。金額が無ければ 単価×席数 を補完
    amount = recordedAmount ?? seatIds.length * fallbackUnitPrice
    finalItems = distributeAmount(seatIds, amount, defaultType)
  }

  return {
    id,
    seatIds,
    items: finalItems,
    name: asString(rec.name, ''),
    phone: asString(rec.phone, ''),
    note: asString(rec.note, ''),
    source: rec.source === 'door' ? 'door' : 'online',
    amount,
    checkedIn: rec.checkedIn === true,
    paid: rec.paid === true,
    cancelled: rec.cancelled === true,
    createdAt: asString(rec.createdAt, new Date().toISOString()),
    seller:
      typeof rec.seller === 'string' && rec.seller.trim() ? rec.seller.trim() : undefined,
    // QRトークンは形式が正しいものだけ引き継ぐ（旧データには無い）
    ...(isQrToken(rec.qrToken) ? { qrToken: rec.qrToken } : {}),
    checkedInAt:
      typeof rec.checkedInAt === 'string' && rec.checkedInAt ? rec.checkedInAt : null,
    ...(typeof rec.perfDate === 'string' && rec.perfDate
      ? { perfDate: rec.perfDate }
      : {}),
    ...(typeof rec.perfName === 'string' && rec.perfName
      ? { perfName: rec.perfName }
      : {}),
    ...(zone ? { zone } : {}),
    // R38: 希望・返金・担当者（旧データには無いため、値があるものだけ引き継ぐ）
    ...(normalizeAccessNeeds(rec.accessNeeds).length > 0
      ? { accessNeeds: normalizeAccessNeeds(rec.accessNeeds) }
      : {}),
    ...(rec.refunded === true ? { refunded: true } : {}),
    refundedAt:
      typeof rec.refundedAt === 'string' && rec.refundedAt ? rec.refundedAt : null,
    ...(typeof rec.checkedInBy === 'string' && rec.checkedInBy.trim()
      ? { checkedInBy: rec.checkedInBy.trim() }
      : {}),
    ...(typeof rec.paidBy === 'string' && rec.paidBy.trim()
      ? { paidBy: rec.paidBy.trim() }
      : {}),
  }
}

/** キャンセル待ち登録の正規化（壊れた要素は落とす） */
export function normalizeWaitlistEntry(raw: unknown): WaitlistEntry | null {
  const rec = asRecord(raw)
  if (!rec) return null
  const id = asString(rec.id, '')
  if (!id) return null
  const partySize =
    typeof rec.partySize === 'number' && Number.isFinite(rec.partySize)
      ? Math.min(MAX_ONLINE_SEATS, Math.max(1, Math.floor(rec.partySize)))
      : 1
  return {
    id,
    zone:
      typeof rec.zone === 'string' && rec.zone.trim() ? rec.zone.trim() : null,
    partySize,
    name: asString(rec.name, ''),
    phone: asString(rec.phone, ''),
    createdAt: asString(rec.createdAt, new Date().toISOString()),
  }
}

/** localStorage から読んだデータを現行形式へ正規化する。読めなければ null */
export function normalizeAppData(raw: unknown): AppData | null {
  const rec = asRecord(raw)
  if (!rec || !rec.performance || !Array.isArray(rec.reservations)) return null
  const performance = normalizePerformance(rec.performance)
  const defaultType = defaultTicketType(performance)
  const legacyPrice = asRecord(rec.performance)?.price
  const fallbackUnitPrice = asPrice(legacyPrice) ?? defaultType.price
  const reservations = rec.reservations
    .map((r) => normalizeReservation(r, defaultType, fallbackUnitPrice))
    .filter((r): r is Reservation => r !== null)
  return {
    performance,
    reservations,
    blocked: Array.isArray(rec.blocked)
      ? rec.blocked.filter((s): s is string => typeof s === 'string')
      : [],
    seq: typeof rec.seq === 'number' && Number.isFinite(rec.seq) ? rec.seq : reservations.length,
    bookingDeadline:
      typeof rec.bookingDeadline === 'string' && rec.bookingDeadline ? rec.bookingDeadline : null,
    // R38: キャンセル待ち（旧データには無いため空が既定）
    waitlist: Array.isArray(rec.waitlist)
      ? rec.waitlist
          .map((w) => normalizeWaitlistEntry(w))
          .filter((w): w is WaitlistEntry => w !== null)
      : [],
    waitlistSeq:
      typeof rec.waitlistSeq === 'number' && Number.isFinite(rec.waitlistSeq)
        ? rec.waitlistSeq
        : 0,
  }
}

/* ---------------- 予約・販売ロジック ---------------- */

/** キャンセルされていない予約 */
export function activeReservations(data: AppData): Reservation[] {
  return data.reservations.filter((r) => !r.cancelled)
}

export function reservationForSeat(data: AppData, seatId: string): Reservation | undefined {
  return activeReservations(data).find((r) => r.seatIds.includes(seatId))
}

/** 席の状態を導出する。予約があれば blocked 設定より予約が優先される。 */
export function seatStatus(data: AppData, seatId: string): SeatStatus {
  // クラウドモードではサーバの占有状態が正（お客様は他人の予約明細を持たない）
  if (data.seatStates) {
    const st = data.seatStates[seatId]
    if (st === 'sold') return 'paid'
    if (st === 'reserved') return 'reserved'
    if (data.blocked.includes(seatId)) return 'blocked'
    return 'available'
  }
  const res = reservationForSeat(data, seatId)
  if (res) return res.paid ? 'paid' : 'reserved'
  if (data.blocked.includes(seatId)) return 'blocked'
  return 'available'
}

/** 予約締切を過ぎているか（締切未設定なら false）。当日販売には使わない */
export function isBookingClosed(data: AppData, now: Date = new Date()): boolean {
  if (!data.bookingDeadline) return false
  const deadline = new Date(data.bookingDeadline)
  if (Number.isNaN(deadline.getTime())) return false
  return now.getTime() > deadline.getTime()
}

/**
 * 電話番号の正規化: 全角数字を半角にし、ハイフン・空白・括弧などの数字以外を
 * すべて取り除いて、数字だけの文字列にする。国際形式（+81〜 = 81+10桁）は
 * 国内形式（0〜）にそろえる。保存値・照会値・検索値はすべてこの形で比較する
 * （申込時はこの形で保存する）。サーバ側 sakura_valid_phone の正規化と一致。
 */
export function normalizePhone(value: string): string {
  const halfWidth = value.replace(/[０-９]/g, (c) =>
    String.fromCharCode(c.charCodeAt(0) - 0xfee0),
  )
  const digits = halfWidth.replace(/[^0-9]/g, '')
  return /^81\d{10}$/.test(digits) ? `0${digits.slice(2)}` : digits
}

/** 8桁以上の連番（昇順・降順）。これを含む番号は実在しない入力とみなす */
const SEQUENTIAL_RUNS = [
  '01234567',
  '12345678',
  '23456789',
  '98765432',
  '87654321',
  '76543210',
]

/**
 * 明らかな偽番号パターン: 全桁同一、0が6桁以上連続、8桁以上の連番。
 * サーバ側 sakura_valid_phone と同じ規則（片方だけ通す番号を作らない）。
 */
function looksFakePhone(digits: string): boolean {
  if (/^(\d)\1+$/.test(digits)) return true
  if (digits.includes('000000')) return true
  return SEQUENTIAL_RUNS.some((run) => digits.includes(run))
}

/**
 * 番号の「形」だけのチェック（桁数とプレフィックス）。
 * - 11桁: 携帯 070/080/090、IP電話 050
 * - 10桁: 固定電話・フリーダイヤル等（0 + [1-9] + 8桁）。
 *   ただし携帯/IPのプレフィックス（050/070/080/090）で始まる10桁は
 *   「桁落ち」とみなし不可。0800 フリーダイヤル（0800 + 6桁）は例外として可。
 */
function phoneShapeOk(digits: string): boolean {
  if (digits.length === 11) {
    return /^0(?:70|80|90)\d{8}$/.test(digits) || /^050\d{8}$/.test(digits)
  }
  if (digits.length === 10) {
    if (/^0(?:50|70|80|90)/.test(digits) && !digits.startsWith('0800')) return false
    return /^0[1-9]\d{8}$/.test(digits)
  }
  return false
}

/**
 * 電話番号の形式チェック（R15: 厳格化）。正規化したうえで、
 * 形（phoneShapeOk）が合っていて、明らかな偽番号パターン
 * （looksFakePhone）にも当たらない番号だけを通す。
 * サーバ側（sakura_valid_phone + INSERT トリガ）でも同じ規則で弾く。
 */
export function isValidPhone(value: string): boolean {
  const digits = normalizePhone(value)
  return phoneShapeOk(digits) && !looksFakePhone(digits)
}

/**
 * 電話番号エラーの種別（R16・C-2）。規則自体は R15 から変えず、
 * 「なぜ通らないか」を画面の文言で出し分けるために使う。
 * - 'fake': 形は合っているのに偽番号パターン（全桁同一・0の連続・連番）で
 *   弾かれた。入力ミスではなく「その番号自体を受け付けない」ケースなので、
 *   別の番号を試してもらう案内を出す。
 * - 'format': 桁数やプレフィックスなど形が合わない。打ち直せば通るケース。
 * 通る番号は null。
 */
export type PhoneErrorKind = 'format' | 'fake'

export function phoneErrorKind(value: string): PhoneErrorKind | null {
  const digits = normalizePhone(value)
  if (phoneShapeOk(digits) && !looksFakePhone(digits)) return null
  return phoneShapeOk(digits) && looksFakePhone(digits) ? 'fake' : 'format'
}

/**
 * 予約確認（ローカル）: 予約番号と電話番号で自分の予約を探す。
 * 予約番号は大小文字を区別せず、電話番号は正規化（全角→半角・記号除去）して比較する。
 * キャンセル済みの予約もヒットさせる（呼び出し側が cancelled を見て文言を出し分ける）。
 */
export function findReservationByCodePhone(
  data: AppData,
  code: string,
  phone: string,
): Reservation | null {
  const normalizedCode = code.trim().toUpperCase()
  const normalizedPhone = normalizePhone(phone)
  if (!normalizedCode || !normalizedPhone) return null
  return (
    data.reservations.find(
      (r) => r.id.toUpperCase() === normalizedCode && normalizePhone(r.phone) === normalizedPhone,
    ) ?? null
  )
}

/* ---------------- 本人キャンセル（予約確認ページから） ---------------- */

/**
 * 本人キャンセルの結果コード。クラウドの cancel_reservation RPC の契約と同一。
 * 判定の優先順位も RPC と揃える:
 * NOT_FOUND → ALREADY_CANCELLED → PAID_LOCKED → CHECKED_IN_LOCKED → TOO_LATE
 */
export type SelfCancelResult =
  | 'OK'
  | 'NOT_FOUND'
  | 'ALREADY_CANCELLED'
  | 'PAID_LOCKED'
  | 'CHECKED_IN_LOCKED'
  | 'TOO_LATE'

/**
 * 本人キャンセルの期限: 予約締切が設定されていればそれを優先し、
 * 無ければ公演日時（公演日の開演時刻）を使う。どちらも無ければ null（期限なし）。
 */
export function selfCancelLimit(data: AppData): Date | null {
  if (data.bookingDeadline) {
    const d = new Date(data.bookingDeadline)
    return Number.isNaN(d.getTime()) ? null : d
  }
  const { date, time } = data.performance
  if (!date) return null
  const d = new Date(`${date}T${time || '00:00'}:00`)
  return Number.isNaN(d.getTime()) ? null : d
}

/**
 * 本人キャンセルができるかどうかを判定する（純粋関数）。
 * ローカルモードの実行判定と、画面側の事前説明に使う。クラウドモードでは
 * 同じ規則をサーバ（cancel_reservation RPC）が判定し、この関数は使わない。
 * 期限ちょうど（now = 期限）はキャンセル不可（RPC の now() >= 期限 と一致）。
 */
export function selfCancelEligibility(
  reservation: Reservation | null,
  data: AppData,
  now: Date = new Date(),
): SelfCancelResult {
  if (!reservation) return 'NOT_FOUND'
  if (reservation.cancelled) return 'ALREADY_CANCELLED'
  // 支払い済みは返金・精算が絡むため本人キャンセル不可（スタッフ対応）
  if (reservation.paid) return 'PAID_LOCKED'
  if (reservation.checkedIn) return 'CHECKED_IN_LOCKED'
  const limit = selfCancelLimit(data)
  if (limit && now.getTime() >= limit.getTime()) return 'TOO_LATE'
  return 'OK'
}

/** 「HH:mm」を分に変換する（解釈できなければ null） */
export function timeToMinutes(value: string): number | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(value.trim())
  if (!m) return null
  return Number(m[1]) * 60 + Number(m[2])
}

/** 開場時刻が開演時刻より前かどうか（公演設定の保存時チェック用） */
export function doorsOpenBeforeStart(doorsOpen: string, startTime: string): boolean {
  const doors = timeToMinutes(doorsOpen)
  const start = timeToMinutes(startTime)
  if (doors === null || start === null) return false
  return doors < start
}

/** 階ごとの残席数（販売中で空いている席の数） */
export function availableCountByFloor(data: AppData): Record<Floor, number> {
  const counts: Record<Floor, number> = { 1: 0, 2: 0 }
  for (const seat of ALL_SEATS) {
    if (seatStatus(data, seat.id) === 'available') counts[seat.floor]++
  }
  return counts
}

export interface NewReservationSeat {
  seatId: string
  typeId: string
}

export interface NewReservationInput {
  seats: NewReservationSeat[]
  name: string
  phone: string
  note: string
  source: ReservationSource
  /** 販売者（当日販売でスタッフが選択した場合のみ意味を持つ） */
  seller?: string
  /** 座席の希望（R38・車椅子席/親子室）。通常はゾーン予約側で使う */
  accessNeeds?: AccessNeed[]
}

/**
 * 予約を作成する。全席が「販売中」でなければ例外を投げる（二重予約・販売不可席の防止）。
 * 席ごとに券種名と料金をスナップショットとして記録し、金額はその合計とする。
 * 当日販売（source='door'）は支払済として記録し、購入者名が空なら「当日」にする。
 */
export function createReservation(
  data: AppData,
  input: NewReservationInput,
): { data: AppData; reservation: Reservation } {
  if (input.seats.length === 0) throw new Error('座席が選択されていません')
  const bySeat = new Map<string, NewReservationSeat>()
  for (const seat of input.seats) {
    if (!bySeat.has(seat.seatId)) bySeat.set(seat.seatId, seat)
  }
  const seats = [...bySeat.values()]
  const items: ReservationItem[] = []
  for (const seat of seats) {
    if (!SEAT_BY_ID.has(seat.seatId)) throw new Error(`未知の座席です: ${seat.seatId}`)
    const status = seatStatus(data, seat.seatId)
    if (status !== 'available') {
      throw new Error('選択された座席の一部がすでに予約・販売済み、または販売していない席です')
    }
    const type = findTicketType(data.performance, seat.typeId)
    if (!type) throw new Error('券種が見つかりません。公演設定を確認してください')
    if (!Number.isInteger(type.price) || type.price < 0) {
      throw new Error('券種の料金が正しく設定されていません')
    }
    items.push({ seatId: seat.seatId, typeId: type.id, typeName: type.name, price: type.price })
  }
  if (input.source === 'online' && seats.length > MAX_ONLINE_SEATS) {
    throw new Error(`一度に申し込めるのは${MAX_ONLINE_SEATS}席までです`)
  }
  if (input.source === 'online' && isBookingClosed(data)) {
    throw new Error('予約受付は終了しました。当日券は会場受付でお求めください')
  }
  const name = input.name.trim() || (input.source === 'door' ? '当日' : '')
  if (!name) throw new Error('お名前を入力してください')
  const amount = items.reduce((sum, i) => sum + i.price, 0)
  const seq = data.seq + 1
  const reservation: Reservation = {
    id: `SK-${String(seq).padStart(4, '0')}`,
    seatIds: seats.map((s) => s.seatId),
    items,
    name,
    phone: input.phone.trim(),
    note: input.note.trim(),
    source: input.source,
    amount,
    checkedIn: false,
    paid: input.source === 'door',
    cancelled: false,
    createdAt: new Date().toISOString(),
    // 受付QR用トークンを発行し、公演のスナップショットを記録する（R7）。
    // クラウドモードではサーバ発行のトークンで上書きされる（cloudStore）。
    qrToken: generateQrToken(),
    perfDate: data.performance.date,
    perfName: data.performance.name,
    // 販売者は当日販売（手売り含む）でのみ記録する（Web予約には付けない）
    seller:
      input.source === 'door' && input.seller?.trim() ? input.seller.trim() : undefined,
    ...(input.accessNeeds && input.accessNeeds.length > 0
      ? { accessNeeds: [...input.accessNeeds] }
      : {}),
  }
  return {
    data: { ...data, seq, reservations: [...data.reservations, reservation] },
    reservation,
  }
}

/* ---------------- ゾーン予約（R12: 席は支払い時に確定） ---------------- */

/** ゾーン予約かどうか（zone が記録されている予約） */
export function isZoneBooking(reservation: Reservation): boolean {
  return typeof reservation.zone === 'string' && reservation.zone.length > 0
}

/** 予約の人数（明細の件数）。ゾーン予約は席未確定でも人数は確定している */
export function partySizeOf(reservation: Reservation): number {
  return reservation.items.length
}

/** ゾーン予約で、まだ席が割り当たっていない状態か */
export function isUnassignedZoneBooking(reservation: Reservation): boolean {
  return isZoneBooking(reservation) && reservation.seatIds.length === 0
}

export interface NewZoneReservationInput {
  /** ゾーンID（'A'〜'I'）。正当性は呼び出し側（zones.ts を知る層）が担保する */
  zone: string
  /** 人数分の券種ID（1人目から順に） */
  typeIds: string[]
  name: string
  phone: string
  note: string
  /** 座席の希望（R38・車椅子席/親子室） */
  accessNeeds?: AccessNeed[]
}

/**
 * ゾーン予約を作成する（ローカルモード用。純粋関数）。
 * 席は割り当てない: 明細の seatId は空文字、seatIds は空。
 * 券種名と料金は createReservation と同じくスナップショットで記録する。
 * 収容可否（ゾーン残席）の判定は zones.ts を知る呼び出し側で行う
 * （この層はゾーン定義を持たないため）。
 */
export function createZoneReservation(
  data: AppData,
  input: NewZoneReservationInput,
): { data: AppData; reservation: Reservation } {
  if (!input.zone) throw new Error('ゾーンが選択されていません')
  if (input.typeIds.length === 0) throw new Error('人数が選択されていません')
  if (input.typeIds.length > MAX_ONLINE_SEATS) {
    throw new Error(`一度に申し込めるのは${MAX_ONLINE_SEATS}名までです`)
  }
  if (isBookingClosed(data)) {
    throw new Error('予約受付は終了しました。当日券は会場受付でお求めください')
  }
  const items: ReservationItem[] = []
  for (const typeId of input.typeIds) {
    const type = findTicketType(data.performance, typeId)
    if (!type) throw new Error('券種が見つかりません。公演設定を確認してください')
    if (!Number.isInteger(type.price) || type.price < 0) {
      throw new Error('券種の料金が正しく設定されていません')
    }
    items.push({ seatId: '', typeId: type.id, typeName: type.name, price: type.price })
  }
  const name = input.name.trim()
  if (!name) throw new Error('お名前を入力してください')
  const amount = items.reduce((sum, i) => sum + i.price, 0)
  const seq = data.seq + 1
  const reservation: Reservation = {
    id: `SK-${String(seq).padStart(4, '0')}`,
    seatIds: [],
    items,
    name,
    phone: input.phone.trim(),
    note: input.note.trim(),
    source: 'online',
    amount,
    checkedIn: false,
    paid: false,
    cancelled: false,
    createdAt: new Date().toISOString(),
    qrToken: generateQrToken(),
    perfDate: data.performance.date,
    perfName: data.performance.name,
    zone: input.zone,
    ...(input.accessNeeds && input.accessNeeds.length > 0
      ? { accessNeeds: [...input.accessNeeds] }
      : {}),
  }
  return {
    data: { ...data, seq, reservations: [...data.reservations, reservation] },
    reservation,
  }
}

/**
 * 予約に席を割り当てる（支払い時の確定。ローカルモード用。純粋関数）。
 * 明細の順序のまま席を割り当て、seatIds にも同じ順序で入れる。
 * 席数が人数と一致しない場合は例外（呼び出し側は支払い済みにしない）。
 */
export function assignSeatsToReservation(
  data: AppData,
  reservationId: string,
  seatIds: string[],
): AppData {
  const target = data.reservations.find((r) => r.id === reservationId)
  if (!target) throw new Error('予約が見つかりません')
  if (seatIds.length !== target.items.length) {
    throw new Error('席数が人数と一致しません')
  }
  const items = target.items.map((item, i) => ({ ...item, seatId: seatIds[i] }))
  return updateReservation(data, reservationId, { items, seatIds: [...seatIds] })
}

/**
 * 予約の席割当を解除する（ゾーン予約を未払いに戻すとき。ローカルモード用）。
 * 明細の seatId を空文字に戻し、seatIds を空にする。支払い状態は触らない
 * （呼び出し側が setPaid と組み合わせる）。
 */
export function clearReservationSeats(data: AppData, reservationId: string): AppData {
  const target = data.reservations.find((r) => r.id === reservationId)
  if (!target) return data
  const items = target.items.map((item) => ({ ...item, seatId: '' }))
  return updateReservation(data, reservationId, { items, seatIds: [] })
}

function updateReservation(
  data: AppData,
  reservationId: string,
  patch: Partial<Reservation>,
): AppData {
  return {
    ...data,
    reservations: data.reservations.map((r) => (r.id === reservationId ? { ...r, ...patch } : r)),
  }
}

/** 予約をキャンセルし、席を解放する */
export function cancelReservation(data: AppData, reservationId: string): AppData {
  return updateReservation(data, reservationId, { cancelled: true })
}

/**
 * キャンセルの取り消し（スタッフ操作）の結果コード。
 * クラウドの staff_uncancel_reservation RPC の契約と同一。
 * - OK: 取り消しできた（元の予約番号・電話・備考・金額のまま復旧）
 * - NOT_FOUND: その予約番号の予約がない
 * - NOT_CANCELLED: キャンセル済みではない（取り消す対象でない）
 * - SEAT_TAKEN: 席の一部が別の有効な予約に取られているため復旧できない
 * - ZONE_FULL: 未割当のゾーン予約で、復活させるとゾーンの定員（ホールド数）
 *   を超えてしまうため復旧できない（R38。第3ラウンド評価 M1 のオーバーセル対策。
 *   判定は zones.ts の zoneUncancelBlock が行い、クラウドでは RPC が同じ結果を返す）
 */
export type UncancelResult =
  | 'OK'
  | 'NOT_FOUND'
  | 'NOT_CANCELLED'
  | 'SEAT_TAKEN'
  | 'ZONE_FULL'

/**
 * キャンセルを取り消し、予約を元の内容のまま復旧する（純粋関数）。
 * ローカルモードの実行判定に使う。クラウドモードでは同じ規則を
 * サーバ（staff_uncancel_reservation RPC）が判定する。
 * 席が他の有効な予約に使われていたら復旧せず SEAT_TAKEN を返す。
 */
export function uncancelReservation(
  data: AppData,
  reservationId: string,
): { data: AppData; result: UncancelResult } {
  const target = data.reservations.find((r) => r.id === reservationId)
  if (!target) return { data, result: 'NOT_FOUND' }
  if (!target.cancelled) return { data, result: 'NOT_CANCELLED' }
  const seatTaken = target.seatIds.some((seatId) =>
    activeReservations(data).some(
      (r) => r.id !== target.id && r.seatIds.includes(seatId),
    ),
  )
  if (seatTaken) return { data, result: 'SEAT_TAKEN' }
  return {
    data: updateReservation(data, reservationId, { cancelled: false }),
    result: 'OK',
  }
}

export function setCheckedIn(
  data: AppData,
  reservationId: string,
  value: boolean,
  operator?: string,
): AppData {
  const target = data.reservations.find((r) => r.id === reservationId)
  if (!target) return data
  // 受付日時は「使用済み」表示の根拠になるため、来場フラグと一緒に保つ（R7）
  const checkedInAt = value
    ? (target.checkedInAt ?? new Date().toISOString())
    : null
  // R38: 担当者（選択中の運営者名）があれば受付の処理者として記録する。
  // 来場を取り消したら担当者も消す（誰も受付していない状態に戻すため）
  const checkedInBy = value
    ? operator?.trim()
      ? operator.trim()
      : target.checkedInBy
    : undefined
  return updateReservation(data, reservationId, {
    checkedIn: value,
    checkedInAt,
    checkedInBy,
  })
}

/* ---------------- QR受付（トークン検証・R7） ---------------- */

/**
 * QR受付の結果コード。クラウドの staff_check_in RPC の契約と同一。
 * 判定の優先順位も RPC と揃える:
 * NOT_FOUND → WRONG_PERFORMANCE → CANCELLED → ALREADY_CHECKED_IN → OK
 */
export type CheckInResult =
  | 'OK'
  | 'ALREADY_CHECKED_IN'
  | 'CANCELLED'
  | 'WRONG_PERFORMANCE'
  | 'NOT_FOUND'

/**
 * トークンで受付する（ローカルモードの検証・状態機械。純粋関数）。
 * クラウドモードでは同じ規則をサーバ（staff_check_in RPC）が判定する。
 * - トークンが一致する予約が無ければ NOT_FOUND（偽造・改ざんはここに落ちる）
 * - 予約時点の公演スナップショットが現在の公演設定と違えば WRONG_PERFORMANCE
 *   （スナップショットを持たない旧予約は照合できないため対象外）
 * - OK のときだけ data を更新して返す（checkedIn + checkedInAt を記録）
 */
export function checkInByToken(
  data: AppData,
  token: string,
  now: Date = new Date(),
  operator?: string,
): { data: AppData; result: CheckInResult; reservation: Reservation | null } {
  const target = data.reservations.find((r) => r.qrToken && r.qrToken === token)
  if (!target) return { data, result: 'NOT_FOUND', reservation: null }
  if (
    target.perfDate !== undefined &&
    target.perfName !== undefined &&
    (target.perfDate !== data.performance.date || target.perfName !== data.performance.name)
  ) {
    return { data, result: 'WRONG_PERFORMANCE', reservation: target }
  }
  if (target.cancelled) return { data, result: 'CANCELLED', reservation: target }
  if (target.checkedIn) {
    return { data, result: 'ALREADY_CHECKED_IN', reservation: target }
  }
  const next = updateReservation(data, target.id, {
    checkedIn: true,
    checkedInAt: now.toISOString(),
    // R38: QR受付でも担当者を記録する（選択中の運営者名があれば）
    ...(operator?.trim() ? { checkedInBy: operator.trim() } : {}),
  })
  return {
    data: next,
    result: 'OK',
    reservation: next.reservations.find((r) => r.id === target.id) ?? null,
  }
}

/** 支払い済みにすると、その予約の席は「支払済（販売済）」状態になる */
export function setPaid(
  data: AppData,
  reservationId: string,
  value: boolean,
  operator?: string,
): AppData {
  const target = data.reservations.find((r) => r.id === reservationId)
  if (!target) return data
  // R38: 担当者があれば支払い確定の処理者として記録する（未払いに戻したら消す）
  const paidBy = value
    ? operator?.trim()
      ? operator.trim()
      : target.paidBy
    : undefined
  return updateReservation(data, reservationId, { paid: value, paidBy })
}

/**
 * 返金済みの記録（R38・公演中止時の返金管理）。
 * 返金済みにすると refundedAt に現在時刻を記録し、戻すと消す。
 */
export function setRefunded(data: AppData, reservationId: string, value: boolean): AppData {
  const target = data.reservations.find((r) => r.id === reservationId)
  if (!target) return data
  return updateReservation(data, reservationId, {
    refunded: value,
    refundedAt: value ? (target.refundedAt ?? new Date().toISOString()) : null,
  })
}

/**
 * 返金チェックリストの対象（R38）: お金を預かっている（支払済み）予約すべて。
 * キャンセル済みでも支払済みなら返金が必要なため含める。
 * 予約番号順に並べて返す（印刷・CSV・画面で同じ並びにするため）。
 */
export function refundChecklist(data: AppData): Reservation[] {
  return data.reservations
    .filter((r) => r.paid)
    .slice()
    .sort((a, b) => a.id.localeCompare(b.id))
}

/* ---------------- キャンセル待ち（R38） ---------------- */

export interface NewWaitlistInput {
  /** 希望ゾーン（'A'〜'I'）。null は「どこでもよい」 */
  zone: string | null
  partySize: number
  name: string
  /** 正規化済みの電話番号（検証は呼び出し側で行う） */
  phone: string
}

/** キャンセル待ちを登録する（ローカルモード用。純粋関数） */
export function createWaitlistEntry(
  data: AppData,
  input: NewWaitlistInput,
): { data: AppData; entry: WaitlistEntry } {
  const name = input.name.trim()
  if (!name) throw new Error('お名前を入力してください')
  const partySize = Math.min(MAX_ONLINE_SEATS, Math.max(1, Math.floor(input.partySize)))
  const seq = data.waitlistSeq + 1
  const entry: WaitlistEntry = {
    id: `WL-${String(seq).padStart(4, '0')}`,
    zone: input.zone,
    partySize,
    name,
    phone: input.phone,
    createdAt: new Date().toISOString(),
  }
  return {
    data: { ...data, waitlistSeq: seq, waitlist: [...data.waitlist, entry] },
    entry,
  }
}

/** キャンセル待ちを取り下げる（連絡済み・不要になった登録の削除） */
export function removeWaitlistEntry(data: AppData, entryId: string): AppData {
  return { ...data, waitlist: data.waitlist.filter((w) => w.id !== entryId) }
}

/** 販売しない席の切替。予約が入っている席は切り替えない。 */
export function toggleBlocked(data: AppData, seatId: string): AppData {
  if (reservationForSeat(data, seatId)) return data
  const next = data.blocked.includes(seatId)
    ? data.blocked.filter((id) => id !== seatId)
    : [...data.blocked, seatId]
  return { ...data, blocked: next }
}

/** 複数席まとめて販売ON/OFF（列一括切替用）。予約済みの席は対象外。 */
export function setBlockedForSeats(data: AppData, seatIds: string[], blocked: boolean): AppData {
  const current = new Set(data.blocked)
  for (const seatId of seatIds) {
    if (reservationForSeat(data, seatId)) continue
    if (blocked) current.add(seatId)
    else current.delete(seatId)
  }
  return { ...data, blocked: [...current] }
}

/** 公演設定を更新する。既存予約はスナップショットを持つため影響を受けない */
export function updatePerformance(data: AppData, perf: Performance): AppData {
  return { ...data, performance: perf }
}

export interface TicketTypeTotals {
  /** 券種名（予約時点のスナップショット名、または現在の設定名） */
  typeName: string
  /** 予約済み（未払い）の席数 */
  reservedSeatCount: number
  /** 支払済みの席数 */
  paidSeatCount: number
  /** 売上 = 支払済み分の金額合計 */
  salesTotal: number
}

export interface SellerTotals {
  /** 販売者名 */
  seller: string
  /** 販売した席数（キャンセル済みを除く） */
  seatCount: number
  /** 販売金額の合計（記録された金額の合計） */
  amount: number
}

export interface OperatorTotals {
  /** 担当者名（受付・支払い確定の処理者。R38） */
  operator: string
  /** 受付（来場チェックイン）を処理した予約件数 */
  checkedInCount: number
  /** 支払い確定を処理した予約件数 */
  receivedCount: number
  /** 支払い確定を処理した金額の合計（現金の受け取り照合用） */
  receivedAmount: number
}

export interface Totals {
  /** 有効な予約の件数 */
  reservationCount: number
  /** 有効な予約の合計人数（席数） */
  totalPeople: number
  /** 支払済みの予約件数 */
  paidReservationCount: number
  /** 未払いの予約件数 */
  unpaidReservationCount: number
  /** 来場済み（チェックイン済み）の予約件数 */
  checkedInCount: number
  /** 来場済みの人数 */
  checkedInPeople: number
  /** 未受付の予約件数（当日販売は含まない・R37） */
  notCheckedInCount: number
  /** 未受付の人数（当日販売は含まない・R37） */
  notCheckedInPeople: number
  /**
   * 当日販売の件数（R37）。当日販売は購入時点で支払い・入場まで済んで
   * いる前提のため、来場済み・未受付のどちらにも混ぜず分離して数える
   */
  doorSaleCount: number
  /** 当日販売の人数（R37） */
  doorSalePeople: number
  /** 予約済み（未払い）の席数 */
  reservedSeatCount: number
  /** 支払済みの席数 */
  paidSeatCount: number
  /** 売上 = 支払済み予約の合計金額 */
  salesTotal: number
  /** 未払い合計 = 未払い予約の合計金額 */
  unpaidTotal: number
  /** 販売中の残席数 */
  availableSeatCount: number
  /** 販売しない席数 */
  blockedSeatCount: number
  /** 券種ごとの内訳（現在設定の券種順 → 記録にのみ残る券種名の順） */
  byType: TicketTypeTotals[]
  /** 販売者ごとの内訳（販売者が記録された有効な予約のみ・登場順） */
  bySeller: SellerTotals[]
  /** 担当者ごとの内訳（R38）: 受付・支払い確定の処理者が記録された有効な予約のみ */
  byOperator: OperatorTotals[]
  /** 返金がまだ済んでいない支払済み予約の件数（R38。有効な予約のみ） */
  refundDueCount: number
  /** 返金がまだ済んでいない支払済み予約の金額合計（R38） */
  refundDueAmount: number
  /** 返金済みとして記録された有効な予約の件数（R38） */
  refundedCount: number
}

export function totals(data: AppData, allSeatIds: string[]): Totals {
  const active = activeReservations(data)
  let reservedSeatCount = 0
  let paidSeatCount = 0
  let salesTotal = 0
  let unpaidTotal = 0
  const byTypeMap = new Map<string, TicketTypeTotals>()
  const typeRow = (typeName: string): TicketTypeTotals => {
    let row = byTypeMap.get(typeName)
    if (!row) {
      row = { typeName, reservedSeatCount: 0, paidSeatCount: 0, salesTotal: 0 }
      byTypeMap.set(typeName, row)
    }
    return row
  }
  // 現在の設定にある券種は、実績がなくても行を用意する
  for (const type of data.performance.ticketTypes) typeRow(type.name)
  const bySellerMap = new Map<string, SellerTotals>()
  const byOperatorMap = new Map<string, OperatorTotals>()
  const operatorRow = (name: string): OperatorTotals => {
    let row = byOperatorMap.get(name)
    if (!row) {
      row = { operator: name, checkedInCount: 0, receivedCount: 0, receivedAmount: 0 }
      byOperatorMap.set(name, row)
    }
    return row
  }
  let refundDueCount = 0
  let refundDueAmount = 0
  let refundedCount = 0
  let totalPeople = 0
  let paidReservationCount = 0
  let unpaidReservationCount = 0
  let checkedInCount = 0
  let checkedInPeople = 0
  let notCheckedInCount = 0
  let notCheckedInPeople = 0
  let doorSaleCount = 0
  let doorSalePeople = 0
  for (const res of active) {
    // 席数は明細の件数（＝人数）で数える。ゾーン予約は支払いまで席が
    // 未確定（seatIds が空）でも、人数分の予約として数えるため（R12）。
    // 従来型の予約では明細数と席数は常に一致する。
    const party = res.items.length
    totalPeople += party
    if (res.paid) paidReservationCount++
    else unpaidReservationCount++
    // 来場（チェックイン）進捗（R33・スタッフ側改善 #1）。キャンセル済みは
    // active の時点で除かれているため、受付一覧の既定表示とも一致する。
    // R37: 当日販売（source='door'）は購入時点で支払い・入場まで済んでいる
    // 前提なので「未受付」に数えない（第2ラウンド評価: 終演間際に未受付が
    // 実態とずれて見える）。来場済みにも混ぜず、当日販売として分離する
    if (res.checkedIn) {
      checkedInCount++
      checkedInPeople += party
    } else if (res.source === 'door') {
      doorSaleCount++
      doorSalePeople += party
    } else {
      notCheckedInCount++
      notCheckedInPeople += party
    }
    if (res.seller) {
      let row = bySellerMap.get(res.seller)
      if (!row) {
        row = { seller: res.seller, seatCount: 0, amount: 0 }
        bySellerMap.set(res.seller, row)
      }
      row.seatCount += party
      row.amount += res.amount
    }
    // R38: 担当者別内訳（受付・受取）。現在の状態（来場済み/支払済み）と
    // 記録された処理者が一致するものだけを数える（取り消された操作は残さない）
    if (res.checkedIn && res.checkedInBy) {
      operatorRow(res.checkedInBy).checkedInCount++
    }
    if (res.paid && res.paidBy) {
      const row = operatorRow(res.paidBy)
      row.receivedCount++
      row.receivedAmount += res.amount
    }
    // R38: 返金の進捗（支払済みで未返金＝まだお金を預かっている分）
    if (res.paid) {
      if (res.refunded) refundedCount++
      else {
        refundDueCount++
        refundDueAmount += res.amount
      }
    }
    // 集計は「記録された金額・券種スナップショット」で行う（後の設定変更に影響されない）
    if (res.paid) {
      paidSeatCount += party
      salesTotal += res.amount
    } else {
      reservedSeatCount += party
      unpaidTotal += res.amount
    }
    for (const item of res.items) {
      const row = typeRow(item.typeName)
      if (res.paid) {
        row.paidSeatCount++
        row.salesTotal += item.price
      } else {
        row.reservedSeatCount++
      }
    }
  }
  let availableSeatCount = 0
  let blockedSeatCount = 0
  for (const seatId of allSeatIds) {
    const status = seatStatus(data, seatId)
    if (status === 'available') availableSeatCount++
    else if (status === 'blocked') blockedSeatCount++
  }
  // R25（ラウンド10・S-3）: 未割当のゾーン予約（カウントホールド）も差し引く。
  // 以前は席の占有（seat_state 相当）だけで数えていたため、ヒーローの空席数
  // （R24 でホールド込みに統一済み）と「残席」が食い違って見えた。
  // ホールド数の数え方は zones.zoneHoldCount と同一にする
  // （zoneHolds があればその合計、無ければ有効な未割当ゾーン予約から導出）
  let holdSeats = 0
  if (data.zoneHolds) {
    for (const n of Object.values(data.zoneHolds)) holdSeats += n
  } else {
    for (const res of active) {
      if (isZoneBooking(res) && res.seatIds.length === 0) holdSeats += res.items.length
    }
  }
  availableSeatCount = Math.max(0, availableSeatCount - holdSeats)
  return {
    reservationCount: active.length,
    totalPeople,
    paidReservationCount,
    unpaidReservationCount,
    checkedInCount,
    checkedInPeople,
    notCheckedInCount,
    notCheckedInPeople,
    doorSaleCount,
    doorSalePeople,
    reservedSeatCount,
    paidSeatCount,
    salesTotal,
    unpaidTotal,
    availableSeatCount,
    blockedSeatCount,
    byType: [...byTypeMap.values()],
    bySeller: [...bySellerMap.values()],
    byOperator: [...byOperatorMap.values()],
    refundDueCount,
    refundDueAmount,
    refundedCount,
  }
}

/** 予約1件の金額（記録された金額 = 明細合計） */
export function reservationTotal(reservation: Reservation): number {
  return reservation.amount
}

/** スタッフ一覧での表示名。当日販売で購入者名が空の予約は「当日 様」ではなく内容で示す */
export function reservationDisplayName(reservation: Reservation): string {
  if (reservation.source === 'door' && reservation.name === '当日') {
    return '当日販売（購入者名なし）'
  }
  return `${reservation.name} 様`
}

/**
 * 席リストの圧縮表記（スタッフ表示用）。
 * 同じ階・同じ列の連続席を範囲にまとめ、「1階 3列 11〜13番・15番」の形にする。
 * 個別ラベルを「、」で並べると1予約で何行も折り返して読みにくいため、
 * スタッフ画面（受付一覧・QR受付・当日販売・集計印刷）ではこちらを使う。
 * 列・番号を持たない席（車椅子席・親子室）はラベルそのままで末尾に並べる。
 */
export function formatSeatList(seatIds: string[]): string {
  const groups = new Map<string, { floor: number; row: number; numbers: number[] }>()
  const specials: string[] = []
  for (const id of seatIds) {
    const seat = SEAT_BY_ID.get(id)
    if (!seat) {
      specials.push(id)
      continue
    }
    if (seat.row === null || seat.number === null) {
      specials.push(seat.label)
      continue
    }
    const key = `${seat.floor}-${seat.row}`
    let group = groups.get(key)
    if (!group) {
      group = { floor: seat.floor, row: seat.row, numbers: [] }
      groups.set(key, group)
    }
    group.numbers.push(seat.number)
  }
  const parts: string[] = []
  for (const group of [...groups.values()].sort(
    (a, b) => a.floor - b.floor || a.row - b.row,
  )) {
    const nums = [...new Set(group.numbers)].sort((a, b) => a - b)
    const runs: string[] = []
    let start = nums[0]
    let prev = nums[0]
    const flush = () => {
      runs.push(start === prev ? `${start}番` : `${start}〜${prev}番`)
    }
    for (let i = 1; i < nums.length; i++) {
      if (nums[i] === prev + 1) {
        prev = nums[i]
      } else {
        flush()
        start = nums[i]
        prev = nums[i]
      }
    }
    flush()
    parts.push(`${group.floor}階 ${group.row}列 ${runs.join('・')}`)
  }
  return [...parts, ...specials].join('、')
}

/** 予約の券種内訳を「大人×2・子供×1」の形で返す（受付表示用） */
export function reservationTypeSummary(reservation: Reservation): string {
  const counts = new Map<string, number>()
  for (const item of reservation.items) {
    counts.set(item.typeName, (counts.get(item.typeName) ?? 0) + 1)
  }
  return [...counts.entries()].map(([name, n]) => `${name}×${n}`).join('・')
}

export function formatYen(amount: number): string {
  return `${amount.toLocaleString('ja-JP')}円`
}

/** 券種の料金表記「大人 2,000円／子供 1,000円」 */
export function formatTicketTypes(perf: Performance): string {
  return perf.ticketTypes.map((t) => `${t.name} ${formatYen(t.price)}`).join('／')
}

/** 公演日時を「12月19日（土）13:00開演」のように整形する */
export function formatPerformanceWhen(perf: Performance): string {
  const date = new Date(`${perf.date}T00:00:00`)
  const weekdays = ['日', '月', '火', '水', '木', '金', '土']
  const month = date.getMonth() + 1
  const day = date.getDate()
  const weekday = weekdays[date.getDay()]
  return `${month}月${day}日（${weekday}） ${perf.time}開演`
}

/** ISO日時を「12月19日 13:00」のように整形する（予約締切のお客様表示用） */
export function formatMonthDayTime(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  const hh = String(d.getHours()).padStart(2, '0')
  const mm = String(d.getMinutes()).padStart(2, '0')
  return `${d.getMonth() + 1}月${d.getDate()}日 ${hh}:${mm}`
}

/** ローカル日付を YYYY-MM-DD で返す（「本日開演」判定用） */
export function localDateString(now: Date = new Date()): string {
  const y = now.getFullYear()
  const m = String(now.getMonth() + 1).padStart(2, '0')
  const d = String(now.getDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}
