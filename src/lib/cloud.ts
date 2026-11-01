import type { SupabaseClient } from '@supabase/supabase-js'
import {
  normalizePerformance,
  type Performance,
  type Reservation,
  type SelfCancelResult,
} from './logic'

/**
 * Supabase RPC のクライアント層。
 * このモジュールは動的 import される前提で、@supabase/supabase-js を静的に取り込む
 * （だから軽量モジュール config.ts と分離している。sekiji-marutto と同じ構成）。
 *
 * サーバ側の前提: supabase/migration_sakura.sql が適用済みであること。
 * - 料金はサーバ側で公演設定の券種から再計算される（クライアントの金額は送らない）
 * - スタッフ操作はパスコードを都度 RPC に渡して照合する
 */

export interface PublicState {
  performance: Performance
  blockedSeats: string[]
  /** ISO文字列（timestamptz）。締切なしは null */
  bookingDeadline: string | null
  seatStates: Record<string, 'reserved' | 'sold'>
}

export interface StaffData {
  performance: Performance
  blockedSeats: string[]
  bookingDeadline: string | null
  reservations: Reservation[]
}

/** RPC が使う最小限のクライアント形状（テストでモックしやすくするため） */
export interface RpcClient {
  rpc: (
    fn: string,
    args: Record<string, unknown>,
  ) => Promise<{ data: unknown; error: { message: string } | null }>
}

interface RawReservationRow {
  id: string
  code: string
  name: string
  phone: string
  note?: string
  items: Reservation['items']
  amount: number
  kind: 'online' | 'door'
  paid: boolean
  checkedIn: boolean
  status: 'active' | 'cancelled'
  createdAt: string
  /** 販売者（staff_get_all のみが返す。lookup 等では含まれない） */
  seller?: string | null
}

/** DB行 → クライアントの Reservation への変換 */
export function mapReservationRow(row: RawReservationRow): Reservation {
  const items = Array.isArray(row.items) ? row.items : []
  return {
    id: row.code,
    cloudId: row.id,
    seatIds: items.map((i) => i.seatId),
    items,
    name: row.name,
    phone: row.phone,
    note: row.note ?? '',
    source: row.kind === 'door' ? 'door' : 'online',
    amount: row.amount,
    checkedIn: row.checkedIn === true,
    paid: row.paid === true,
    cancelled: row.status === 'cancelled',
    createdAt: row.createdAt,
    seller:
      typeof row.seller === 'string' && row.seller.trim() ? row.seller.trim() : undefined,
  }
}

interface RawConfig {
  performance?: unknown
  blockedSeats?: unknown
  bookingDeadline?: unknown
}

function mapConfig(raw: RawConfig): Omit<StaffData, 'reservations'> {
  return {
    performance: normalizePerformance(raw.performance),
    blockedSeats: Array.isArray(raw.blockedSeats)
      ? raw.blockedSeats.filter((s): s is string => typeof s === 'string')
      : [],
    bookingDeadline:
      typeof raw.bookingDeadline === 'string' && raw.bookingDeadline ? raw.bookingDeadline : null,
  }
}

/** get_public_state の戻り値 → PublicState */
export function mapPublicState(raw: unknown): PublicState {
  const rec = (raw ?? {}) as RawConfig & { seats?: unknown }
  const seatStates: Record<string, 'reserved' | 'sold'> = {}
  if (Array.isArray(rec.seats)) {
    for (const s of rec.seats as { seatId?: unknown; state?: unknown }[]) {
      if (typeof s?.seatId === 'string' && (s.state === 'reserved' || s.state === 'sold')) {
        seatStates[s.seatId] = s.state
      }
    }
  }
  return { ...mapConfig(rec), seatStates }
}

/** staff_get_all の戻り値 → StaffData */
export function mapStaffData(raw: unknown): StaffData {
  const rec = (raw ?? {}) as { config?: RawConfig; reservations?: unknown }
  const config = mapConfig(rec.config ?? {})
  const reservations = Array.isArray(rec.reservations)
    ? (rec.reservations as RawReservationRow[]).map(mapReservationRow)
    : []
  return { ...config, reservations }
}

/** lookup_reservation の戻り値 → Reservation（無ければ null） */
export function mapLookupResult(raw: unknown): Reservation | null {
  if (!raw || typeof raw !== 'object') return null
  return mapReservationRow(raw as RawReservationRow)
}

function rpcErrorToMessage(error: { message: string }): Error {
  const msg = error.message ?? ''
  if (msg.includes('SEAT_TAKEN')) {
    return new Error('選択された座席の一部が、ほかの方に予約されてしまいました。座席を選び直してください')
  }
  if (msg.includes('SEAT_BLOCKED')) {
    return new Error('選択された座席の一部が販売していない席です。座席を選び直してください')
  }
  if (msg.includes('BOOKING_CLOSED')) {
    return new Error('予約受付は終了しました。当日券は会場受付でお求めください')
  }
  if (msg.includes('UNAUTHORIZED')) {
    return new Error('パスコードが違います')
  }
  if (msg.includes('BLOCKED_CONFLICT')) {
    return new Error('予約・販売済みの席は販売しない設定にできません')
  }
  if (msg.includes('TOO_MANY_SEATS')) {
    return new Error('一度に申し込めるのは8席までです')
  }
  if (msg.includes('NAME_REQUIRED')) return new Error('お名前を入力してください')
  if (msg.includes('PHONE_REQUIRED')) return new Error('電話番号を入力してください')
  return new Error('通信に失敗しました。しばらくしてからもう一度お試しください')
}

export class CloudApi {
  private client: RpcClient

  constructor(client: RpcClient) {
    this.client = client
  }

  private async call<T>(fn: string, args: Record<string, unknown>): Promise<T> {
    const { data, error } = await this.client.rpc(fn, args)
    if (error) throw rpcErrorToMessage(error)
    return data as T
  }

  async getPublicState(): Promise<PublicState> {
    const raw = await this.call<unknown>('get_public_state', {})
    return mapPublicState(raw)
  }

  async bookSeats(input: {
    name: string
    phone: string
    note: string
    items: { seatId: string; typeId: string }[]
  }): Promise<{ code: string; amount: number }> {
    const raw = await this.call<{ code: string; amount: number }>('book_seats', {
      p_name: input.name,
      p_phone: input.phone,
      p_note: input.note,
      p_items: input.items,
    })
    return { code: raw.code, amount: raw.amount }
  }

  async lookupReservation(code: string, phone: string): Promise<Reservation | null> {
    const raw = await this.call<unknown>('lookup_reservation', {
      p_code: code,
      p_phone: phone,
    })
    return mapLookupResult(raw)
  }

  async staffGetAll(passcode: string): Promise<StaffData> {
    const raw = await this.call<unknown>('staff_get_all', { p_passcode: passcode })
    return mapStaffData(raw)
  }

  async staffSell(
    passcode: string,
    name: string,
    items: { seatId: string; typeId: string }[],
    seller?: string,
  ): Promise<{ code: string; amount: number }> {
    // 販売者対応の4引数オーバーロードを呼ぶ（未選択は null → サーバ側で NULL 記録）
    const raw = await this.call<{ code: string; amount: number }>('staff_sell', {
      p_passcode: passcode,
      p_name: name,
      p_items: items,
      p_seller: seller?.trim() ? seller.trim() : null,
    })
    return { code: raw.code, amount: raw.amount }
  }

  /**
   * 本人キャンセル（cancel_reservation RPC）。
   * 業務結果は例外ではなく JSON { ok, result } で返るので、result をそのまま返す。
   * 未知の result や形が違う応答は通信エラーとして投げる。
   */
  async cancelReservation(code: string, phone: string): Promise<SelfCancelResult> {
    const raw = await this.call<unknown>('cancel_reservation', {
      p_code: code,
      p_phone: phone,
    })
    const result = (raw as { result?: unknown } | null)?.result
    const known: SelfCancelResult[] = [
      'OK',
      'NOT_FOUND',
      'ALREADY_CANCELLED',
      'PAID_LOCKED',
      'CHECKED_IN_LOCKED',
      'TOO_LATE',
    ]
    if (typeof result === 'string' && (known as string[]).includes(result)) {
      return result as SelfCancelResult
    }
    throw new Error('通信に失敗しました。しばらくしてからもう一度お試しください')
  }

  async staffUpdateReservation(
    passcode: string,
    cloudId: string,
    patch: { paid: boolean; checkedIn: boolean; status: 'active' | 'cancelled' },
  ): Promise<void> {
    await this.call('staff_update_reservation', {
      p_passcode: passcode,
      p_id: cloudId,
      p_paid: patch.paid,
      p_checked_in: patch.checkedIn,
      p_status: patch.status,
    })
  }

  async staffSaveConfig(
    passcode: string,
    performance: Performance,
    blockedSeats: string[],
    bookingDeadline: string | null,
  ): Promise<void> {
    await this.call('staff_save_config', {
      p_passcode: passcode,
      p_performance: performance,
      p_blocked_seats: blockedSeats,
      // datetime-local の文字列はそのまま渡す（timestamptz として解釈される）
      p_booking_deadline: bookingDeadline,
    })
  }

  async staffChangePasscode(passcode: string, newPasscode: string): Promise<void> {
    await this.call('staff_change_passcode', {
      p_passcode: passcode,
      p_new_passcode: newPasscode,
    })
  }
}

/** 本物の Supabase クライアントで CloudApi を作る（動的 import 先） */
export async function createCloudApi(): Promise<{
  api: CloudApi
  subscribeSeatChanges: (
    onChange: () => void,
    onStatus?: (status: string) => void,
  ) => () => void
}> {
  const { createClient } = await import('@supabase/supabase-js')
  const { SUPABASE_URL, SUPABASE_ANON_KEY } = await import('./config')
  const client: SupabaseClient = createClient(SUPABASE_URL!, SUPABASE_ANON_KEY!)

  const api = new CloudApi(client as unknown as RpcClient)

  const subscribeSeatChanges = (onChange: () => void, onStatus?: (status: string) => void) => {
    const channel = client
      .channel('sakura-seat-state')
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'seat_state' },
        () => onChange(),
      )
      // 購読状態（SUBSCRIBED / CHANNEL_ERROR / TIMED_OUT / CLOSED）を伝える。
      // 再接続のたびに SUBSCRIBED が来るので、呼び出し側はそのタイミングで
      // 取りこぼした変更を再取得できる（R4-3）。
      .subscribe((status) => {
        onStatus?.(status)
      })
    return () => {
      void client.removeChannel(channel)
    }
  }

  return { api, subscribeSeatChanges }
}
