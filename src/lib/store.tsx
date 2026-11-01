import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useRef,
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
import { isStaleRevision, nextRevision, parseRevision } from './revision'

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
/** 保存リビジョン（R5-1）。データ本体の形式は従来どおりで、番号だけを別キーに持つ */
const REV_KEY = 'sakura-seats-v1-rev'
const PASSCODE_KEY = 'sakura-seats-passcode'
export const DEFAULT_PASSCODE = '1234'

/** 他タブの更新を取り込んだときのお知らせ（R5-1） */
const TAB_SYNC_NOTICE = '別のタブで更新されたため、最新の状態に更新しました'

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

/** 保存済みリビジョンを読む（読めなければ 0 = 旧形式・未保存） */
function readRevision(): number {
  try {
    return parseRevision(localStorage.getItem(REV_KEY))
  } catch {
    return 0
  }
}

/**
 * データ本体とリビジョンを保存し、成否を返す（失敗を無言で握り潰さない）。
 * 本体→リビジョンの順に書く: リビジョンだけが先行して「新しい」と
 * 誤認される組み合わせを作らないため。
 */
function persistAll(data: AppData, rev: number): boolean {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(data))
    localStorage.setItem(REV_KEY, String(rev))
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
  /** 他タブの更新を取り込んだときのお知らせ（R5-1） */
  const [tabNotice, setTabNotice] = useState<string | null>(null)
  /** このタブが知っている保存リビジョンと、最新のデータ本体（ref で即時参照する） */
  const revRef = useRef(readRevision())
  const dataRef = useRef(initial.data)

  /** 他タブが保存した最新状態を取り込む（お知らせも出す） */
  const adoptLatest = () => {
    const stored = loadData()
    revRef.current = readRevision()
    dataRef.current = stored.data
    setData(stored.data)
    setTabNotice(TAB_SYNC_NOTICE)
  }

  /**
   * 保存済みリビジョンが自分の知る値とずれていたら（＝他タブが先に保存したら）
   * 最新を取り込む。取り込んだら true。
   */
  const refreshIfStale = (): boolean => {
    if (!isStaleRevision(readRevision(), revRef.current)) return false
    adoptLatest()
    return true
  }

  /** 変更を保存まで含めて確定する。保存できたら true（失敗時は警告バナーを立てる） */
  const commit = (next: AppData): boolean => {
    const rev = nextRevision(revRef.current)
    const ok = persistAll(next, rev)
    if (ok) {
      revRef.current = rev
      setPersistFailed(false)
    } else {
      setPersistFailed(true)
    }
    dataRef.current = next
    setData(next)
    return ok
  }

  /**
   * 変更操作の共通経路（R5-1）: まず他タブの更新を取り込んでから、
   * 最新データに対して変更を適用する。古い状態からの上書き保存は起こらない。
   */
  const mutate = (fn: (prev: AppData) => AppData): boolean => {
    refreshIfStale()
    return commit(fn(dataRef.current))
  }

  // 他タブの保存を storage イベントでも取り込む（操作しなくても表示が最新に追随する）
  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.key !== null && e.key !== STORAGE_KEY && e.key !== REV_KEY) return
      if (!isStaleRevision(readRevision(), revRef.current)) return
      adoptLatest()
    }
    window.addEventListener('storage', onStorage)
    return () => window.removeEventListener('storage', onStorage)
    // adoptLatest は ref と setter のみを使うため、初回マウント時の登録でよい
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const storageWarning =
    initial.warning ?? (persistFailed ? PERSIST_WARNING : null) ?? tabNotice

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
        // 他タブが先に予約していたら取り込んでから、採番・席チェックをやり直す。
        // 古い seq で再発番したり、先の予約を上書きしたりしないため（R5-1）
        refreshIfStale()
        const result = createReservation(dataRef.current, input)
        // 保存できて初めて「予約完了」とする。容量不足などで保存できないのに
        // 完了画面と予約番号だけ出す（＝再読み込みで消える）ことはしない（R4-2）
        const rev = nextRevision(revRef.current)
        if (!persistAll(result.data, rev)) {
          setPersistFailed(true)
          throw new Error(
            '端末への保存に失敗したため、予約を完了できませんでした。端末の空き容量を確認して、もう一度お試しください',
          )
        }
        revRef.current = rev
        setPersistFailed(false)
        dataRef.current = result.data
        setData(result.data)
        return result.reservation
      },
      cancel: async (reservationId) => {
        mutate((prev) => cancelReservation(prev, reservationId))
      },
      setCheckedIn: async (reservationId, value) => {
        mutate((prev) => setCheckedIn(prev, reservationId, value))
      },
      setPaid: async (reservationId, value) => {
        mutate((prev) => setPaid(prev, reservationId, value))
      },
      completeReception: async (reservationId) => {
        mutate((prev) =>
          setCheckedIn(setPaid(prev, reservationId, true), reservationId, true),
        )
      },
      toggleBlocked: async (seatId) => {
        mutate((prev) => toggleBlocked(prev, seatId))
      },
      setBlockedForSeats: async (seatIds, blocked) => {
        mutate((prev) => setBlockedForSeats(prev, seatIds, blocked))
      },
      saveSettings: async (perf, bookingDeadline) => {
        const ok = mutate((prev) => ({ ...updatePerformance(prev, perf), bookingDeadline }))
        // 設定保存は実際の保存成否を呼び出し側へ返す。失敗したのに
        // 「保存しました」と出さないため（R5-2）
        if (!ok) {
          throw new Error(
            '端末への保存に失敗しました。空き容量を確認して、もう一度お試しください',
          )
        }
      },
      lookupReservation: async (code, phone) => {
        refreshIfStale()
        return findReservationByCodePhone(dataRef.current, code, phone)
      },
      selfCancelReservation: async (code, phone) => {
        refreshIfStale()
        const target = findReservationByCodePhone(dataRef.current, code, phone)
        const result = selfCancelEligibility(target, dataRef.current)
        if (result === 'OK' && target) {
          mutate((prev) => cancelReservation(prev, target.id))
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
      resetAll: () => {
        mutate(() => emptyData())
      },
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
