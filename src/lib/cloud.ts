import type { SupabaseClient } from '@supabase/supabase-js'
import {
  normalizePerformance,
  type CheckInResult,
  type Performance,
  type Reservation,
  type SelfCancelResult,
  type UncancelResult,
} from './logic'
import { isQrToken } from './qrToken'
import {
  mapAllowlist,
  mapWhoami,
  type StaffAllowlist,
  type StaffWhoami,
} from './staffAuth'

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

/** Auth が使う最小限のユーザー形状 */
export interface AuthUserLike {
  email?: string | null
}

/**
 * Supabase Auth のアダプタ（R8・Googleログイン）。
 * CloudApi はこの形越しにだけ Auth を触る（テストではモックを差す）。
 */
export interface AuthAdapter {
  /** 現在のセッションのユーザー（未ログインは null） */
  getSessionUser: () => Promise<AuthUserLike | null>
  /** Google OAuth を開始する（成功時はブラウザごと遷移する） */
  signInWithGoogle: (redirectTo: string) => Promise<void>
  /** ログアウトする */
  signOut: () => Promise<void>
  /** セッションユーザーの変化を購読する。戻り値は解除関数 */
  onUserChange: (cb: (user: AuthUserLike | null) => void) => () => void
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
  /**
   * 受付用 QR トークン（R7・migration_sakura_r7）。
   * 本人確認済みの経路（book_seats の返却・lookup_reservation）でのみ返る。
   * staff_get_all には含めない（受付はトークン提示→RPC検証で完結するため）。
   */
  qrToken?: string | null
  /** 受付日時（staff_get_all が返す。未受付は null） */
  checkedInAt?: string | null
  /** 予約時点の公演スナップショット（公演照合用） */
  perfDate?: string | null
  perfName?: string | null
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
    qrToken: isQrToken(row.qrToken) ? row.qrToken : undefined,
    checkedInAt:
      typeof row.checkedInAt === 'string' && row.checkedInAt ? row.checkedInAt : null,
    perfDate: typeof row.perfDate === 'string' && row.perfDate ? row.perfDate : undefined,
    perfName: typeof row.perfName === 'string' && row.perfName ? row.perfName : undefined,
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
  // R6 の RPC が未適用の DB では PostgREST が「関数が見つからない」を返す。
  // 汎用の通信エラーではなく、更新が必要なことが分かる文面にする
  if (
    msg.includes('staff_uncancel_reservation') &&
    (msg.includes('Could not find') || msg.includes('PGRST'))
  ) {
    return new Error(
      'キャンセルの取り消しは、サーバ更新（migration_sakura_r6 の適用）後に使えるようになります',
    )
  }
  // R7 の RPC が未適用の DB では QR 受付だけがこの文面になる。
  // 呼び出し側（cloudStore）はこの文面を見て「サーバ更新待ち」に分岐する
  if (
    msg.includes('staff_check_in') &&
    (msg.includes('Could not find') || msg.includes('PGRST'))
  ) {
    return new Error(
      'QR受付は、サーバ更新（migration_sakura_r7 の適用）後に使えるようになります',
    )
  }
  // R8 の RPC が未適用の DB では Google ログイン・許可リストだけがこの文面になる
  if (
    (msg.includes('staff_whoami') ||
      msg.includes('staff_allowlist') ||
      msg.includes('staff_set_passcode_login')) &&
    (msg.includes('Could not find') || msg.includes('PGRST'))
  ) {
    return new Error(
      'Googleログインとスタッフ許可リストは、サーバ更新（migration_sakura_r8 の適用）後に使えるようになります',
    )
  }
  if (msg.includes('LAST_STAFF')) {
    return new Error('最後の1人は削除できません（スタッフが誰もいなくなってしまいます）')
  }
  if (msg.includes('INVALID_EMAIL')) {
    return new Error('メールアドレスの形式が正しくありません')
  }
  if (msg.includes('JWT_REQUIRED')) {
    return new Error('この操作はGoogleログインしたスタッフのみ行えます')
  }
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
  private auth: AuthAdapter | null

  constructor(client: RpcClient, auth: AuthAdapter | null = null) {
    this.client = client
    this.auth = auth
  }

  /* ---------------- Auth（R8・Googleログイン） ---------------- */

  /** Googleログイン中のメールアドレス（未ログイン・Auth未接続は null） */
  async getSignedInEmail(): Promise<string | null> {
    if (!this.auth) return null
    const user = await this.auth.getSessionUser()
    return typeof user?.email === 'string' && user.email ? user.email : null
  }

  /** Google OAuth を開始する（redirectTo へ戻る。画面は遷移する） */
  async signInWithGoogle(redirectTo: string): Promise<void> {
    if (!this.auth) throw new Error('クラウドへ接続できていません')
    await this.auth.signInWithGoogle(redirectTo)
  }

  /** Googleからログアウトする */
  async signOutGoogle(): Promise<void> {
    if (!this.auth) return
    await this.auth.signOut()
  }

  /** セッションユーザーの変化（メールアドレス or null）を購読する */
  onSignedInEmailChange(cb: (email: string | null) => void): () => void {
    if (!this.auth) return () => undefined
    return this.auth.onUserChange((user) =>
      cb(typeof user?.email === 'string' && user.email ? user.email : null),
    )
  }

  /**
   * staff_whoami: JWT のメールがスタッフ許可リストにあるかだけを返す。
   * 未ログインでも例外にせず { ok:false } が返る設計（サーバ側）。
   * R8 未適用の DB では call が専用エラー（migration_sakura_r8 案内）を投げる。
   */
  async staffWhoami(): Promise<StaffWhoami> {
    const raw = await this.call<unknown>('staff_whoami', {})
    return mapWhoami(raw)
  }

  /** スタッフ許可リストの取得（要スタッフ認証。passcode は現資格情報） */
  async staffAllowlistList(passcode: string): Promise<StaffAllowlist> {
    const raw = await this.call<unknown>('staff_allowlist_list', { p_passcode: passcode })
    return mapAllowlist(raw)
  }

  /** 許可リストへメールアドレスを追加（既存はメモを更新）。最新のリストを返す */
  async staffAllowlistAdd(
    passcode: string,
    email: string,
    note: string,
  ): Promise<StaffAllowlist> {
    const raw = await this.call<unknown>('staff_allowlist_add', {
      p_passcode: passcode,
      p_email: email,
      p_note: note,
    })
    return mapAllowlist(raw)
  }

  /** 許可リストからメールアドレスを削除（最後の1人はサーバが拒否）。最新のリストを返す */
  async staffAllowlistRemove(passcode: string, email: string): Promise<StaffAllowlist> {
    const raw = await this.call<unknown>('staff_allowlist_remove', {
      p_passcode: passcode,
      p_email: email,
    })
    return mapAllowlist(raw)
  }

  /**
   * パスコードログインの有効/無効を切り替える。
   * 変更はサーバ側で Google（JWT）許可スタッフのみに制限される
   * （パスコードだけの資格情報では認証経路自体を変えさせない）。
   */
  async staffSetPasscodeLogin(
    passcode: string,
    enabled: boolean,
  ): Promise<StaffAllowlist> {
    const raw = await this.call<unknown>('staff_set_passcode_login', {
      p_passcode: passcode,
      p_enabled: enabled,
    })
    return mapAllowlist(raw)
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
  }): Promise<{ code: string; amount: number; token?: string }> {
    const raw = await this.call<{ code: string; amount: number; token?: unknown }>(
      'book_seats',
      {
        p_name: input.name,
        p_phone: input.phone,
        p_note: input.note,
        p_items: input.items,
      },
    )
    // R7 未適用の DB では token が返らない（undefined のまま＝QRは番号表示に落とす）
    return {
      code: raw.code,
      amount: raw.amount,
      token: isQrToken(raw.token) ? raw.token : undefined,
    }
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
  ): Promise<{ code: string; amount: number; token?: string }> {
    // 販売者対応の4引数オーバーロードを呼ぶ（未選択は null → サーバ側で NULL 記録）
    const raw = await this.call<{ code: string; amount: number; token?: unknown }>(
      'staff_sell',
      {
        p_passcode: passcode,
        p_name: name,
        p_items: items,
        p_seller: seller?.trim() ? seller.trim() : null,
      },
    )
    return {
      code: raw.code,
      amount: raw.amount,
      token: isQrToken(raw.token) ? raw.token : undefined,
    }
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

  /**
   * キャンセルの取り消し（staff_uncancel_reservation RPC・R6）。
   * 業務結果は例外ではなく JSON { ok, result } で返るので result をそのまま返す。
   * RPC 自体が未適用の DB では call が上記の専用エラーを投げる。
   */
  async staffUncancelReservation(passcode: string, code: string): Promise<UncancelResult> {
    const raw = await this.call<unknown>('staff_uncancel_reservation', {
      p_passcode: passcode,
      p_code: code,
    })
    const result = (raw as { result?: unknown } | null)?.result
    const known: UncancelResult[] = ['OK', 'NOT_FOUND', 'NOT_CANCELLED', 'SEAT_TAKEN']
    if (typeof result === 'string' && (known as string[]).includes(result)) {
      return result as UncancelResult
    }
    throw new Error('通信に失敗しました。しばらくしてからもう一度お試しください')
  }

  /**
   * QR受付（staff_check_in RPC・R7）。トークンをサーバで検証し、受付を記録する。
   * 業務結果は例外ではなく JSON { ok, result } で返るので result をそのまま返す。
   * 予約が見つかった場合は画面表示用の要約（Reservation 形式）も返す。
   * RPC 自体が未適用の DB では call が専用エラー（migration_sakura_r7 案内）を投げる。
   */
  async staffCheckIn(
    passcode: string,
    token: string,
  ): Promise<{
    result: CheckInResult
    reservation: Reservation | null
    checkedInAt: string | null
  }> {
    const raw = (await this.call<unknown>('staff_check_in', {
      p_passcode: passcode,
      p_token: token,
    })) as {
      result?: unknown
      code?: unknown
      name?: unknown
      items?: unknown
      amount?: unknown
      kind?: unknown
      paid?: unknown
      checkedInAt?: unknown
      perfDate?: unknown
      perfName?: unknown
    } | null
    const known: CheckInResult[] = [
      'OK',
      'ALREADY_CHECKED_IN',
      'CANCELLED',
      'WRONG_PERFORMANCE',
      'NOT_FOUND',
    ]
    const result = raw?.result
    if (typeof result !== 'string' || !(known as string[]).includes(result)) {
      throw new Error('通信に失敗しました。しばらくしてからもう一度お試しください')
    }
    const checkedInAt =
      typeof raw?.checkedInAt === 'string' && raw.checkedInAt ? raw.checkedInAt : null
    let reservation: Reservation | null = null
    if (typeof raw?.code === 'string' && Array.isArray(raw.items)) {
      reservation = mapReservationRow({
        id: '',
        code: raw.code,
        name: typeof raw.name === 'string' ? raw.name : '',
        phone: '',
        note: '',
        items: raw.items as Reservation['items'],
        amount: typeof raw.amount === 'number' ? raw.amount : 0,
        kind: raw.kind === 'door' ? 'door' : 'online',
        paid: raw.paid === true,
        checkedIn: result === 'OK' || result === 'ALREADY_CHECKED_IN',
        status: result === 'CANCELLED' ? 'cancelled' : 'active',
        createdAt: '',
        checkedInAt,
        perfDate: typeof raw.perfDate === 'string' ? raw.perfDate : null,
        perfName: typeof raw.perfName === 'string' ? raw.perfName : null,
      })
    }
    return { result: result as CheckInResult, reservation, checkedInAt }
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

  const auth: AuthAdapter = {
    getSessionUser: async () => {
      const { data } = await client.auth.getSession()
      return data.session?.user ?? null
    },
    signInWithGoogle: async (redirectTo) => {
      const { error } = await client.auth.signInWithOAuth({
        provider: 'google',
        options: { redirectTo },
      })
      if (error) {
        throw new Error(
          'Googleログインを開始できませんでした。しばらくしてからもう一度お試しください',
        )
      }
    },
    signOut: async () => {
      await client.auth.signOut()
    },
    onUserChange: (cb) => {
      const { data } = client.auth.onAuthStateChange((_event, session) => {
        cb(session?.user ?? null)
      })
      return () => data.subscription.unsubscribe()
    },
  }

  const api = new CloudApi(client as unknown as RpcClient, auth)

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
