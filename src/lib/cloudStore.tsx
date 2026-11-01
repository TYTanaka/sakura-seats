import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import {
  createReservation,
  emptyData,
  normalizePhone,
  setBlockedForSeats as applyBlockedForSeats,
  toggleBlocked as applyToggleBlocked,
  type AppData,
  type NewReservationInput,
  type Reservation,
} from './logic'
import { createCloudApi, type CloudApi } from './cloud'
import { StoreContext, type Store } from './store'

/**
 * クラウドモードのストア（Supabase RPC）。
 * store.tsx から動的 import されるため、@supabase/supabase-js は
 * クラウドビルドの初期表示バンドルには含まれない。
 *
 * データの流れ:
 * - お客様画面: get_public_state（公演設定・販売しない席・締切・座席占有）を読む。
 *   seat_state の Realtime 変更で再取得する（間引きあり）。
 * - スタッフ: パスコードで staff_get_all（全予約を含む）を読む。
 *   以後の変更はすべて staff_* RPC 経由で、実行後に再取得する。
 * - 料金はサーバ側で再計算される。ここで作る Reservation は表示用の組み立てで、
 *   金額は RPC の返却値（サーバ計算）を正とする。
 */

interface CloudBundle {
  api: CloudApi
  subscribeSeatChanges: (
    onChange: () => void,
    onStatus?: (status: string) => void,
  ) => () => void
}

export function CloudStoreProvider({ children }: { children: ReactNode }) {
  const [data, setData] = useState<AppData>(emptyData)
  const [ready, setReady] = useState(false)
  const [loadError, setLoadError] = useState<string | null>(null)
  /** 接続状態（R4-3）: 'ok' 以外の間は「表示が古いかもしれない」ことを画面に出す */
  const [syncState, setSyncState] = useState<'ok' | 'reconnecting' | 'offline'>('ok')
  const bundleRef = useRef<CloudBundle | null>(null)
  const passcodeRef = useRef<string | null>(null)
  const refreshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const dataRef = useRef(data)
  dataRef.current = data

  const refreshPublic = useCallback(async () => {
    const bundle = bundleRef.current
    if (!bundle) return
    const pub = await bundle.api.getPublicState()
    setData((prev) => ({
      ...prev,
      performance: pub.performance,
      blocked: pub.blockedSeats,
      bookingDeadline: pub.bookingDeadline,
      seatStates: pub.seatStates,
    }))
  }, [])

  const refreshStaff = useCallback(async () => {
    const bundle = bundleRef.current
    const passcode = passcodeRef.current
    if (!bundle || !passcode) return
    const staff = await bundle.api.staffGetAll(passcode)
    setData((prev) => ({
      ...prev,
      performance: staff.performance,
      blocked: staff.blockedSeats,
      bookingDeadline: staff.bookingDeadline,
      reservations: staff.reservations,
    }))
  }, [])

  const refreshAll = useCallback(async () => {
    await refreshPublic()
    if (passcodeRef.current) await refreshStaff()
  }, [refreshPublic, refreshStaff])

  /**
   * 再取得をバックオフ付きで再試行する（R4-3）。
   * 失敗を握り潰さず、接続状態を画面側へ伝える。成功したら 'ok' に戻す。
   */
  const refreshWithRetry = useCallback(async (): Promise<boolean> => {
    const delaysMs = [0, 1000, 3000, 8000]
    for (const delay of delaysMs) {
      if (delay > 0) await new Promise((r) => setTimeout(r, delay))
      try {
        await refreshAll()
        setSyncState('ok')
        return true
      } catch {
        setSyncState(!navigator.onLine ? 'offline' : 'reconnecting')
      }
    }
    return false
  }, [refreshAll])

  /** Realtime 購読からの再取得は間引く（連続変更で RPC を叩きすぎない） */
  const scheduleRefresh = useCallback(() => {
    if (refreshTimerRef.current) return
    refreshTimerRef.current = setTimeout(() => {
      refreshTimerRef.current = null
      void refreshWithRetry()
    }, 400)
  }, [refreshWithRetry])

  /**
   * Realtime 購読の状態変化（R4-3）:
   * - SUBSCRIBED（初回・再接続の両方）: 切断中に取りこぼした変更を取り直す
   * - それ以外（CHANNEL_ERROR / TIMED_OUT / CLOSED）: 接続状態を悪化として伝える
   */
  const handleSubscriptionStatus = useCallback(
    (status: string) => {
      if (status === 'SUBSCRIBED') {
        void refreshWithRetry()
      } else {
        setSyncState(!navigator.onLine ? 'offline' : 'reconnecting')
      }
    },
    [refreshWithRetry],
  )

  const load = useCallback(async () => {
    setLoadError(null)
    try {
      if (!bundleRef.current) {
        bundleRef.current = await createCloudApi()
        bundleRef.current.subscribeSeatChanges(scheduleRefresh, handleSubscriptionStatus)
      }
      await refreshPublic()
      setReady(true)
    } catch {
      setLoadError(
        'サーバへ接続できませんでした。電波の良い場所で再読み込みしてください（クラウド機能の準備中の場合もあります）。',
      )
    }
  }, [refreshPublic, scheduleRefresh, handleSubscriptionStatus])

  useEffect(() => {
    void load()
  }, [load])

  // ブラウザのオンライン/オフラインにも追随する（オフライン表示・復帰時の再取得）
  useEffect(() => {
    const onOnline = () => {
      void refreshWithRetry()
    }
    const onOffline = () => setSyncState('offline')
    window.addEventListener('online', onOnline)
    window.addEventListener('offline', onOffline)
    return () => {
      window.removeEventListener('online', onOnline)
      window.removeEventListener('offline', onOffline)
    }
  }, [refreshWithRetry])

  const store = useMemo<Store>(() => {
    const api = (): CloudApi => {
      const bundle = bundleRef.current
      if (!bundle) throw new Error('クラウドへ接続できていません')
      return bundle.api
    }
    const staffPasscode = (): string => {
      const p = passcodeRef.current
      if (!p) throw new Error('スタッフ入室が必要です')
      return p
    }
    /** RPC の結果（予約番号・サーバ計算金額）から表示用 Reservation を組み立てる */
    const buildReservation = (
      input: NewReservationInput,
      code: string,
      amount: number,
    ): Reservation => {
      // ローカルの純粋関数で明細スナップショット等の形を揃える（金額はサーバ値で上書き）
      const scratch: AppData = {
        ...emptyData(),
        performance: dataRef.current.performance,
        seatStates: {},
      }
      const { reservation } = createReservation(scratch, input)
      return { ...reservation, id: code, amount }
    }

    return {
      data,
      mode: 'cloud',
      ready,
      loadError,
      retryLoad: () => void load(),
      storageWarning: null,
      syncState,
      reserve: async (input) => {
        try {
          if (input.source === 'door') {
            const res = await api().staffSell(
              staffPasscode(),
              input.name,
              input.seats.map((s) => ({ seatId: s.seatId, typeId: s.typeId })),
              input.seller,
            )
            const reservation = buildReservation(input, res.code, res.amount)
            await refreshAll()
            return reservation
          }
          const res = await api().bookSeats({
            name: input.name,
            phone: input.phone,
            note: input.note,
            items: input.seats.map((s) => ({ seatId: s.seatId, typeId: s.typeId })),
          })
          const reservation = buildReservation(input, res.code, res.amount)
          await refreshAll()
          return reservation
        } catch (e) {
          // 失敗時は最新の占有状態を取り直してからエラーを返す
          void refreshWithRetry()
          throw e
        }
      },
      cancel: async (reservationId) => {
        const target = dataRef.current.reservations.find((r) => r.id === reservationId)
        if (!target?.cloudId) throw new Error('予約が見つかりません')
        await api().staffUpdateReservation(staffPasscode(), target.cloudId, {
          paid: target.paid,
          checkedIn: target.checkedIn,
          status: 'cancelled',
        })
        await refreshAll()
      },
      uncancelReservation: async (reservationId) => {
        const target = dataRef.current.reservations.find((r) => r.id === reservationId)
        if (!target) return 'NOT_FOUND'
        try {
          const result = await api().staffUncancelReservation(staffPasscode(), target.id)
          // 成功・失敗どちらの場合も最新の占有状態を取り直す
          await refreshAll()
          return result
        } catch (e) {
          void refreshWithRetry()
          throw e
        }
      },
      setCheckedIn: async (reservationId, value) => {
        const target = dataRef.current.reservations.find((r) => r.id === reservationId)
        if (!target?.cloudId) throw new Error('予約が見つかりません')
        await api().staffUpdateReservation(staffPasscode(), target.cloudId, {
          paid: target.paid,
          checkedIn: value,
          status: target.cancelled ? 'cancelled' : 'active',
        })
        await refreshStaff()
      },
      setPaid: async (reservationId, value) => {
        const target = dataRef.current.reservations.find((r) => r.id === reservationId)
        if (!target?.cloudId) throw new Error('予約が見つかりません')
        await api().staffUpdateReservation(staffPasscode(), target.cloudId, {
          paid: value,
          checkedIn: target.checkedIn,
          status: target.cancelled ? 'cancelled' : 'active',
        })
        await refreshStaff()
      },
      toggleBlocked: async (seatId) => {
        const next = applyToggleBlocked(dataRef.current, seatId)
        if (next === dataRef.current) return
        await api().staffSaveConfig(
          staffPasscode(),
          next.performance,
          next.blocked,
          next.bookingDeadline,
        )
        await refreshAll()
      },
      setBlockedForSeats: async (seatIds, blocked) => {
        const next = applyBlockedForSeats(dataRef.current, seatIds, blocked)
        await api().staffSaveConfig(
          staffPasscode(),
          next.performance,
          next.blocked,
          next.bookingDeadline,
        )
        await refreshAll()
      },
      saveSettings: async (perf, bookingDeadline) => {
        await api().staffSaveConfig(
          staffPasscode(),
          perf,
          dataRef.current.blocked,
          bookingDeadline,
        )
        await refreshAll()
      },
      completeReception: async (reservationId) => {
        const target = dataRef.current.reservations.find((r) => r.id === reservationId)
        if (!target?.cloudId) throw new Error('予約が見つかりません')
        // staff_update_reservation は支払い・来場を同時に設定できるので1回の呼び出しで完結する
        await api().staffUpdateReservation(staffPasscode(), target.cloudId, {
          paid: true,
          checkedIn: true,
          status: target.cancelled ? 'cancelled' : 'active',
        })
        await refreshStaff()
      },
      lookupReservation: async (code, phone) =>
        api().lookupReservation(code.trim().toUpperCase(), normalizePhone(phone)),
      selfCancelReservation: async (code, phone) => {
        // 判定はサーバ（cancel_reservation RPC）が行う。電話は正規化して渡す
        const result = await api().cancelReservation(
          code.trim().toUpperCase(),
          normalizePhone(phone),
        )
        if (result === 'OK' || result === 'ALREADY_CANCELLED') {
          // 席の解放・スタッフ一覧へ反映するため取り直す
          void refreshWithRetry()
        }
        return result
      },
      staffUnlock: async (candidate) => {
        try {
          const staff = await api().staffGetAll(candidate)
          passcodeRef.current = candidate
          setData((prev) => ({
            ...prev,
            performance: staff.performance,
            blocked: staff.blockedSeats,
            bookingDeadline: staff.bookingDeadline,
            reservations: staff.reservations,
          }))
          return true
        } catch {
          return false
        }
      },
      changePasscode: async (newPasscode) => {
        await api().staffChangePasscode(staffPasscode(), newPasscode)
        passcodeRef.current = newPasscode
      },
      resetAll: () => undefined,
    }
  }, [data, ready, loadError, load, refreshAll, refreshStaff, refreshWithRetry, syncState])

  return <StoreContext.Provider value={store}>{children}</StoreContext.Provider>
}
