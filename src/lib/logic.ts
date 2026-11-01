import { SEAT_BY_ID } from '../data/seats'

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
  /** HH:mm */
  time: string
  /** 券種リスト。先頭がデフォルト券種 */
  ticketTypes: TicketType[]
  /** 料金に関する自由記述の注記（お客様画面の券種選択付近に表示） */
  priceNote: string
  note: string
}

export type ReservationSource = 'online' | 'door'

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
}

export interface AppData {
  performance: Performance
  reservations: Reservation[]
  /** 販売しない席IDの配列 */
  blocked: string[]
  /** 予約番号の採番カウンタ */
  seq: number
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

export function defaultPerformance(): Performance {
  return {
    name: 'サンプル公演',
    date: '2026-12-19',
    time: '13:00',
    ticketTypes: defaultTicketTypes(),
    priceNote: '子供料金は小学生以下が対象です。',
    note: '試作用のサンプル公演です。スタッフ用画面の「公演設定」から公演名・日時・券種・料金を変更できます。',
  }
}

export function emptyData(): AppData {
  return { performance: defaultPerformance(), reservations: [], blocked: [], seq: 0 }
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

export function normalizePerformance(raw: unknown): Performance {
  const rec = asRecord(raw)
  if (!rec) return defaultPerformance()
  const fallback = defaultPerformance()
  return {
    name: asString(rec.name, fallback.name),
    date: asString(rec.date, fallback.date),
    time: asString(rec.time, fallback.time),
    ticketTypes: normalizeTicketTypes(rec.ticketTypes, rec.price),
    priceNote: asString(rec.priceNote, ''),
    note: asString(rec.note, ''),
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

  const rawItems = Array.isArray(rec.items) ? rec.items : []
  const itemSeatIds: string[] = []
  const items: ReservationItem[] = []
  let itemsValid = rawItems.length > 0
  for (const rawItem of rawItems) {
    const itemRec = asRecord(rawItem)
    const seatId = itemRec ? asString(itemRec.seatId, '') : ''
    const price = itemRec ? asPrice(itemRec.price) : null
    if (!itemRec || !seatId || price === null) {
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

  const seatIds = Array.isArray(rec.seatIds)
    ? rec.seatIds.filter((s): s is string => typeof s === 'string' && s.length > 0)
    : itemSeatIds
  if (seatIds.length === 0) return null

  const recordedAmount = asPrice(rec.amount)
  let finalItems: ReservationItem[]
  let amount: number
  if (itemsValid && JSON.stringify(itemSeatIds) === JSON.stringify(seatIds)) {
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
  const res = reservationForSeat(data, seatId)
  if (res) return res.paid ? 'paid' : 'reserved'
  if (data.blocked.includes(seatId)) return 'blocked'
  return 'available'
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
  }
  return {
    data: { ...data, seq, reservations: [...data.reservations, reservation] },
    reservation,
  }
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

export function setCheckedIn(data: AppData, reservationId: string, value: boolean): AppData {
  return updateReservation(data, reservationId, { checkedIn: value })
}

/** 支払い済みにすると、その予約の席は「支払済（販売済）」状態になる */
export function setPaid(data: AppData, reservationId: string, value: boolean): AppData {
  return updateReservation(data, reservationId, { paid: value })
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

export interface Totals {
  /** 有効な予約の件数 */
  reservationCount: number
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
  for (const res of active) {
    // 集計は「記録された金額・券種スナップショット」で行う（後の設定変更に影響されない）
    if (res.paid) {
      paidSeatCount += res.seatIds.length
      salesTotal += res.amount
    } else {
      reservedSeatCount += res.seatIds.length
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
  return {
    reservationCount: active.length,
    reservedSeatCount,
    paidSeatCount,
    salesTotal,
    unpaidTotal,
    availableSeatCount,
    blockedSeatCount,
    byType: [...byTypeMap.values()],
  }
}

/** 予約1件の金額（記録された金額 = 明細合計） */
export function reservationTotal(reservation: Reservation): number {
  return reservation.amount
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
