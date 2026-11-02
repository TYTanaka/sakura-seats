import { describe, expect, it, vi } from 'vitest'
import {
  CloudApi,
  mapLookupResult,
  mapPublicState,
  mapStaffData,
  type AuthAdapter,
  type RpcClient,
} from './cloud'
import { defaultPerformance } from './logic'

const PERF = defaultPerformance()

function rowFixture(overrides: Record<string, unknown> = {}) {
  return {
    id: 'uuid-1',
    code: 'SK-0001',
    name: '山田 花子',
    phone: '090-0000-0000',
    note: '',
    items: [
      { seatId: '1F-5-6', typeId: 'adult', typeName: '大人', price: 2000 },
      { seatId: '1F-5-7', typeId: 'child', typeName: '子供', price: 1000 },
    ],
    amount: 3000,
    kind: 'online',
    paid: false,
    checkedIn: false,
    status: 'active',
    createdAt: '2026-11-01T00:00:00.000Z',
    ...overrides,
  }
}

describe('mapPublicState', () => {
  it('公演設定・ブロック席・締切・座席状態を変換する', () => {
    const state = mapPublicState({
      performance: PERF,
      blockedSeats: ['1F-1-3'],
      bookingDeadline: '2026-12-19T09:00:00.000Z',
      seats: [
        { seatId: '1F-5-6', state: 'reserved' },
        { seatId: '1F-5-7', state: 'sold' },
        { seatId: '1F-5-8', state: 'bogus' },
      ],
    })
    expect(state.performance.name).toBe(PERF.name)
    expect(state.blockedSeats).toEqual(['1F-1-3'])
    expect(state.bookingDeadline).toBe('2026-12-19T09:00:00.000Z')
    expect(state.seatStates).toEqual({ '1F-5-6': 'reserved', '1F-5-7': 'sold' })
  })

  it('空でも落ちない', () => {
    const state = mapPublicState(null)
    expect(state.blockedSeats).toEqual([])
    expect(state.bookingDeadline).toBeNull()
    expect(state.seatStates).toEqual({})
  })
})

describe('mapStaffData / mapLookupResult', () => {
  it('予約行をクライアント形式へ変換する（code→id, kind→source, status→cancelled）', () => {
    const staff = mapStaffData({
      config: { performance: PERF, blockedSeats: [], bookingDeadline: null },
      reservations: [rowFixture({ status: 'cancelled', kind: 'door', paid: true })],
    })
    const r = staff.reservations[0]
    expect(r.id).toBe('SK-0001')
    expect(r.cloudId).toBe('uuid-1')
    expect(r.source).toBe('door')
    expect(r.cancelled).toBe(true)
    expect(r.paid).toBe(true)
    expect(r.seatIds).toEqual(['1F-5-6', '1F-5-7'])
    expect(r.amount).toBe(3000)
  })

  it('lookup は null をそのまま null にする', () => {
    expect(mapLookupResult(null)).toBeNull()
    expect(mapLookupResult(rowFixture())?.id).toBe('SK-0001')
  })

  it('staff_get_all の seller を予約へ写す（空・欠落は未設定）', () => {
    const withSeller = mapStaffData({
      config: { performance: PERF, blockedSeats: [], bookingDeadline: null },
      reservations: [rowFixture({ seller: '田中' })],
    })
    expect(withSeller.reservations[0].seller).toBe('田中')
    const withNull = mapStaffData({
      config: { performance: PERF, blockedSeats: [], bookingDeadline: null },
      reservations: [rowFixture({ seller: null })],
    })
    expect(withNull.reservations[0].seller).toBeUndefined()
    const without = mapStaffData({
      config: { performance: PERF, blockedSeats: [], bookingDeadline: null },
      reservations: [rowFixture()],
    })
    expect(without.reservations[0].seller).toBeUndefined()
  })
})

describe('CloudApi（モック RPC クライアント）', () => {
  function fakeClient(handler: (fn: string, args: Record<string, unknown>) => unknown) {
    const rpc = vi.fn(async (fn: string, args: Record<string, unknown>) => {
      try {
        return { data: handler(fn, args), error: null }
      } catch (e) {
        return { data: null, error: { message: e instanceof Error ? e.message : String(e) } }
      }
    })
    return { client: { rpc } as RpcClient, rpc }
  }

  it('bookSeats は引数を p_* 形式で渡し、code/amount を返す', async () => {
    const { client, rpc } = fakeClient(() => ({ code: 'SK-0042', amount: 3000 }))
    const api = new CloudApi(client)
    const res = await api.bookSeats({
      name: '山田 花子',
      phone: '090',
      note: '',
      items: [{ seatId: '1F-5-6', typeId: 'adult' }],
    })
    expect(res).toEqual({ code: 'SK-0042', amount: 3000 })
    expect(rpc).toHaveBeenCalledWith('book_seats', {
      p_name: '山田 花子',
      p_phone: '090',
      p_note: '',
      p_items: [{ seatId: '1F-5-6', typeId: 'adult' }],
    })
  })

  it('SEAT_TAKEN エラーは日本語の案内に変換される', async () => {
    const { client } = fakeClient(() => {
      throw new Error('SEAT_TAKEN: 選択された座席の一部が…')
    })
    const api = new CloudApi(client)
    await expect(
      api.bookSeats({ name: 'a', phone: '0', note: '', items: [] }),
    ).rejects.toThrow('選び直してください')
  })

  it('staffUnlock 経路: UNAUTHORIZED はパスコード違いの文案になる', async () => {
    const { client } = fakeClient(() => {
      throw new Error('UNAUTHORIZED: パスコードが違います')
    })
    const api = new CloudApi(client)
    await expect(api.staffGetAll('9999')).rejects.toThrow('パスコードが違います')
  })

  it('staffSaveConfig は締切 null もそのまま渡す', async () => {
    const { client, rpc } = fakeClient(() => ({ ok: true }))
    const api = new CloudApi(client)
    await api.staffSaveConfig('1234', PERF, ['1F-1-3'], null)
    expect(rpc).toHaveBeenCalledWith('staff_save_config', {
      p_passcode: '1234',
      p_performance: PERF,
      p_blocked_seats: ['1F-1-3'],
      p_booking_deadline: null,
    })
  })

  it('lookupReservation は RPC の null を null として返す', async () => {
    const { client } = fakeClient(() => null)
    const api = new CloudApi(client)
    await expect(api.lookupReservation('SK-9999', '000')).resolves.toBeNull()
  })

  it('staffSell は販売者を p_seller で渡す（未選択は null）', async () => {
    const { client, rpc } = fakeClient(() => ({ code: 'SK-0007', amount: 2000 }))
    const api = new CloudApi(client)
    const items = [{ seatId: '1F-5-6', typeId: 'adult' }]
    await expect(api.staffSell('1234', '', items, '田中')).resolves.toEqual({
      code: 'SK-0007',
      amount: 2000,
    })
    expect(rpc).toHaveBeenCalledWith('staff_sell', {
      p_passcode: '1234',
      p_name: '',
      p_items: items,
      p_seller: '田中',
    })
    await api.staffSell('1234', '', items)
    expect(rpc).toHaveBeenLastCalledWith('staff_sell', {
      p_passcode: '1234',
      p_name: '',
      p_items: items,
      p_seller: null,
    })
  })

  it('cancelReservation は RPC の result をそのまま返し、未知の応答はエラーにする', async () => {
    const okClient = fakeClient(() => ({ ok: true, result: 'OK', code: 'SK-0001' }))
    await expect(
      new CloudApi(okClient.client).cancelReservation('SK-0001', '09000000000'),
    ).resolves.toBe('OK')
    expect(okClient.rpc).toHaveBeenCalledWith('cancel_reservation', {
      p_code: 'SK-0001',
      p_phone: '09000000000',
    })
    const lockedClient = fakeClient(() => ({ ok: false, result: 'PAID_LOCKED' }))
    await expect(
      new CloudApi(lockedClient.client).cancelReservation('SK-0001', '09000000000'),
    ).resolves.toBe('PAID_LOCKED')
    const weirdClient = fakeClient(() => ({ ok: false, result: 'SOMETHING_ELSE' }))
    await expect(
      new CloudApi(weirdClient.client).cancelReservation('SK-0001', '09000000000'),
    ).rejects.toThrow('通信に失敗しました')
  })

  it('staffUncancelReservation は result を返し、RPC 未適用は専用エラーになる（R6・O-1）', async () => {
    const okClient = fakeClient(() => ({ ok: true, result: 'OK', code: 'SK-0001' }))
    await expect(
      new CloudApi(okClient.client).staffUncancelReservation('1234', 'SK-0001'),
    ).resolves.toBe('OK')
    expect(okClient.rpc).toHaveBeenCalledWith('staff_uncancel_reservation', {
      p_passcode: '1234',
      p_code: 'SK-0001',
    })
    const takenClient = fakeClient(() => ({ ok: false, result: 'SEAT_TAKEN' }))
    await expect(
      new CloudApi(takenClient.client).staffUncancelReservation('1234', 'SK-0001'),
    ).resolves.toBe('SEAT_TAKEN')
    // migration_sakura_r6 未適用の DB: PostgREST の「関数が見つからない」を専用文面へ
    const missingClient = fakeClient(() => {
      throw new Error(
        'Could not find the function public.staff_uncancel_reservation(p_code, p_passcode) in the schema cache',
      )
    })
    await expect(
      new CloudApi(missingClient.client).staffUncancelReservation('1234', 'SK-0001'),
    ).rejects.toThrow('migration_sakura_r6')
    const weirdClient = fakeClient(() => ({ ok: false, result: 'SOMETHING_ELSE' }))
    await expect(
      new CloudApi(weirdClient.client).staffUncancelReservation('1234', 'SK-0001'),
    ).rejects.toThrow('通信に失敗しました')
  })

  it('bookSeats は R7 適用後の token をそのまま返し、未適用なら undefined（R7）', async () => {
    const token = 'abcdefghij0123456789AB' // base64url 22文字
    const withToken = fakeClient(() => ({ code: 'SK-0009', amount: 2000, token }))
    await expect(
      new CloudApi(withToken.client).bookSeats({
        name: 'a',
        phone: '0',
        note: '',
        items: [{ seatId: '1F-5-6', typeId: 'adult' }],
      }),
    ).resolves.toEqual({ code: 'SK-0009', amount: 2000, token })
    // R7 未適用の DB（token キー自体が返らない）→ undefined で graceful に落とす
    const withoutToken = fakeClient(() => ({ code: 'SK-0009', amount: 2000 }))
    const res = await new CloudApi(withoutToken.client).bookSeats({
      name: 'a',
      phone: '0',
      note: '',
      items: [{ seatId: '1F-5-6', typeId: 'adult' }],
    })
    expect(res.token).toBeUndefined()
    // 形式外の token は採用しない
    const garbage = fakeClient(() => ({ code: 'SK-0009', amount: 2000, token: 'SK-0009' }))
    const res2 = await new CloudApi(garbage.client).bookSeats({
      name: 'a',
      phone: '0',
      note: '',
      items: [{ seatId: '1F-5-6', typeId: 'adult' }],
    })
    expect(res2.token).toBeUndefined()
  })

  it('staffCheckIn は result と要約を返し、RPC 未適用は専用エラーになる（R7）', async () => {
    const summary = {
      ok: true,
      result: 'OK',
      code: 'SK-0001',
      name: '検証 太郎',
      items: [{ seatId: '1F-5-12', typeId: 'adult', typeName: '大人', price: 2000 }],
      amount: 2000,
      kind: 'online',
      paid: false,
      checkedInAt: '2026-12-19T12:45:00+09:00',
      perfDate: '2026-12-19',
      perfName: 'サンプル公演',
    }
    const okClient = fakeClient(() => summary)
    const out = await new CloudApi(okClient.client).staffCheckIn('1234', 'token-value')
    expect(out.result).toBe('OK')
    expect(out.checkedInAt).toBe('2026-12-19T12:45:00+09:00')
    expect(out.reservation?.id).toBe('SK-0001')
    expect(out.reservation?.seatIds).toEqual(['1F-5-12'])
    expect(out.reservation?.checkedIn).toBe(true)
    expect(okClient.rpc).toHaveBeenCalledWith('staff_check_in', {
      p_passcode: '1234',
      p_token: 'token-value',
    })
    // 偽造トークン: NOT_FOUND は例外でなく result で返る（要約なし）
    const nfClient = fakeClient(() => ({ ok: false, result: 'NOT_FOUND' }))
    const nf = await new CloudApi(nfClient.client).staffCheckIn('1234', 'forged')
    expect(nf.result).toBe('NOT_FOUND')
    expect(nf.reservation).toBeNull()
    // 使用済み: ALREADY_CHECKED_IN + 元の受付日時
    const alreadyClient = fakeClient(() => ({
      ...summary,
      ok: false,
      result: 'ALREADY_CHECKED_IN',
    }))
    const already = await new CloudApi(alreadyClient.client).staffCheckIn('1234', 't')
    expect(already.result).toBe('ALREADY_CHECKED_IN')
    expect(already.checkedInAt).toBe('2026-12-19T12:45:00+09:00')
    // migration_sakura_r7 未適用の DB → 専用文面（cloudStore が SERVER_PENDING に分岐）
    const missingClient = fakeClient(() => {
      throw new Error(
        'Could not find the function public.staff_check_in(p_passcode, p_token) in the schema cache',
      )
    })
    await expect(
      new CloudApi(missingClient.client).staffCheckIn('1234', 't'),
    ).rejects.toThrow('migration_sakura_r7')
    // パスコード違いは従来どおり
    const unauthClient = fakeClient(() => {
      throw new Error('UNAUTHORIZED: パスコードが違います')
    })
    await expect(
      new CloudApi(unauthClient.client).staffCheckIn('9999', 't'),
    ).rejects.toThrow('パスコードが違います')
    // 未知の result は通信エラーにする
    const weirdClient = fakeClient(() => ({ ok: false, result: 'SOMETHING_ELSE' }))
    await expect(
      new CloudApi(weirdClient.client).staffCheckIn('1234', 't'),
    ).rejects.toThrow('通信に失敗しました')
  })

  describe('R8: Googleログイン・許可リスト', () => {
    function fakeAuth(user: { email?: string | null } | null) {
      const signInWithGoogle = vi.fn(async (_redirectTo: string) => undefined)
      const signOut = vi.fn(async () => undefined)
      return {
        adapter: {
          getSessionUser: async () => user,
          signInWithGoogle,
          signOut,
          onUserChange: () => () => undefined,
        } as AuthAdapter,
        signInWithGoogle,
        signOut,
      }
    }

    const allowlistPayload = {
      passcodeLoginEnabled: true,
      entries: [
        { email: 'yuuki20170731@gmail.com', note: 'オーナー', createdAt: '2026-11-02T00:00:00Z' },
      ],
    }

    it('getSignedInEmail はセッションのメールを返し、未ログインは null', async () => {
      const { client } = fakeClient(() => null)
      const signed = new CloudApi(client, fakeAuth({ email: 'a@example.com' }).adapter)
      expect(await signed.getSignedInEmail()).toBe('a@example.com')
      const anon = new CloudApi(client, fakeAuth(null).adapter)
      expect(await anon.getSignedInEmail()).toBeNull()
      const noAuth = new CloudApi(client)
      expect(await noAuth.getSignedInEmail()).toBeNull()
    })

    it('signInWithGoogle は redirectTo をそのまま Auth へ渡す', async () => {
      const { client } = fakeClient(() => null)
      const auth = fakeAuth(null)
      const api = new CloudApi(client, auth.adapter)
      await api.signInWithGoogle('https://tytanaka.github.io/sakura-seats/')
      expect(auth.signInWithGoogle).toHaveBeenCalledWith(
        'https://tytanaka.github.io/sakura-seats/',
      )
    })

    it('staffWhoami は応答を変換する', async () => {
      const { client, rpc } = fakeClient(() => ({ ok: true, email: 'a@example.com' }))
      const api = new CloudApi(client)
      expect(await api.staffWhoami()).toEqual({ ok: true, email: 'a@example.com' })
      expect(rpc).toHaveBeenCalledWith('staff_whoami', {})
    })

    it('許可リスト list/add/remove は p_* 引数で呼び、応答を変換する', async () => {
      const { client, rpc } = fakeClient(() => allowlistPayload)
      const api = new CloudApi(client)
      const list = await api.staffAllowlistList('')
      expect(list.passcodeLoginEnabled).toBe(true)
      expect(list.entries[0].email).toBe('yuuki20170731@gmail.com')
      expect(rpc).toHaveBeenCalledWith('staff_allowlist_list', { p_passcode: '' })

      await api.staffAllowlistAdd('1234', 'b@example.com', '受付')
      expect(rpc).toHaveBeenCalledWith('staff_allowlist_add', {
        p_passcode: '1234',
        p_email: 'b@example.com',
        p_note: '受付',
      })

      await api.staffAllowlistRemove('1234', 'b@example.com')
      expect(rpc).toHaveBeenCalledWith('staff_allowlist_remove', {
        p_passcode: '1234',
        p_email: 'b@example.com',
      })

      await api.staffSetPasscodeLogin('', false)
      expect(rpc).toHaveBeenCalledWith('staff_set_passcode_login', {
        p_passcode: '',
        p_enabled: false,
      })
    })

    it('R8 未適用 DB のエラーは専用文面になる', async () => {
      const { client } = fakeClient(() => {
        throw new Error(
          'Could not find the function public.staff_whoami() in the schema cache',
        )
      })
      await expect(new CloudApi(client).staffWhoami()).rejects.toThrow(
        'migration_sakura_r8',
      )
    })

    it('LAST_STAFF / JWT_REQUIRED / INVALID_EMAIL は日本語文面になる', async () => {
      const lastStaff = fakeClient(() => {
        throw new Error('LAST_STAFF: 最後のスタッフは削除できません')
      })
      await expect(
        new CloudApi(lastStaff.client).staffAllowlistRemove('1234', 'a@example.com'),
      ).rejects.toThrow('最後の1人は削除できません')

      const jwtRequired = fakeClient(() => {
        throw new Error('JWT_REQUIRED: この操作はGoogleログインしたスタッフのみ行えます')
      })
      await expect(
        new CloudApi(jwtRequired.client).staffSetPasscodeLogin('1234', false),
      ).rejects.toThrow('Googleログインしたスタッフのみ')

      const invalidEmail = fakeClient(() => {
        throw new Error('INVALID_EMAIL: メールアドレスの形式が正しくありません')
      })
      await expect(
        new CloudApi(invalidEmail.client).staffAllowlistAdd('1234', 'bad', ''),
      ).rejects.toThrow('メールアドレスの形式が正しくありません')
    })
  })
})
