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
import { currentSiteUrl } from './share'
import { StoreContext, type CheckInOutcome, type Store } from './store'

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
  /** Googleログイン中のメールアドレス（R8。セッションがあれば入る） */
  const [staffEmail, setStaffEmail] = useState<string | null>(null)
  const bundleRef = useRef<CloudBundle | null>(null)
  /**
   * スタッフ資格情報。null = 未入室。
   * Google入室のときは ''（空文字）を番兵にする: RPC には p_passcode='' で渡り、
   * サーバ側 sakura_check_passcode が JWT の許可リストで認可する（R8）。
   */
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
    // Google入室時は '' が入っている（falsy だが有効な資格情報）ため null で判定する
    if (!bundle || passcode === null) return
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
    if (passcodeRef.current !== null) await refreshStaff()
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

  /** クラウド接続一式を一度だけ作る（load と Google 入室の双方から使う） */
  const ensureBundle = useCallback(async (): Promise<CloudBundle> => {
    if (!bundleRef.current) {
      bundleRef.current = await createCloudApi()
      bundleRef.current.subscribeSeatChanges(scheduleRefresh, handleSubscriptionStatus)
      // Googleセッションの変化を追随する（R8）: ログイン中メールを保持し、
      // セッションが切れたら Google 入室の資格情報（''）も破棄する
      bundleRef.current.api.onSignedInEmailChange((email) => {
        setStaffEmail(email)
        if (!email && passcodeRef.current === '') passcodeRef.current = null
      })
      void bundleRef.current.api
        .getSignedInEmail()
        .then((email) => setStaffEmail(email))
        .catch(() => undefined)
    }
    return bundleRef.current
  }, [scheduleRefresh, handleSubscriptionStatus])

  const load = useCallback(async () => {
    setLoadError(null)
    try {
      await ensureBundle()
      await refreshPublic()
      setReady(true)
    } catch {
      setLoadError(
        'サーバへ接続できませんでした。電波の良い場所で再読み込みしてください（クラウド機能の準備中の場合もあります）。',
      )
    }
  }, [ensureBundle, refreshPublic])

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
      // Google入室時は ''（サーバが JWT で認可する）。未入室は null のみ
      if (p === null) throw new Error('スタッフ入室が必要です')
      return p
    }
    /** RPC の結果（予約番号・サーバ計算金額）から表示用 Reservation を組み立てる */
    const buildReservation = (
      input: NewReservationInput,
      code: string,
      amount: number,
      token?: string,
    ): Reservation => {
      // ローカルの純粋関数で明細スナップショット等の形を揃える（金額はサーバ値で上書き）
      const scratch: AppData = {
        ...emptyData(),
        performance: dataRef.current.performance,
        seatStates: {},
      }
      const { reservation } = createReservation(scratch, input)
      // QRトークンはサーバ発行が正。未適用の DB で返らなかった場合は
      // ローカル生成値を持たせず、QR を出さない（番号表示に落とす）
      return { ...reservation, id: code, amount, qrToken: token }
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
            const reservation = buildReservation(input, res.code, res.amount, res.token)
            await refreshAll()
            return reservation
          }
          const res = await api().bookSeats({
            name: input.name,
            phone: input.phone,
            note: input.note,
            items: input.seats.map((s) => ({ seatId: s.seatId, typeId: s.typeId })),
          })
          const reservation = buildReservation(input, res.code, res.amount, res.token)
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
      checkInByToken: async (token): Promise<CheckInOutcome> => {
        try {
          const outcome = await api().staffCheckIn(staffPasscode(), token)
          // 受付状態が変わる（または既に変わっていた）ためスタッフデータを最新化する
          await refreshStaff()
          return outcome
        } catch (e) {
          // R7 の RPC が未適用の間は「サーバ更新待ち」として返す（行き止まりにしない）
          if (e instanceof Error && e.message.includes('migration_sakura_r7')) {
            return { result: 'SERVER_PENDING', reservation: null, checkedInAt: null }
          }
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
          // R9: 先に staff_login で失敗回数の記録とロック判定を行う
          // （サーバ側スロットルの数える場所はここだけ）。
          // false（間違い or ロック中）なら入室失敗として即座に返す。
          // null（R9 未適用の DB 等）は判定を従来の staffGetAll に委ねる。
          const login = await api().staffLogin(candidate)
          if (login === false) return false
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
      staffSessionEmail: staffEmail,
      tryGoogleUnlock: async () => {
        try {
          const bundle = await ensureBundle()
          const email = await bundle.api.getSignedInEmail()
          if (!email) return false
          // 許可リスト照合はサーバ側（staff_whoami）。R8 未適用の DB では
          // ここで例外になるため、静かに false を返してパスコード入室に落とす
          const who = await bundle.api.staffWhoami()
          if (!who.ok) return false
          const staff = await bundle.api.staffGetAll('')
          passcodeRef.current = ''
          setStaffEmail(who.email ?? email)
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
      signInWithGoogle: async () => {
        const bundle = await ensureBundle()
        // 戻り先は今いるアプリのURLそのもの（配信先が変わっても追随する）
        await bundle.api.signInWithGoogle(currentSiteUrl())
      },
      staffSignOut: async () => {
        try {
          const bundle = await ensureBundle()
          await bundle.api.signOutGoogle()
        } catch {
          // ログアウト失敗でも端末側の資格情報は破棄する
        }
        if (passcodeRef.current === '') passcodeRef.current = null
        setStaffEmail(null)
      },
      staffAllowlist: async () => api().staffAllowlistList(staffPasscode()),
      staffAllowlistAdd: async (email, note) =>
        api().staffAllowlistAdd(staffPasscode(), email, note),
      staffAllowlistRemove: async (email) =>
        api().staffAllowlistRemove(staffPasscode(), email),
      staffSetPasscodeLogin: async (enabled) =>
        api().staffSetPasscodeLogin(staffPasscode(), enabled),
      changePasscode: async (newPasscode) => {
        await api().staffChangePasscode(staffPasscode(), newPasscode)
        passcodeRef.current = newPasscode
      },
      resetAll: () => undefined,
    }
  }, [
    data,
    ready,
    loadError,
    load,
    refreshAll,
    refreshStaff,
    refreshWithRetry,
    syncState,
    staffEmail,
    ensureBundle,
  ])

  return <StoreContext.Provider value={store}>{children}</StoreContext.Provider>
}
