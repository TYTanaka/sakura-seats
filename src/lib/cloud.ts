import type { SupabaseClient } from '@supabase/supabase-js'
import {
  normalizeAccessNeeds,
  normalizePerformance,
  normalizeWaitlistEntry,
  type CheckInResult,
  type Performance,
  type Reservation,
  type SelfCancelResult,
  type UncancelResult,
  type WaitlistEntry,
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
  /**
   * ゾーンごとの未割当ホールド人数（R12・migration_sakura_r12）。
   * サーバが集計だけを返す（誰の予約かは含まない）。R12 未適用の DB では
   * キー自体が返らないため、その場合は空オブジェクトになる。
   */
  zoneHolds: Record<string, number>
}

export interface StaffData {
  performance: Performance
  blockedSeats: string[]
  bookingDeadline: string | null
  reservations: Reservation[]
  /** キャンセル待ち登録の一覧（R38。r38 未適用の DB では空） */
  waitlist: WaitlistEntry[]
}

/**
 * staff_check_in の結果コード（R17）。画面向けの CheckInResult に、
 * 席の同時割当のためのストア内部コード3つを加えたもの:
 * NEEDS_SEATS（席の詰め直しが必要）/ SEAT_TAKEN（席が使われていた）/
 * SEAT_INVALID（席の指定が不正）。この3つは cloudStore が処理し、
 * 画面（CheckInOutcome）には出さない。
 */
export type StaffCheckInResult =
  | CheckInResult
  | 'NEEDS_SEATS'
  | 'SEAT_TAKEN'
  | 'SEAT_INVALID'

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
  /** ゾーン予約のゾーンID（R12。従来型の予約・R12 未適用の DB では null/無し） */
  zone?: string | null
  /** 座席の希望（R38。車椅子席/親子室。旧 DB では無し） */
  accessNeeds?: unknown
  /** 返金済みかどうか（R38。staff_get_all のみ） */
  refunded?: boolean | null
  /** 返金済みにした日時（R38） */
  refundedAt?: string | null
  /** 受付を処理した担当者名（R38。staff_get_all のみ） */
  checkedInBy?: string | null
  /** 支払い確定を処理した担当者名（R38。staff_get_all のみ） */
  paidBy?: string | null
}

/** DB行 → クライアントの Reservation への変換 */
export function mapReservationRow(row: RawReservationRow): Reservation {
  const items = Array.isArray(row.items) ? row.items : []
  return {
    id: row.code,
    cloudId: row.id,
    // R12: ゾーン予約（未割当）は明細の seatId が空文字。席として数えない
    seatIds: items.map((i) => i.seatId).filter((s) => typeof s === 'string' && s !== ''),
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
    zone: typeof row.zone === 'string' && row.zone ? row.zone : undefined,
    // R38: 希望・返金・担当者（返ってこない DB では既定値に落とす）
    ...(normalizeAccessNeeds(row.accessNeeds).length > 0
      ? { accessNeeds: normalizeAccessNeeds(row.accessNeeds) }
      : {}),
    ...(row.refunded === true ? { refunded: true } : {}),
    refundedAt:
      typeof row.refundedAt === 'string' && row.refundedAt ? row.refundedAt : null,
    ...(typeof row.checkedInBy === 'string' && row.checkedInBy.trim()
      ? { checkedInBy: row.checkedInBy.trim() }
      : {}),
    ...(typeof row.paidBy === 'string' && row.paidBy.trim()
      ? { paidBy: row.paidBy.trim() }
      : {}),
  }
}

interface RawConfig {
  performance?: unknown
  blockedSeats?: unknown
  bookingDeadline?: unknown
}

function mapConfig(raw: RawConfig): Omit<StaffData, 'reservations' | 'waitlist'> {
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
  const rec = (raw ?? {}) as RawConfig & { seats?: unknown; zoneHolds?: unknown }
  const seatStates: Record<string, 'reserved' | 'sold'> = {}
  if (Array.isArray(rec.seats)) {
    for (const s of rec.seats as { seatId?: unknown; state?: unknown }[]) {
      if (typeof s?.seatId === 'string' && (s.state === 'reserved' || s.state === 'sold')) {
        seatStates[s.seatId] = s.state
      }
    }
  }
  const zoneHolds: Record<string, number> = {}
  if (rec.zoneHolds && typeof rec.zoneHolds === 'object') {
    for (const [zone, count] of Object.entries(rec.zoneHolds as Record<string, unknown>)) {
      if (typeof count === 'number' && Number.isFinite(count) && count > 0) {
        zoneHolds[zone] = Math.floor(count)
      }
    }
  }
  return { ...mapConfig(rec), seatStates, zoneHolds }
}

/** staff_get_all の戻り値 → StaffData */
export function mapStaffData(raw: unknown): StaffData {
  const rec = (raw ?? {}) as {
    config?: RawConfig
    reservations?: unknown
    waitlist?: unknown
  }
  const config = mapConfig(rec.config ?? {})
  const reservations = Array.isArray(rec.reservations)
    ? (rec.reservations as RawReservationRow[]).map(mapReservationRow)
    : []
  // R38: キャンセル待ち（r38 未適用の DB ではキー自体が無いため空になる）
  const waitlist = Array.isArray(rec.waitlist)
    ? rec.waitlist
        .map((w) => normalizeWaitlistEntry(w))
        .filter((w): w is WaitlistEntry => w !== null)
    : []
  return { ...config, reservations, waitlist }
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
  // R25 の RPC が未適用の DB では席の手動指定だけがこの文面になる
  if (
    msg.includes('staff_assign_seats') &&
    (msg.includes('Could not find') || msg.includes('PGRST'))
  ) {
    return new Error(
      '席の手動指定は、サーバ更新（migration_sakura_r25 の適用）後に使えるようになります',
    )
  }
  // R38 の RPC が未適用の DB ではキャンセル待ち登録だけがこの文面になる
  if (
    (msg.includes('add_waitlist') || msg.includes('staff_remove_waitlist')) &&
    (msg.includes('Could not find') || msg.includes('PGRST'))
  ) {
    return new Error(
      'キャンセル待ちは、サーバ更新（migration_sakura_r38 の適用）後に使えるようになります',
    )
  }
  // R12 の RPC が未適用の DB ではゾーン予約・支払い時割当だけがこの文面になる
  if (
    (msg.includes('book_zone') ||
      msg.includes('staff_assign_and_pay') ||
      msg.includes('staff_unassign_and_unpay')) &&
    (msg.includes('Could not find') || msg.includes('PGRST'))
  ) {
    return new Error(
      'ゾーン予約（席はお支払い後に確定）は、サーバ更新（migration_sakura_r12 の適用）後に使えるようになります',
    )
  }
  // R12: ゾーン満席。呼び出し側（申込フロー）はこの文面を見てゾーン選び直しへ戻す
  if (msg.includes('ZONE_FULL')) {
    return new Error('このゾーンは満席です。他のゾーンをお選びください')
  }
  if (msg.includes('INVALID_ZONE')) {
    return new Error('ゾーンが正しく選ばれていません。ゾーンを選び直してください')
  }
  if (msg.includes('SEAT_NOT_IN_ZONE')) {
    return new Error('割り当てようとした席がゾーンの範囲外でした。もう一度お試しください')
  }
  if (msg.includes('SEAT_COUNT_MISMATCH')) {
    return new Error('割り当てる席の数が人数と一致しませんでした。もう一度お試しください')
  }
  if (msg.includes('ALREADY_ASSIGNED')) {
    return new Error('すでに別の席が割り当てられています。画面を更新して確認してください')
  }
  if (msg.includes('ALREADY_CANCELLED')) {
    return new Error('キャンセル済みの予約です。画面を更新して確認してください')
  }
  if (msg.includes('NOT_ZONE_BOOKING')) {
    return new Error('この予約はゾーン予約ではありません')
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
  // R9 の予約フラッド防止（migration_sakura_r9）。どちらも通常の予約
  // エラーとして扱い、再提案フローには乗せない（呼び出し側が文面を表示）
  if (msg.includes('PHONE_LIMIT')) {
    return new Error('この電話番号でのご予約が上限に達しています')
  }
  if (msg.includes('TOO_BUSY')) {
    return new Error('ただいま混み合っています。少し時間をおいてお試しください')
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
  if (msg.includes('NOT_FOUND')) {
    return new Error('対象が見つかりませんでした。画面を更新して確認してください')
  }
  // R15 の厳格チェック（サーバ側トリガ）。クライアント側でも同じ規則で
  // 弾くため通常は届かないが、直接 RPC を叩かれた場合等の最終表示。
  if (msg.includes('PHONE_INVALID')) {
    return new Error('電話番号の形式が正しくないようです。番号をご確認ください')
  }
  return new Error('通信に失敗しました。しばらくしてからもう一度お試しください')
}

/**
 * PostgREST の「関数が見つからない」エラーかどうか。
 * R38 で引数を増やした RPC は、旧 DB ではシグネチャ不一致でこのエラーになる。
 * その場合は旧引数で再試行し、担当者記録だけが省略される形に劣化させる
 * （受付・支払い自体は止めない）ために使う。
 */
function isFunctionNotFound(error: { message: string } | null): boolean {
  if (!error) return false
  const msg = error.message ?? ''
  return msg.includes('Could not find') || msg.includes('PGRST202')
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
   * staff_login（R9・migration_sakura_r9）: パスコードログイン専用 RPC。
   * 成否を例外ではなく { ok } で返し、サーバ側はこの経路でのみ失敗回数を
   * 数えてスロットルする（例外で終わる呼び出しは書き込みがロールバック
   * されるため、staff_get_all 側では数えられない）。
   * 戻り値: true = 成功 / false = 失敗（パスコード間違い、またはロック中。
   * サーバは両者を見分けられない形で返す）
   *         null = 判定不能（R9 未適用の DB で RPC が無い、通信エラー等）。
   *         呼び出し側は従来フロー（staffGetAll の成否判定）へ落としてよい。
   * この追加呼び出しのせいでログインが壊れないよう、RPC の失敗は握って
   * null にする（最悪ケースは「失敗を数えない」だけで、成否判定は
   * staffGetAll が従来どおり行う）。
   */
  async staffLogin(passcode: string): Promise<boolean | null> {
    try {
      const { data, error } = await this.client.rpc('staff_login', {
        p_passcode: passcode,
      })
      if (error) return null
      return (data as { ok?: unknown } | null)?.ok === true
    } catch {
      return null
    }
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

  /**
   * ゾーン予約（book_zone RPC・R12）。席は割り当てず、ゾーン＋人数
   * （券種IDの並び）だけを申し込む。金額はサーバ再計算の返却値が正。
   * 満席なら ZONE_FULL のエラー（rpcErrorToMessage で文面化）になる。
   */
  async bookZone(input: {
    name: string
    phone: string
    note: string
    zone: string
    typeIds: string[]
    /** 座席の希望（R38・車椅子席/親子室） */
    accessNeeds?: string[]
  }): Promise<{ code: string; amount: number; token?: string }> {
    const needs = input.accessNeeds ?? []
    const baseArgs = {
      p_name: input.name,
      p_phone: input.phone,
      p_note: input.note,
      p_zone: input.zone,
      p_type_ids: input.typeIds,
    }
    let raw: { code: string; amount: number; token?: unknown }
    if (needs.length === 0) {
      // 希望なしは従来どおり（旧 DB でもそのまま動く）
      raw = await this.call('book_zone', baseArgs)
    } else {
      // 希望ありは r38 版 book_zone が必要。旧 DB では案内文面で投げる
      const { data, error } = await this.client.rpc('book_zone', {
        ...baseArgs,
        p_access_needs: needs,
      })
      if (error) {
        if (isFunctionNotFound(error)) {
          throw new Error(
            '車椅子席・親子室の希望申込は、サーバ更新（migration_sakura_r38 の適用）後に使えるようになります',
          )
        }
        throw rpcErrorToMessage(error)
      }
      raw = data as { code: string; amount: number; token?: unknown }
    }
    return {
      code: raw.code,
      amount: raw.amount,
      token: isQrToken(raw.token) ? raw.token : undefined,
    }
  }

  /**
   * 支払い確定＋座席割当（staff_assign_and_pay RPC・R12）。
   * スタッフアプリが zones.ts で選んだ席を渡し、サーバが再検証してから
   * paid=true と席を原子的に確定する。検証に失敗したら例外（支払い済みに
   * ならない）。p_checked_in=true で受付完了（支払い＋来場）として扱う。
   */
  async staffAssignAndPay(
    passcode: string,
    cloudId: string,
    seatIds: string[],
    checkedIn: boolean,
    /** R38: 支払い確定（受付完了時は受付も）の処理者名。未選択は省略 */
    operator?: string,
  ): Promise<void> {
    const baseArgs = {
      p_passcode: passcode,
      p_id: cloudId,
      p_seat_ids: seatIds,
      p_checked_in: checkedIn,
    }
    if (!operator?.trim()) {
      await this.call('staff_assign_and_pay', baseArgs)
      return
    }
    const { error } = await this.client.rpc('staff_assign_and_pay', {
      ...baseArgs,
      p_operator: operator.trim(),
    })
    if (!error) return
    if (isFunctionNotFound(error)) {
      // 旧 DB: 担当者記録なしで従来どおり確定する（操作自体は止めない）
      await this.call('staff_assign_and_pay', baseArgs)
      return
    }
    throw rpcErrorToMessage(error)
  }

  /**
   * 席だけの手動指定（staff_assign_seats RPC・R25）。
   * 支払い・来場の状態は変えず、未割当のゾーン予約にスタッフが選んだ席を
   * 確定する（自動割当できずに手動チェックインした席未確定の予約向け）。
   * 検証はサーバ側（staff_assign_and_pay と同一基準）。失敗は例外になる。
   * RPC 未適用の DB では rpcErrorToMessage が専用文面（r25 案内）にする。
   */
  async staffAssignSeats(
    passcode: string,
    cloudId: string,
    seatIds: string[],
  ): Promise<void> {
    await this.call('staff_assign_seats', {
      p_passcode: passcode,
      p_id: cloudId,
      p_seat_ids: seatIds,
    })
  }

  /**
   * ゾーン予約を未払いに戻す（staff_unassign_and_unpay RPC・R12）。
   * 原則として割り当てた席を解放し、明細の seatId を空に戻す。
   * R21: 来場済みの予約はサーバ側で席を解放せず 'reserved' として保持する
   * （migration_sakura_r21。お客様が座っている席の二重割当を防ぐため）。
   */
  async staffUnassignAndUnpay(passcode: string, cloudId: string): Promise<void> {
    await this.call('staff_unassign_and_unpay', {
      p_passcode: passcode,
      p_id: cloudId,
    })
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
    // R38: ZONE_FULL は未割当ゾーン予約の復活が定員超過になる場合（M1）
    const known: UncancelResult[] = [
      'OK',
      'NOT_FOUND',
      'NOT_CANCELLED',
      'SEAT_TAKEN',
      'ZONE_FULL',
    ]
    if (typeof result === 'string' && (known as string[]).includes(result)) {
      return result as UncancelResult
    }
    throw new Error('通信に失敗しました。しばらくしてからもう一度お試しください')
  }

  /**
   * QR受付（staff_check_in RPC・R7 / R17）。トークンをサーバで検証し、受付を記録する。
   * 業務結果は例外ではなく JSON { ok, result } で返るので result をそのまま返す。
   * 予約が見つかった場合は画面表示用の要約（Reservation 形式）も返す。
   * RPC 自体が未適用の DB では call が専用エラー（migration_sakura_r7 案内）を投げる。
   *
   * R17: ゾーン予約で席が未割当なら、席なし（seatIds = null）の呼び出しは
   * 受付されず 'NEEDS_SEATS' が返る。呼び出し側（cloudStore）が最新の
   * 空席から席を詰めて seatIds 付きで再送すると、割当と受付が原子的に
   * 行われる。席が使われていた場合は 'SEAT_TAKEN'、席の指定自体が
   * 不正な場合は 'SEAT_INVALID' が返る（どちらも受付はされない）。
   * これら3つはストア内部の制御用で、画面向けの CheckInResult には
   * 含めない。
   */
  async staffCheckIn(
    passcode: string,
    token: string,
    seatIds: string[] | null = null,
    /** R38: 受付の処理者名。未選択は省略（旧 DB では自動で従来呼び出しに落とす） */
    operator?: string,
  ): Promise<{
    result: StaffCheckInResult
    reservation: Reservation | null
    checkedInAt: string | null
  }> {
    const baseArgs = {
      p_passcode: passcode,
      p_token: token,
      p_seat_ids: seatIds,
    }
    let rawUnknown: unknown
    if (operator?.trim()) {
      const { data, error } = await this.client.rpc('staff_check_in', {
        ...baseArgs,
        p_operator: operator.trim(),
      })
      if (error && !isFunctionNotFound(error)) throw rpcErrorToMessage(error)
      rawUnknown = error ? await this.call<unknown>('staff_check_in', baseArgs) : data
    } else {
      rawUnknown = await this.call<unknown>('staff_check_in', baseArgs)
    }
    const raw = rawUnknown as {
      result?: unknown
      code?: unknown
      name?: unknown
      items?: unknown
      amount?: unknown
      kind?: unknown
      paid?: unknown
      zone?: unknown
      checkedInAt?: unknown
      perfDate?: unknown
      perfName?: unknown
      accessNeeds?: unknown
    } | null
    const known: StaffCheckInResult[] = [
      'OK',
      'ALREADY_CHECKED_IN',
      'CANCELLED',
      'WRONG_PERFORMANCE',
      'NOT_FOUND',
      'NEEDS_SEATS',
      'SEAT_TAKEN',
      'SEAT_INVALID',
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
        zone: typeof raw.zone === 'string' ? raw.zone : null,
        // R38: 受付時の席詰めで専用席も割り当てるため、希望も要約に含める
        accessNeeds: raw.accessNeeds,
      })
    }
    return { result: result as StaffCheckInResult, reservation, checkedInAt }
  }

  async staffUpdateReservation(
    passcode: string,
    cloudId: string,
    patch: {
      paid: boolean
      checkedIn: boolean
      status: 'active' | 'cancelled'
      /** R38: 返金済みフラグ（指定した場合のみ更新する） */
      refunded?: boolean
      /** R38: 操作の処理者名（支払い確定・受付の記録用） */
      operator?: string
    },
  ): Promise<void> {
    const baseArgs = {
      p_passcode: passcode,
      p_id: cloudId,
      p_paid: patch.paid,
      p_checked_in: patch.checkedIn,
      p_status: patch.status,
    }
    const extra: Record<string, unknown> = {}
    if (patch.refunded !== undefined) extra.p_refunded = patch.refunded
    if (patch.operator?.trim()) extra.p_operator = patch.operator.trim()
    if (Object.keys(extra).length === 0) {
      await this.call('staff_update_reservation', baseArgs)
      return
    }
    const { error } = await this.client.rpc('staff_update_reservation', {
      ...baseArgs,
      ...extra,
    })
    if (!error) return
    if (isFunctionNotFound(error)) {
      // 旧 DB: 返金だけの更新は案内を出す（状態は変えない）。担当者のみの
      // 更新は従来呼び出しに落として操作自体は通す
      if (patch.refunded !== undefined) {
        throw new Error(
          '返金済みの記録は、サーバ更新（migration_sakura_r38 の適用）後に使えるようになります',
        )
      }
      await this.call('staff_update_reservation', baseArgs)
      return
    }
    throw rpcErrorToMessage(error)
  }

  /**
   * キャンセル待ち登録（add_waitlist RPC・R38）。
   * 検証（電話形式・人数・ゾーン・同一電話の上限）はサーバ側で行い、
   * 採番した登録番号（WL-0001 形式）を返す。RPC 未適用の DB では
   * rpcErrorToMessage が専用文面（r38 案内）にする。
   */
  async addWaitlist(input: {
    name: string
    phone: string
    zone: string | null
    partySize: number
  }): Promise<{ code: string }> {
    const raw = await this.call<{ code?: unknown }>('add_waitlist', {
      p_name: input.name,
      p_phone: input.phone,
      p_zone: input.zone,
      p_party_size: input.partySize,
    })
    if (typeof raw?.code !== 'string' || !raw.code) {
      throw new Error('通信に失敗しました。しばらくしてからもう一度お試しください')
    }
    return { code: raw.code }
  }

  /** キャンセル待ちの取り下げ（staff_remove_waitlist RPC・R38。要スタッフ認証） */
  async staffRemoveWaitlist(passcode: string, code: string): Promise<void> {
    await this.call('staff_remove_waitlist', {
      p_passcode: passcode,
      p_code: code,
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
