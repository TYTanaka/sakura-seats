import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ComponentType,
  type ReactNode,
} from 'react'
import {
  cancelReservation,
  createReservation,
  emptyData,
  findReservationByCodePhone,
  normalizeAppData,
  selfCancelEligibility,
  setBlockedForSeats,
  setCheckedIn,
  setPaid,
  toggleBlocked,
  updatePerformance,
  type AppData,
  type NewReservationInput,
  type Performance,
  type Reservation,
  type SelfCancelResult,
} from './logic'
import { cloudEnabled } from './config'

/**
 * ストアの共通インターフェース。
 * - ローカルモード（環境変数なし）: localStorage に保存する従来動作
 * - クラウドモード（VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY あり）:
 *   Supabase RPC 経由で全端末同期する（実装は cloudStore.tsx を動的 import）
 * 操作はどちらも Promise を返す形に統一し、画面側は await して使う。
 */

export interface Store {
  data: AppData
  mode: 'local' | 'cloud'
  /** 表示してよい状態か（クラウドの初回読み込み完了まで false） */
  ready: boolean
  /** クラウド読み込みエラー（未設定は null） */
  loadError: string | null
  retryLoad: () => void
  /**
   * ローカルモードの保存に関する警告（読み込み破損・保存失敗）。
   * クラウドモードでは常に null。
   */
  storageWarning: string | null
  /**
   * クラウドの接続状態。'ok' 以外は「表示が古いかもしれない」状態。
   * ローカルモードでは常に 'ok'。
   */
  syncState: 'ok' | 'reconnecting' | 'offline'
  reserve: (input: NewReservationInput) => Promise<Reservation>
  cancel: (reservationId: string) => Promise<void>
  setCheckedIn: (reservationId: string, value: boolean) => Promise<void>
  setPaid: (reservationId: string, value: boolean) => Promise<void>
  /** 受付完了ワンタップ: 支払い済み＋来場済みを一度に設定する */
  completeReception: (reservationId: string) => Promise<void>
  toggleBlocked: (seatId: string) => Promise<void>
  setBlockedForSeats: (seatIds: string[], blocked: boolean) => Promise<void>
  /** 公演設定と予約締切をまとめて保存する */
  saveSettings: (perf: Performance, bookingDeadline: string | null) => Promise<void>
  lookupReservation: (code: string, phone: string) => Promise<Reservation | null>
  /**
   * 本人キャンセル（予約確認ページから）。結果コードを返す。
   * クラウド: cancel_reservation RPC が判定する。
   * ローカル: selfCancelEligibility と同じ規則で判定し、OK のときだけ取り消す。
   */
  selfCancelReservation: (code: string, phone: string) => Promise<SelfCancelResult>
  /** スタッフ入室。パスコードが合えばスタッフ用データも読み込んで true */
  staffUnlock: (passcode: string) => Promise<boolean>
  changePasscode: (newPasscode: string) => Promise<void>
  resetAll: () => void
}

export const StoreContext = createContext<Store | null>(null)

export function useStore(): Store {
  const store = useContext(StoreContext)
  if (!store) throw new Error('useStore は StoreProvider の中で使ってください')
  return store
}

/* ---------------- ローカルモード（localStorage） ---------------- */

const STORAGE_KEY = 'sakura-seats-v1'
const PASSCODE_KEY = 'sakura-seats-passcode'
export const DEFAULT_PASSCODE = '1234'

const CORRUPT_WARNING =
  '保存されていた予約データを読み込めませんでした（データが壊れている可能性があります）。初期状態で表示しています。端末に残っている予約が消えている場合は、スタッフまでお知らせください。'

const PERSIST_WARNING =
  '端末への保存に失敗しています（空き容量不足の可能性があります）。このまま操作を続けると、再読み込みで変更が消えるおそれがあります。'

interface LoadResult {
  data: AppData
  /** 保存データが壊れていた場合の警告（無言で初期化しない） */
  warning: string | null
}

function loadData(): LoadResult {
  let raw: string | null
  try {
    raw = localStorage.getItem(STORAGE_KEY)
  } catch {
    return { data: emptyData(), warning: CORRUPT_WARNING }
  }
  if (!raw) return { data: emptyData(), warning: null }
  try {
    // 旧形式（単価のみ・明細なし予約）も normalizeAppData が現行形式へ移行する
    const normalized = normalizeAppData(JSON.parse(raw))
    if (!normalized) return { data: emptyData(), warning: CORRUPT_WARNING }
    return { data: normalized, warning: null }
  } catch {
    return { data: emptyData(), warning: CORRUPT_WARNING }
  }
}

/** localStorage への保存を試み、成否を返す（失敗を無言で握り潰さない） */
function persistData(data: AppData): boolean {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(data))
    return true
  } catch {
    return false
  }
}

function loadPasscode(): string {
  try {
    return localStorage.getItem(PASSCODE_KEY) || DEFAULT_PASSCODE
  } catch {
    return DEFAULT_PASSCODE
  }
}

function LocalStoreProvider({ children }: { children: ReactNode }) {
  const [initial] = useState<LoadResult>(loadData)
  const [data, setData] = useState<AppData>(initial.data)
  const [passcode, setPasscode] = useState<string>(loadPasscode)
  /** 保存に失敗し続けているかどうか（容量枯渇など） */
  const [persistFailed, setPersistFailed] = useState(false)

  useEffect(() => {
    setPersistFailed(!persistData(data))
  }, [data])

  const storageWarning = initial.warning ?? (persistFailed ? PERSIST_WARNING : null)

  const store = useMemo<Store>(
    () => ({
      data,
      mode: 'local',
      ready: true,
      loadError: null,
      retryLoad: () => undefined,
      storageWarning,
      syncState: 'ok',
      reserve: async (input) => {
        const result = createReservation(data, input)
        // 保存できて初めて「予約完了」とする。容量不足などで保存できないのに
        // 完了画面と予約番号だけ出す（＝再読み込みで消える）ことはしない（R4-2）
        if (!persistData(result.data)) {
          throw new Error(
            '端末への保存に失敗したため、予約を完了できませんでした。端末の空き容量を確認して、もう一度お試しください',
          )
        }
        setData(result.data)
        return result.reservation
      },
      cancel: async (reservationId) =>
        setData((prev) => cancelReservation(prev, reservationId)),
      setCheckedIn: async (reservationId, value) =>
        setData((prev) => setCheckedIn(prev, reservationId, value)),
      setPaid: async (reservationId, value) => setData((prev) => setPaid(prev, reservationId, value)),
      completeReception: async (reservationId) =>
        setData((prev) => setCheckedIn(setPaid(prev, reservationId, true), reservationId, true)),
      toggleBlocked: async (seatId) => setData((prev) => toggleBlocked(prev, seatId)),
      setBlockedForSeats: async (seatIds, blocked) =>
        setData((prev) => setBlockedForSeats(prev, seatIds, blocked)),
      saveSettings: async (perf, bookingDeadline) =>
        setData((prev) => ({ ...updatePerformance(prev, perf), bookingDeadline })),
      lookupReservation: async (code, phone) => findReservationByCodePhone(data, code, phone),
      selfCancelReservation: async (code, phone) => {
        const target = findReservationByCodePhone(data, code, phone)
        const result = selfCancelEligibility(target, data)
        if (result === 'OK' && target) {
          setData((prev) => cancelReservation(prev, target.id))
        }
        return result
      },
      staffUnlock: async (candidate) => candidate === passcode,
      changePasscode: async (newPasscode) => {
        setPasscode(newPasscode)
        try {
          localStorage.setItem(PASSCODE_KEY, newPasscode)
        } catch {
          // 保存できなくても今回のセッションでは有効
        }
      },
      resetAll: () => setData(emptyData()),
    }),
    [data, passcode, storageWarning],
  )

  return <StoreContext.Provider value={store}>{children}</StoreContext.Provider>
}

/* ---------------- クラウドモード（動的 import） ---------------- */

function CloudStoreLazy({ children }: { children: ReactNode }) {
  const [Provider, setProvider] = useState<ComponentType<{ children: ReactNode }> | null>(null)
  useEffect(() => {
    let active = true
    void import('./cloudStore').then((m) => {
      if (active) setProvider(() => m.CloudStoreProvider)
    })
    return () => {
      active = false
    }
  }, [])

  if (!Provider) {
    return (
      <div className="app-shell">
        <p className="loading-note">読み込み中…♪</p>
      </div>
    )
  }
  return <Provider>{children}</Provider>
}

export function StoreProvider({ children }: { children: ReactNode }) {
  if (!cloudEnabled) return <LocalStoreProvider>{children}</LocalStoreProvider>
  return <CloudStoreLazy>{children}</CloudStoreLazy>
}
