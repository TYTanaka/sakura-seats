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
  findTicketType,
  isUnassignedZoneBooking,
  isZoneBooking,
  normalizePhone,
  setBlockedForSeats as applyBlockedForSeats,
  toggleBlocked as applyToggleBlocked,
  type AppData,
  type NewReservationInput,
  type Reservation,
} from './logic'
import { assignZoneSeats, type ZoneId } from './zones'
import { createCloudApi, type CloudApi } from './cloud'
import { currentSiteUrl } from './share'
import {
  StoreContext,
  type CheckInOutcome,
  type Store,
  type ZoneBookingInput,
} from './store'

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
      // R12: ゾーン別の未割当ホールド集計（残席計算に使う）
      zoneHolds: pub.zoneHolds,
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
    /** ゾーン予約の RPC 結果から表示用 Reservation を組み立てる（席は未確定） */
    const buildZoneReservation = (
      input: ZoneBookingInput,
      code: string,
      amount: number,
      token?: string,
    ): Reservation => {
      const perf = dataRef.current.performance
      return {
        id: code,
        seatIds: [],
        items: input.typeIds.map((typeId) => {
          const type = findTicketType(perf, typeId)
          return {
            seatId: '',
            typeId,
            typeName: type?.name ?? '',
            price: type?.price ?? 0,
          }
        }),
        name: input.name.trim(),
        phone: input.phone.trim(),
        note: input.note.trim(),
        source: 'online',
        amount,
        checkedIn: false,
        paid: false,
        cancelled: false,
        createdAt: new Date().toISOString(),
        qrToken: token,
        perfDate: perf.date,
        perfName: perf.name,
        zone: input.zone,
      }
    }

    /**
     * R17: QR受付で「席が必要」と返ったときの2段階目の処理。
     * 最新の占有状態を取り直し、支払い時と同じ詰め方（assignZoneSeats）で
     * ゾーン内に席を選んで、席付きでもう一度 staff_check_in を呼ぶ。
     * 席が他の受付と重なったら（SEAT_TAKEN）取り直して最大2回まで再試行する。
     * どうしても席を用意できない場合は、受付せずに理由を例外で伝える。
     */
    const checkInAssigningSeats = async (
      token: string,
      summary: Reservation | null,
    ): Promise<Awaited<ReturnType<CloudApi['staffCheckIn']>>> => {
      const zone = summary?.zone
      const partySize = summary?.items.length ?? 0
      if (!zone || partySize === 0) {
        throw new Error(
          '席を自動で割り当てできませんでした。受付一覧から席を確認して、手動で受付してください',
        )
      }
      for (let attempt = 0; attempt <= 2; attempt++) {
        await refreshAll()
        const assignment = assignZoneSeats(
          dataRef.current,
          zone as ZoneId,
          partySize,
        )
        if (!assignment) {
          throw new Error(
            '席を自動で割り当てできませんでした（このゾーンに空席が足りません）。受付一覧から席を確認して、手動で受付してください',
          )
        }
        const outcome = await api().staffCheckIn(
          staffPasscode(),
          token,
          assignment.seatIds,
        )
        if (outcome.result === 'SEAT_TAKEN') {
          if (attempt < 2) continue
          throw new Error(
            '席が他の受付と重なってしまいました。もう一度QRコードを読み取ってください',
          )
        }
        if (outcome.result === 'SEAT_INVALID' || outcome.result === 'NEEDS_SEATS') {
          throw new Error(
            '席を自動で割り当てできませんでした。受付一覧から席を確認して、手動で受付してください',
          )
        }
        return outcome
      }
      // ループは必ず return / throw するが、型のために到達不能な例外を置く
      throw new Error(
        '席を自動で割り当てできませんでした。受付一覧から席を確認して、手動で受付してください',
      )
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
      reserveZone: async (input) => {
        try {
          const res = await api().bookZone({
            name: input.name,
            phone: input.phone,
            note: input.note,
            zone: input.zone,
            typeIds: input.typeIds,
          })
          const reservation = buildZoneReservation(input, res.code, res.amount, res.token)
          await refreshAll()
          return reservation
        } catch (e) {
          // 失敗時（満席など）は最新の残席を取り直してからエラーを返す
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
          // R17: まず席なしで照合する。未割当のゾーン予約なら NEEDS_SEATS が
          // 返るので、席を詰めてから再送し、割当と受付を原子的に行う
          let outcome = await api().staffCheckIn(staffPasscode(), token, null)
          if (outcome.result === 'NEEDS_SEATS') {
            outcome = await checkInAssigningSeats(token, outcome.reservation)
          }
          // 受付状態が変わる（または既に変わっていた）ためスタッフデータを最新化する
          await refreshStaff()
          return {
            result: outcome.result as CheckInOutcome['result'],
            reservation: outcome.reservation,
            checkedInAt: outcome.checkedInAt,
          }
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
        // R12: ゾーン予約の支払い = 席の確定。ゾーン内の現在の空席から
        // 詰めて割り当て、サーバ側で再検証して原子的に確定する。
        // 割り当て・検証に失敗したら例外にし、支払い済みにはしない。
        if (
          isUnassignedZoneBooking(target) &&
          value &&
          !target.cancelled
        ) {
          const assignment = assignZoneSeats(
            dataRef.current,
            target.zone as ZoneId,
            target.items.length,
          )
          if (!assignment) {
            throw new Error(
              'このゾーンに割り当てられる席がありません（空席が不足しています）。支払い済みにはしませんでした',
            )
          }
          await api().staffAssignAndPay(
            staffPasscode(),
            target.cloudId,
            assignment.seatIds,
            false,
          )
          await refreshAll()
          return
        }
        // R17: 受付時に席が割り当て済み（未払い）のゾーン予約は、同じ席を
        // そのまま staff_assign_and_pay に渡して支払いを確定する
        // （サーバ側で「自分の席」として扱われ、seat_state が sold になる）
        if (
          isZoneBooking(target) &&
          value &&
          !target.paid &&
          !target.cancelled &&
          target.seatIds.length > 0
        ) {
          await api().staffAssignAndPay(
            staffPasscode(),
            target.cloudId,
            target.seatIds,
            target.checkedIn,
          )
          await refreshAll()
          return
        }
        // R12: ゾーン予約を未払いに戻すと、割り当てた席も解放する
        // R21（ラウンド8・S-2）: 来場済みの場合はサーバ側（staff_unassign_
        // and_unpay）が席を解放せず 'reserved' として保持する。クライアントは
        // 従来どおり RPC を呼び、再取得した状態（席が残る）をそのまま表示する
        if (isZoneBooking(target) && !value && target.paid && target.seatIds.length > 0) {
          await api().staffUnassignAndUnpay(staffPasscode(), target.cloudId)
          await refreshAll()
          return
        }
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
        // R12: 未割当のゾーン予約の受付完了は、席の割当＋支払い＋来場を
        // staff_assign_and_pay（p_checked_in=true）で原子的に行う
        if (isUnassignedZoneBooking(target) && !target.cancelled) {
          const assignment = assignZoneSeats(
            dataRef.current,
            target.zone as ZoneId,
            target.items.length,
          )
          if (!assignment) {
            throw new Error(
              'このゾーンに割り当てられる席がありません（空席が不足しています）。受付完了にはしませんでした',
            )
          }
          await api().staffAssignAndPay(
            staffPasscode(),
            target.cloudId,
            assignment.seatIds,
            true,
          )
          await refreshAll()
          return
        }
        // R17: 受付時に席が割り当て済み（未払い）なら、同じ席で支払いも
        // 確定する（seat_state を sold に揃えるため assign_and_pay を使う）
        if (
          isZoneBooking(target) &&
          !target.paid &&
          !target.cancelled &&
          target.seatIds.length > 0
        ) {
          await api().staffAssignAndPay(
            staffPasscode(),
            target.cloudId,
            target.seatIds,
            true,
          )
          await refreshAll()
          return
        }
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
