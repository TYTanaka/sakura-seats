import { describe, expect, it, vi } from 'vitest'
import {
  CloudApi,
  mapLookupResult,
  mapPublicState,
  mapStaffData,
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
})
