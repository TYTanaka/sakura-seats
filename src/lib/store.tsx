import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'
import {
  cancelReservation,
  createReservation,
  emptyData,
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

/**
 * 試作版のストア。データはこの端末の localStorage にのみ保存される
 * （複数端末の同期は本番フェーズで Supabase に差し替え予定）。
 * 公演は1回のみのため、公演は単一の設定オブジェクトとして保持する。
 * ロジック自体は lib/logic.ts の純粋関数に委譲し、ここは保持と配線だけを行う。
 */

const STORAGE_KEY = 'sakura-seats-v1'

function loadData(): AppData {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return emptyData()
    const parsed = JSON.parse(raw) as Partial<AppData>
    if (!parsed.performance || !Array.isArray(parsed.reservations)) return emptyData()
    // 旧データ移行: 金額（amount）を持たない予約には 単価×席数 を補完する
    const price = parsed.performance.price
    const reservations = parsed.reservations.map((r) => ({
      ...r,
      amount:
        typeof r.amount === 'number' && Number.isFinite(r.amount)
          ? r.amount
          : r.seatIds.length * price,
    }))
    return {
      performance: parsed.performance,
      reservations,
      blocked: Array.isArray(parsed.blocked) ? parsed.blocked : [],
      seq: typeof parsed.seq === 'number' ? parsed.seq : parsed.reservations.length,
    }
  } catch {
    return emptyData()
  }
}

export interface Store {
  data: AppData
  reserve: (input: NewReservationInput) => Reservation
  cancel: (reservationId: string) => void
  setCheckedIn: (reservationId: string, value: boolean) => void
  setPaid: (reservationId: string, value: boolean) => void
  toggleBlocked: (seatId: string) => void
  setBlockedForSeats: (seatIds: string[], blocked: boolean) => void
  updatePerformance: (perf: Performance) => void
  resetAll: () => void
}

const StoreContext = createContext<Store | null>(null)

export function StoreProvider({ children }: { children: ReactNode }) {
  const [data, setData] = useState<AppData>(loadData)

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(data))
    } catch {
      // 保存に失敗しても画面操作は継続する（試作版）
    }
  }, [data])

  const store = useMemo<Store>(
    () => ({
      data,
      reserve: (input) => {
        const result = createReservation(data, input)
        setData(result.data)
        return result.reservation
      },
      cancel: (reservationId) => setData((prev) => cancelReservation(prev, reservationId)),
      setCheckedIn: (reservationId, value) =>
        setData((prev) => setCheckedIn(prev, reservationId, value)),
      setPaid: (reservationId, value) => setData((prev) => setPaid(prev, reservationId, value)),
      toggleBlocked: (seatId) => setData((prev) => toggleBlocked(prev, seatId)),
      setBlockedForSeats: (seatIds, blocked) =>
        setData((prev) => setBlockedForSeats(prev, seatIds, blocked)),
      updatePerformance: (perf) => setData((prev) => updatePerformance(prev, perf)),
      resetAll: () => setData(emptyData()),
    }),
    [data],
  )

  return <StoreContext.Provider value={store}>{children}</StoreContext.Provider>
}

export function useStore(): Store {
  const store = useContext(StoreContext)
  if (!store) throw new Error('useStore は StoreProvider の中で使ってください')
  return store
}
