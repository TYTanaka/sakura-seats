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
  subscribeSeatChanges: (onChange: () => void) => () => void
}

export function CloudStoreProvider({ children }: { children: ReactNode }) {
  const [data, setData] = useState<AppData>(emptyData)
  const [ready, setReady] = useState(false)
  const [loadError, setLoadError] = useState<string | null>(null)
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

  /** Realtime 購読からの再取得は間引く（連続変更で RPC を叩きすぎない） */
  const scheduleRefresh = useCallback(() => {
    if (refreshTimerRef.current) return
    refreshTimerRef.current = setTimeout(() => {
      refreshTimerRef.current = null
      void refreshAll().catch(() => undefined)
    }, 400)
  }, [refreshAll])

  const load = useCallback(async () => {
    setLoadError(null)
    try {
      if (!bundleRef.current) {
        bundleRef.current = await createCloudApi()
        bundleRef.current.subscribeSeatChanges(scheduleRefresh)
      }
      await refreshPublic()
      setReady(true)
    } catch {
      setLoadError(
        'サーバへ接続できませんでした。電波の良い場所で再読み込みしてください（クラウド機能の準備中の場合もあります）。',
      )
    }
  }, [refreshPublic, scheduleRefresh])

  useEffect(() => {
    void load()
  }, [load])

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
      reserve: async (input) => {
        try {
          if (input.source === 'door') {
            const res = await api().staffSell(
              staffPasscode(),
              input.name,
              input.seats.map((s) => ({ seatId: s.seatId, typeId: s.typeId })),
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
          void refreshPublic().catch(() => undefined)
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
  }, [data, ready, loadError, load, refreshAll, refreshPublic, refreshStaff])

  return <StoreContext.Provider value={store}>{children}</StoreContext.Provider>
}
