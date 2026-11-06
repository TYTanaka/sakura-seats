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
  assignSeatsToReservation,
  cancelReservation,
  checkInByToken as applyCheckInByToken,
  clearReservationSeats,
  createReservation,
  createWaitlistEntry,
  createZoneReservation,
  emptyData,
  findReservationByCodePhone,
  isUnassignedZoneBooking,
  isValidPhone,
  isZoneBooking,
  normalizeAppData,
  normalizePhone,
  removeWaitlistEntry,
  selfCancelEligibility,
  setBlockedForSeats,
  setCheckedIn,
  setPaid,
  setRefunded,
  toggleBlocked,
  uncancelReservation as applyUncancelReservation,
  updatePerformance,
  type AccessNeed,
  type AppData,
  type CheckInResult,
  type NewReservationInput,
  type Performance,
  type Reservation,
  type SelfCancelResult,
  type UncancelResult,
  type WaitlistEntry,
} from './logic'
import {
  manualAssignmentError,
  planListCheckIn,
  planReservationAssignment,
  zoneAvailability,
  zoneUncancelBlock,
  type ZoneId,
} from './zones'
// 注: 席の割当計画は R38 から planReservationAssignment（希望込み）に統一した
import { getCurrentOperator } from './operator'
import { cloudEnabled } from './config'
import { isStaleRevision, nextRevision, parseRevision } from './revision'
import type { StaffAllowlist } from './staffAuth'

/**
 * ストアの共通インターフェース。
 * - ローカルモード（環境変数なし）: localStorage に保存する従来動作
 * - クラウドモード（VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY あり）:
 *   Supabase RPC 経由で全端末同期する（実装は cloudStore.tsx を動的 import）
 * 操作はどちらも Promise を返す形に統一し、画面側は await して使う。
 */

/**
 * QR受付（checkInByToken）の結果。
 * result は logic の CheckInResult と同一の分類に、クラウドで RPC 自体が
 * 未適用だった場合の 'SERVER_PENDING' を加えたもの。
 */
export interface CheckInOutcome {
  result: CheckInResult | 'SERVER_PENDING'
  /** 予約が特定できた場合の表示用予約（NOT_FOUND / SERVER_PENDING では null） */
  reservation: Reservation | null
  /** 受付日時 ISO（OK / ALREADY_CHECKED_IN のとき） */
  checkedInAt: string | null
}

/**
 * ゾーン予約の申込入力（R12）。
 * お客様は席を選ばない: ゾーンと人数（券種の並び）だけを申し込み、
 * 実際の席は支払い時に割り当てる。
 */
export interface ZoneBookingInput {
  zone: ZoneId
  /** 人数分の券種ID（1人目から順に） */
  typeIds: string[]
  name: string
  phone: string
  note: string
  /** 座席の希望（R38・車椅子席/親子室） */
  accessNeeds?: AccessNeed[]
}

/** キャンセル待ち登録の入力（R38） */
export interface WaitlistInput {
  /** 希望ゾーン。null は「どこでもよい」 */
  zone: ZoneId | null
  partySize: number
  name: string
  phone: string
}

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
  /**
   * ゾーン予約を申し込む（R12）。席は割り当てない。
   * クラウド: book_zone RPC が収容判定（カウントホールド）まで原子的に行う。
   * ローカル: zoneAvailability で残席を確認してから作成する。
   * 満席の場合は「満席」を含む文面の例外を投げる。
   */
  reserveZone: (input: ZoneBookingInput) => Promise<Reservation>
  cancel: (reservationId: string) => Promise<void>
  /**
   * キャンセルの取り消し（スタッフ操作）。結果コードを返す。
   * クラウド: staff_uncancel_reservation RPC が判定する（未適用の環境では
   * 分かりやすいエラーを投げる）。
   * ローカル: uncancelReservation（logic）と同じ規則で判定する。
   */
  uncancelReservation: (reservationId: string) => Promise<UncancelResult>
  setCheckedIn: (reservationId: string, value: boolean) => Promise<void>
  /**
   * QR受付: トークンを検証して受付する（R7）。
   * クラウド: staff_check_in RPC がサーバ検証する（未適用なら SERVER_PENDING）。
   * ローカル: checkInByToken（logic）と同じ規則で端末内検証する。
   * R17: ゾーン予約で席が未割当なら、受付と同時にゾーン内で席を割り当てる
   * （支払い状態は変えない）。席を用意できない場合は受付せず例外を投げる。
   */
  checkInByToken: (token: string) => Promise<CheckInOutcome>
  setPaid: (reservationId: string, value: boolean) => Promise<void>
  /**
   * ゾーン予約に席を手で割り当てる（R25・ラウンド10 S-1）。
   * 支払い・来場の状態は変えず、席だけを確定する。対象は未割当の
   * ゾーン予約のみで、検証（ゾーン内・空席・人数一致）は
   * zones.manualAssignmentError と同一基準（クラウドではサーバの
   * staff_assign_seats RPC が再検証する）。問題があれば理由を例外で投げる。
   */
  assignSeats: (reservationId: string, seatIds: string[]) => Promise<void>
  /** 受付完了ワンタップ: 支払い済み＋来場済みを一度に設定する */
  completeReception: (reservationId: string) => Promise<void>
  /**
   * 返金済みの記録（R38・公演中止時の返金管理）。
   * ローカル: setRefunded（logic）で記録する。
   * クラウド: staff_update_reservation の p_refunded で記録する。
   */
  setRefunded: (reservationId: string, value: boolean) => Promise<void>
  /**
   * キャンセル待ちを登録する（R38）。電話番号は正規化して保存する。
   * クラウド: add_waitlist RPC が検証（電話形式・同一電話の上限）まで行う。
   * ローカル: 同じ規則で検証してから端末内に記録する。
   */
  joinWaitlist: (input: WaitlistInput) => Promise<WaitlistEntry>
  /** キャンセル待ちを取り下げる（スタッフ操作。連絡済み・不要分） */
  removeWaitlist: (entryId: string) => Promise<void>
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
  /* ---------------- R8: Googleログイン（クラウドモードのみ） ---------------- */
  /**
   * Googleログイン中のメールアドレス（セッションがある場合）。
   * スタッフ許可リストに載っているかは別（tryGoogleUnlock / whoami で判定）。
   * ローカルモードでは常に null。
   */
  staffSessionEmail: string | null
  /**
   * Googleセッション + 許可リスト照合でスタッフ入室を試す。
   * 成功したらスタッフデータも読み込んで true。クラウド以外では false。
   */
  tryGoogleUnlock: () => Promise<boolean>
  /** Googleログインを開始する（ブラウザが Google へ遷移する）。クラウドのみ */
  signInWithGoogle: () => Promise<void>
  /** Googleからログアウトし、スタッフ資格情報も破棄する。クラウドのみ */
  staffSignOut: () => Promise<void>
  /** スタッフ許可リストの取得（クラウドのみ。要スタッフ入室） */
  staffAllowlist: () => Promise<StaffAllowlist>
  staffAllowlistAdd: (email: string, note: string) => Promise<StaffAllowlist>
  staffAllowlistRemove: (email: string) => Promise<StaffAllowlist>
  /** パスコードログインの切替（クラウドのみ。サーバ側で Google 許可スタッフに限定） */
  staffSetPasscodeLogin: (enabled: boolean) => Promise<StaffAllowlist>
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
      reserveZone: async (input) => {
        refreshIfStale()
        // 収容判定: ゾーンの残席（未割当ホールド差し引き後）が人数未満なら満席
        const avail = zoneAvailability(dataRef.current, input.zone)
        if (avail.available < input.typeIds.length) {
          throw new Error('このゾーンは満席です。他のゾーンをお選びください')
        }
        const result = createZoneReservation(dataRef.current, {
          zone: input.zone,
          typeIds: input.typeIds,
          name: input.name,
          phone: input.phone,
          note: input.note,
          accessNeeds: input.accessNeeds,
        })
        // reserve と同じく、保存できて初めて「予約完了」とする
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
      uncancelReservation: async (reservationId) => {
        // 他タブの更新を取り込んでから判定し直す（席の占有は最新状態で見る）
        refreshIfStale()
        const target = dataRef.current.reservations.find((r) => r.id === reservationId)
        if (!target) return 'NOT_FOUND' as UncancelResult
        if (!target.cancelled) return 'NOT_CANCELLED' as UncancelResult
        // R38（M1）: 未割当のゾーン予約は、復活で増えるホールドがゾーンの
        // 残席を超えるならオーバーセルになるため拒否する
        if (zoneUncancelBlock(dataRef.current, target) === 'ZONE_FULL') {
          return 'ZONE_FULL' as UncancelResult
        }
        const { data: next, result } = applyUncancelReservation(dataRef.current, reservationId)
        if (result === 'OK') commit(next)
        return result
      },
      setCheckedIn: async (reservationId, value) => {
        // R34（ラウンド13・R13-1）: 一覧からの来場チェックインも QR 受付と
        // 揃え、未割当のゾーン予約は席を詰めてから来場にする。席を用意
        // できない場合は例外にして、来場済みにはしない（理由はトーストで
        // スタッフに伝わり、手動指定へ誘導する）
        const target = dataRef.current.reservations.find((r) => r.id === reservationId)
        if (value && target && !target.cancelled) {
          const plan = planListCheckIn(dataRef.current, target)
          if (plan.kind === 'blocked') throw new Error(plan.reason)
          if (plan.kind === 'assign') {
            mutate((prev) =>
              setCheckedIn(
                assignSeatsToReservation(prev, reservationId, plan.seatIds),
                reservationId,
                true,
                getCurrentOperator(),
              ),
            )
            return
          }
        }
        mutate((prev) => setCheckedIn(prev, reservationId, value, getCurrentOperator()))
      },
      checkInByToken: async (token) => {
        // 他タブの更新を取り込んでから判定し直す（二重受付の防止）
        refreshIfStale()
        const { data: next, result, reservation } = applyCheckInByToken(
          dataRef.current,
          token,
          new Date(),
          getCurrentOperator(),
        )
        if (result !== 'OK') {
          return {
            result,
            reservation,
            checkedInAt: reservation?.checkedInAt ?? null,
          }
        }
        // R17: ゾーン予約で席が未割当なら、受付と同時に席を決める
        // （支払い時と同じ詰め方。支払い状態は触らない）。
        // 席を用意できない場合は受付を取り消して（commit しない）例外にする
        if (reservation && isUnassignedZoneBooking(reservation)) {
          // R38: 希望がある予約は専用席（車椅子席・親子室）も含めて割り当てる
          const seatIds = planReservationAssignment(next, reservation)
          if (!seatIds) {
            throw new Error(
              '席を自動で割り当てできませんでした（このゾーンに空席が足りません）。受付一覧から席を確認して、手動で受付してください',
            )
          }
          const withSeats = assignSeatsToReservation(next, reservation.id, seatIds)
          commit(withSeats)
          const updated =
            withSeats.reservations.find((r) => r.id === reservation.id) ?? null
          return {
            result,
            reservation: updated,
            checkedInAt: updated?.checkedInAt ?? null,
          }
        }
        commit(next)
        return {
          result,
          reservation,
          checkedInAt: reservation?.checkedInAt ?? null,
        }
      },
      setPaid: async (reservationId, value) => {
        refreshIfStale()
        const target = dataRef.current.reservations.find((r) => r.id === reservationId)
        // R12: ゾーン予約の支払い = 席の確定。ゾーン内の空席から詰めて
        // 割り当ててから支払い済みにする。割り当てられなければ例外にし、
        // 支払い済みにはしない（スタッフに理由が伝わる）
        if (target && isUnassignedZoneBooking(target) && value && !target.cancelled) {
          // R38: 希望がある予約は専用席を先に割り当てる
          const seatIds = planReservationAssignment(dataRef.current, target)
          if (!seatIds) {
            throw new Error(
              'このゾーンに割り当てられる席がありません（空席が不足しています）。支払い済みにはしませんでした',
            )
          }
          mutate((prev) =>
            setPaid(
              assignSeatsToReservation(prev, reservationId, seatIds),
              reservationId,
              true,
              getCurrentOperator(),
            ),
          )
          return
        }
        // R12: ゾーン予約を未払いに戻すと、割り当てた席も解放する
        // R21（ラウンド8・S-2）: ただし来場済みの予約は席を解放しない。
        // お客様が座っている可能性がある席の押さえを消すと二重割当になる。
        // 席は保持したまま支払いだけ戻す（席の状態は paid=false により
        // 「予約済み」に戻る）。解放は来場を取り消してから行う
        if (
          target &&
          isZoneBooking(target) &&
          !value &&
          target.paid &&
          target.seatIds.length > 0
        ) {
          if (target.checkedIn) {
            mutate((prev) => setPaid(prev, reservationId, false, getCurrentOperator()))
            return
          }
          mutate((prev) =>
            setPaid(
              clearReservationSeats(prev, reservationId),
              reservationId,
              false,
              getCurrentOperator(),
            ),
          )
          return
        }
        mutate((prev) => setPaid(prev, reservationId, value, getCurrentOperator()))
      },
      assignSeats: async (reservationId, seatIds) => {
        // R25: 席の手動指定。支払い・来場には触らず席だけを確定する。
        // 検証は manualAssignmentError（サーバ RPC と同一基準）で行い、
        // 問題があれば理由を投げて何も変えない
        refreshIfStale()
        const target = dataRef.current.reservations.find((r) => r.id === reservationId)
        if (!target) throw new Error('予約が見つかりません')
        const problem = manualAssignmentError(dataRef.current, target, seatIds)
        if (problem) throw new Error(problem)
        mutate((prev) => assignSeatsToReservation(prev, reservationId, seatIds))
      },
      completeReception: async (reservationId) => {
        refreshIfStale()
        const target = dataRef.current.reservations.find((r) => r.id === reservationId)
        // R12: 未割当のゾーン予約の受付完了は、席の割当＋支払い＋来場を一度に行う
        if (target && isUnassignedZoneBooking(target) && !target.cancelled) {
          // R38: 希望がある予約は専用席を先に割り当てる
          const seatIds = planReservationAssignment(dataRef.current, target)
          if (!seatIds) {
            throw new Error(
              'このゾーンに割り当てられる席がありません（空席が不足しています）。受付完了にはしませんでした',
            )
          }
          mutate((prev) =>
            setCheckedIn(
              setPaid(
                assignSeatsToReservation(prev, reservationId, seatIds),
                reservationId,
                true,
                getCurrentOperator(),
              ),
              reservationId,
              true,
              getCurrentOperator(),
            ),
          )
          return
        }
        mutate((prev) =>
          setCheckedIn(
            setPaid(prev, reservationId, true, getCurrentOperator()),
            reservationId,
            true,
            getCurrentOperator(),
          ),
        )
      },
      // R38: 返金済みの記録（公演中止時の返金管理）
      setRefunded: async (reservationId, value) => {
        mutate((prev) => setRefunded(prev, reservationId, value))
      },
      // R38: キャンセル待ち登録（ローカル）。クラウドと同じ規則で検証する
      joinWaitlist: async (input) => {
        refreshIfStale()
        const phone = normalizePhone(input.phone)
        if (!isValidPhone(phone)) {
          throw new Error('電話番号の形式が正しくありません')
        }
        const samePhone = dataRef.current.waitlist.filter(
          (w) => w.phone === phone,
        ).length
        if (samePhone >= 3) {
          throw new Error('この電話番号でのキャンセル待ち登録は、すでにいくつかいただいています')
        }
        const result = createWaitlistEntry(dataRef.current, {
          zone: input.zone,
          partySize: input.partySize,
          name: input.name,
          phone,
        })
        mutate(() => result.data)
        return result.entry
      },
      removeWaitlist: async (entryId) => {
        mutate((prev) => removeWaitlistEntry(prev, entryId))
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
      // ローカルモードには Google ログインも許可リストも無い（画面側も出さない）
      staffSessionEmail: null,
      tryGoogleUnlock: async () => false,
      signInWithGoogle: async () => {
        throw new Error('ローカルモードではGoogleログインは使えません')
      },
      staffSignOut: async () => undefined,
      staffAllowlist: async () => {
        throw new Error('許可リストはクラウドモード専用です')
      },
      staffAllowlistAdd: async () => {
        throw new Error('許可リストはクラウドモード専用です')
      },
      staffAllowlistRemove: async () => {
        throw new Error('許可リストはクラウドモード専用です')
      },
      staffSetPasscodeLogin: async () => {
        throw new Error('許可リストはクラウドモード専用です')
      },
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
