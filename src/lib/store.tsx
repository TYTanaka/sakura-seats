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
  setBlockedForSeats,
  setCheckedIn,
  setPaid,
  toggleBlocked,
  updatePerformance,
  type AppData,
  type NewReservationInput,
  type Performance,
  type Reservation,
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

function loadData(): AppData {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return emptyData()
    // 旧形式（単価のみ・明細なし予約）も normalizeAppData が現行形式へ移行する
    return normalizeAppData(JSON.parse(raw)) ?? emptyData()
  } catch {
    return emptyData()
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
  const [data, setData] = useState<AppData>(loadData)
  const [passcode, setPasscode] = useState<string>(loadPasscode)

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(data))
    } catch {
      // 保存に失敗しても画面操作は継続する
    }
  }, [data])

  const store = useMemo<Store>(
    () => ({
      data,
      mode: 'local',
      ready: true,
      loadError: null,
      retryLoad: () => undefined,
      reserve: async (input) => {
        const result = createReservation(data, input)
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
    [data, passcode],
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
