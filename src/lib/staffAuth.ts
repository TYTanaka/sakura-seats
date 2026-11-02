/**
 * スタッフ認証（R8）まわりの純粋ロジック。
 * - staff_whoami / staff_allowlist_* RPC の応答変換
 * - 許可リストのメールアドレス正規化
 * - スタッフ入室画面の表示分岐（Google / パスコード）の文言
 *
 * クラウド（Supabase Auth + 許可リスト）が正で、ここはその表示・変換層。
 * ローカルモードでは一切使わない。
 */

/** スタッフ入室に使った認証方式 */
export type StaffAuthMethod = 'google' | 'passcode'

/** staff_whoami の結果: JWT のメールが許可リストにあるか */
export interface StaffWhoami {
  ok: boolean
  /** JWT に載っていたメールアドレス（未ログインは null） */
  email: string | null
}

export interface StaffAllowlistEntry {
  email: string
  note: string
  /** 登録日時 ISO（サーバが返す。無い場合は null） */
  createdAt: string | null
}

export interface StaffAllowlist {
  /** パスコードログインが有効か（app_config のフラグ） */
  passcodeLoginEnabled: boolean
  entries: StaffAllowlistEntry[]
}

/** staff_whoami の生応答 → StaffWhoami */
export function mapWhoami(raw: unknown): StaffWhoami {
  const rec = (raw ?? {}) as { ok?: unknown; email?: unknown }
  return {
    ok: rec.ok === true,
    email: typeof rec.email === 'string' && rec.email ? rec.email : null,
  }
}

/** staff_allowlist_* の生応答 → StaffAllowlist */
export function mapAllowlist(raw: unknown): StaffAllowlist {
  const rec = (raw ?? {}) as { passcodeLoginEnabled?: unknown; entries?: unknown }
  const entries: StaffAllowlistEntry[] = []
  if (Array.isArray(rec.entries)) {
    for (const e of rec.entries as Record<string, unknown>[]) {
      if (typeof e?.email !== 'string' || !e.email) continue
      entries.push({
        email: e.email,
        note: typeof e.note === 'string' ? e.note : '',
        createdAt: typeof e.createdAt === 'string' && e.createdAt ? e.createdAt : null,
      })
    }
  }
  return { passcodeLoginEnabled: rec.passcodeLoginEnabled === true, entries }
}

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

/**
 * 許可リスト用メールアドレスの正規化（trim + 小文字化）。
 * 形式が不正なら null。サーバ側でも同じ規則で検証・小文字化する。
 */
export function normalizeStaffEmail(input: string): string | null {
  const email = input.trim().toLowerCase()
  if (!email || email.length > 254 || !EMAIL_PATTERN.test(email)) return null
  return email
}

/**
 * Googleログイン済みだが許可リスト外だったときの案内文。
 * 該当しない状況では null（＝案内を出さない）。
 */
export function googleDeniedMessage(
  signedInEmail: string | null,
  whoamiOk: boolean | null,
): string | null {
  if (!signedInEmail || whoamiOk !== false) return null
  return `Googleアカウント（${signedInEmail}）でログイン中ですが、このメールアドレスはスタッフ許可リストに登録されていません。パスコードで入室するか、管理者に登録を依頼してください。`
}

/** 入室中バナーに出す認証方式ラベル（Google のときだけメール付きで返す） */
export function authBadgeLabel(
  method: StaffAuthMethod | null,
  email: string | null,
): string | null {
  if (method !== 'google' || !email) return null
  return `Googleログイン中：${email}`
}
