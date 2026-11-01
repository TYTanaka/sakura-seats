import { SEAT_BY_ID } from '../data/seats'

/**
 * 予約・販売ロジック（純粋関数群）。
 * 公演は1回のみという前提のため、公演は単一の設定オブジェクトとして保持する。
 * ストア（localStorage）はこのデータ構造を保持するだけにし、
 * 将来 Supabase バックエンドへ差し替える際もこの層をサーバ側へ移せるようにする。
 */

export interface Performance {
  name: string
  /** YYYY-MM-DD */
  date: string
  /** HH:mm */
  time: string
  /** 1席あたりの料金（円・整数） */
  price: number
  note: string
}

export type ReservationSource = 'online' | 'door'

export interface Reservation {
  /** 予約番号 SK-0001 形式 */
  id: string
  seatIds: string[]
  name: string
  phone: string
  note: string
  source: ReservationSource
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

export function defaultPerformance(): Performance {
  return {
    name: 'サンプル公演',
    date: '2026-12-19',
    time: '13:00',
    price: 2000,
    note: '試作用のサンプル公演です。スタッフ用画面の「公演設定」から公演名・日時・料金を変更できます。',
  }
}

export function emptyData(): AppData {
  return { performance: defaultPerformance(), reservations: [], blocked: [], seq: 0 }
}

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

export interface NewReservationInput {
  seatIds: string[]
  name: string
  phone: string
  note: string
  source: ReservationSource
}

/**
 * 予約を作成する。全席が「販売中」でなければ例外を投げる（二重予約・販売不可席の防止）。
 * 当日販売（source='door'）は支払済として記録し、購入者名が空なら「当日」にする。
 */
export function createReservation(
  data: AppData,
  input: NewReservationInput,
): { data: AppData; reservation: Reservation } {
  if (input.seatIds.length === 0) throw new Error('座席が選択されていません')
  const uniqueSeatIds = [...new Set(input.seatIds)]
  for (const seatId of uniqueSeatIds) {
    if (!SEAT_BY_ID.has(seatId)) throw new Error(`未知の座席です: ${seatId}`)
    const status = seatStatus(data, seatId)
    if (status !== 'available') {
      throw new Error('選択された座席の一部がすでに予約・販売済み、または販売していない席です')
    }
  }
  if (input.source === 'online' && uniqueSeatIds.length > MAX_ONLINE_SEATS) {
    throw new Error(`一度に申し込めるのは${MAX_ONLINE_SEATS}席までです`)
  }
  const name = input.name.trim() || (input.source === 'door' ? '当日' : '')
  if (!name) throw new Error('お名前を入力してください')
  const seq = data.seq + 1
  const reservation: Reservation = {
    id: `SK-${String(seq).padStart(4, '0')}`,
    seatIds: uniqueSeatIds,
    name,
    phone: input.phone.trim(),
    note: input.note.trim(),
    source: input.source,
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

/** 公演設定を更新する */
export function updatePerformance(data: AppData, perf: Performance): AppData {
  return { ...data, performance: perf }
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
}

export function totals(data: AppData, allSeatIds: string[]): Totals {
  const price = data.performance.price
  const active = activeReservations(data)
  let reservedSeatCount = 0
  let paidSeatCount = 0
  let salesTotal = 0
  let unpaidTotal = 0
  for (const res of active) {
    const amount = res.seatIds.length * price
    if (res.paid) {
      paidSeatCount += res.seatIds.length
      salesTotal += amount
    } else {
      reservedSeatCount += res.seatIds.length
      unpaidTotal += amount
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
  }
}

/** 予約1件の合計金額 */
export function reservationTotal(data: AppData, reservation: Reservation): number {
  return reservation.seatIds.length * data.performance.price
}

export function formatYen(amount: number): string {
  return `${amount.toLocaleString('ja-JP')}円`
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
