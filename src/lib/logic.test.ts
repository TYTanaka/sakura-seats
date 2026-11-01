import { describe, expect, it } from 'vitest'
import { ALL_SEATS } from '../data/seats'
import {
  cancelReservation,
  createReservation,
  emptyData,
  normalizeAppData,
  reservationTypeSummary,
  seatStatus,
  setBlockedForSeats,
  setCheckedIn,
  setPaid,
  toggleBlocked,
  totals,
  updatePerformance,
  type AppData,
} from './logic'

const ALL_IDS = ALL_SEATS.map((s) => s.id)

function seatsOf(seatIds: string[], typeId = 'adult') {
  return seatIds.map((seatId) => ({ seatId, typeId }))
}

function reserveOnline(data: AppData, seatIds: string[], name = '山田 花子', typeId = 'adult') {
  return createReservation(data, {
    seats: seatsOf(seatIds, typeId),
    name,
    phone: '090-0000-0000',
    note: '',
    source: 'online',
  })
}

describe('予約フロー', () => {
  it('予約すると席が予約済になり、予約番号は SK-XXXX 形式', () => {
    const { data, reservation } = reserveOnline(emptyData(), ['1F-5-12', '1F-5-13'])
    expect(reservation.id).toMatch(/^SK-\d{4}$/)
    expect(reservation.id).toBe('SK-0001')
    expect(seatStatus(data, '1F-5-12')).toBe('reserved')
    expect(seatStatus(data, '1F-5-13')).toBe('reserved')
    expect(seatStatus(data, '1F-5-14')).toBe('available')
  })

  it('同じ席は二重に予約できない', () => {
    const { data } = reserveOnline(emptyData(), ['1F-5-12'])
    expect(() => reserveOnline(data, ['1F-5-12'], '佐藤 一郎')).toThrow()
  })

  it('キャンセルすると席が解放される', () => {
    const { data, reservation } = reserveOnline(emptyData(), ['1F-5-12'])
    const after = cancelReservation(data, reservation.id)
    expect(seatStatus(after, '1F-5-12')).toBe('available')
    // 解放後は別の人が予約できる
    const again = reserveOnline(after, ['1F-5-12'], '佐藤 一郎')
    expect(again.reservation.id).toBe('SK-0002')
  })

  it('オンライン申込は8席まで', () => {
    const nine = ['1F-4-6', '1F-4-7', '1F-4-8', '1F-4-9', '1F-4-10', '1F-4-11', '1F-4-12', '1F-4-13', '1F-4-14']
    expect(() => reserveOnline(emptyData(), nine)).toThrow()
  })

  it('チェックイン状態を切り替えられる', () => {
    const { data, reservation } = reserveOnline(emptyData(), ['1F-5-12'])
    const after = setCheckedIn(data, reservation.id, true)
    expect(after.reservations[0].checkedIn).toBe(true)
  })
})

describe('支払いと集計', () => {
  it('支払い済みにすると席が「支払済」状態になる', () => {
    const { data, reservation } = reserveOnline(emptyData(), ['1F-5-12'])
    const after = setPaid(data, reservation.id, true)
    expect(seatStatus(after, '1F-5-12')).toBe('paid')
  })

  it('当日販売は支払済として記録され、名前が空なら「当日」', () => {
    const { data, reservation } = createReservation(emptyData(), {
      seats: seatsOf(['2F-21-10']),
      name: '',
      phone: '',
      note: '',
      source: 'door',
    })
    expect(reservation.paid).toBe(true)
    expect(reservation.name).toBe('当日')
    expect(seatStatus(data, '2F-21-10')).toBe('paid')
  })

  it('売上・未払い合計が正しく計算される（大人2,000円）', () => {
    let data = emptyData()
    const r1 = reserveOnline(data, ['1F-5-12', '1F-5-13']) // 大人2席・未払い 4,000円
    data = r1.data
    const r2 = createReservation(data, {
      seats: seatsOf(['1F-6-10']),
      name: '当日',
      phone: '',
      note: '',
      source: 'door',
    }) // 大人1席・支払済 2,000円
    data = r2.data
    const t = totals(data, ALL_IDS)
    expect(t.reservationCount).toBe(2)
    expect(t.reservedSeatCount).toBe(2)
    expect(t.paidSeatCount).toBe(1)
    expect(t.salesTotal).toBe(2000)
    expect(t.unpaidTotal).toBe(4000)
    // 支払いを済ませると未払いが売上へ移る
    const afterPay = setPaid(data, r1.reservation.id, true)
    const t2 = totals(afterPay, ALL_IDS)
    expect(t2.salesTotal).toBe(6000)
    expect(t2.unpaidTotal).toBe(0)
    expect(t2.paidSeatCount).toBe(3)
  })
})

describe('券種（大人・子供など）', () => {
  it('混在した券種の予約は、席ごとの料金スナップショットの合計になる', () => {
    const { reservation } = createReservation(emptyData(), {
      seats: [
        { seatId: '1F-5-12', typeId: 'adult' },
        { seatId: '1F-5-13', typeId: 'child' },
      ],
      name: '山田 花子',
      phone: '090-0000-0000',
      note: '',
      source: 'online',
    })
    expect(reservation.amount).toBe(3000) // 大人2,000 + 子供1,000
    expect(reservation.items).toEqual([
      { seatId: '1F-5-12', typeId: 'adult', typeName: '大人', price: 2000 },
      { seatId: '1F-5-13', typeId: 'child', typeName: '子供', price: 1000 },
    ])
    expect(reservationTypeSummary(reservation)).toBe('大人×1・子供×1')
  })

  it('後から券種の料金・名前を変更しても、記録済みの金額と券種名は変わらない', () => {
    const { data } = createReservation(emptyData(), {
      seats: [
        { seatId: '1F-5-12', typeId: 'adult' },
        { seatId: '1F-5-13', typeId: 'child' },
      ],
      name: '山田 花子',
      phone: '090-0000-0000',
      note: '',
      source: 'online',
    })
    const changed = updatePerformance(data, {
      ...data.performance,
      ticketTypes: [
        { id: 'adult', name: '一般', price: 3000 },
        { id: 'child', name: '小人', price: 500 },
      ],
    })
    const t = totals(changed, ALL_IDS)
    expect(t.unpaidTotal).toBe(3000)
    // 内訳もスナップショット名（大人・子供）のまま残る
    const adult = t.byType.find((r) => r.typeName === '大人')
    const child = t.byType.find((r) => r.typeName === '子供')
    expect(adult?.reservedSeatCount).toBe(1)
    expect(child?.reservedSeatCount).toBe(1)
    expect(changed.reservations[0].items[1]).toMatchObject({ typeName: '子供', price: 1000 })
  })

  it('券種別の集計（予約席数・支払済席数・売上）が正しい', () => {
    let data = emptyData()
    // オンライン: 大人1・子供1（未払い）
    const r1 = createReservation(data, {
      seats: [
        { seatId: '1F-5-12', typeId: 'adult' },
        { seatId: '1F-5-13', typeId: 'child' },
      ],
      name: '山田 花子',
      phone: '090-0000-0000',
      note: '',
      source: 'online',
    })
    data = r1.data
    // 当日販売: 子供1（支払済）
    const r2 = createReservation(data, {
      seats: seatsOf(['1F-6-10'], 'child'),
      name: '',
      phone: '',
      note: '',
      source: 'door',
    })
    data = r2.data
    const t = totals(data, ALL_IDS)
    const adult = t.byType.find((r) => r.typeName === '大人')
    const child = t.byType.find((r) => r.typeName === '子供')
    expect(adult).toMatchObject({ reservedSeatCount: 1, paidSeatCount: 0, salesTotal: 0 })
    expect(child).toMatchObject({ reservedSeatCount: 1, paidSeatCount: 1, salesTotal: 1000 })
    expect(t.salesTotal).toBe(1000)
    expect(t.unpaidTotal).toBe(3000)
    // オンライン分を支払い済みにすると券種別売上も動く
    const t2 = totals(setPaid(data, r1.reservation.id, true), ALL_IDS)
    expect(t2.byType.find((r) => r.typeName === '大人')).toMatchObject({
      reservedSeatCount: 0,
      paidSeatCount: 1,
      salesTotal: 2000,
    })
    expect(t2.byType.find((r) => r.typeName === '子供')).toMatchObject({
      reservedSeatCount: 0,
      paidSeatCount: 2,
      salesTotal: 2000,
    })
  })

  it('当日販売でも券種混在のまま金額が自動計算される（手入力なし）', () => {
    const { reservation } = createReservation(emptyData(), {
      seats: [
        { seatId: '1F-6-10', typeId: 'adult' },
        { seatId: '1F-6-11', typeId: 'child' },
        { seatId: '1F-6-12', typeId: 'child' },
      ],
      name: '',
      phone: '',
      note: '',
      source: 'door',
    })
    expect(reservation.amount).toBe(4000) // 2,000 + 1,000 + 1,000
    expect(reservation.paid).toBe(true)
  })

  it('予約に使った券種を設定から削除しても、予約と集計は壊れない', () => {
    const { data, reservation } = reserveOnline(emptyData(), ['1F-5-12'], '山田 花子', 'child')
    const withoutChild = updatePerformance(data, {
      ...data.performance,
      ticketTypes: data.performance.ticketTypes.filter((t) => t.id !== 'child'),
    })
    expect(seatStatus(withoutChild, '1F-5-12')).toBe('reserved')
    expect(withoutChild.reservations[0].amount).toBe(1000)
    const t = totals(withoutChild, ALL_IDS)
    expect(t.byType.find((r) => r.typeName === '子供')).toMatchObject({
      reservedSeatCount: 1,
      paidSeatCount: 0,
      salesTotal: 0,
    })
    expect(reservationTypeSummary(withoutChild.reservations[0])).toBe('子供×1')
    expect(reservation.items[0].typeId).toBe('child')
    // 削除した券種では新規予約できない
    expect(() => reserveOnline(withoutChild, ['1F-5-13'], '佐藤 一郎', 'child')).toThrow()
  })

  it('存在しない券種IDでは予約できない', () => {
    expect(() =>
      createReservation(emptyData(), {
        seats: [{ seatId: '1F-5-12', typeId: 'unknown-type' }],
        name: '山田 花子',
        phone: '',
        note: '',
        source: 'online',
      }),
    ).toThrow()
  })

  it('券種の料金が不正（負数）だと記録できない', () => {
    const data = emptyData()
    const broken: AppData = {
      ...data,
      performance: {
        ...data.performance,
        ticketTypes: [{ id: 'bad', name: '不良券種', price: -100 }],
      },
    }
    expect(() =>
      createReservation(broken, {
        seats: [{ seatId: '1F-6-10', typeId: 'bad' }],
        name: '',
        phone: '',
        note: '',
        source: 'door',
      }),
    ).toThrow()
  })
})

describe('旧データの移行（単価のみ・明細なし）', () => {
  const legacyBase = {
    performance: {
      name: '旧サンプル公演',
      date: '2026-12-19',
      time: '13:00',
      price: 2000,
      note: '',
    },
    blocked: [] as string[],
    seq: 1,
  }

  it('旧公演（単価のみ）は券種リスト（大人=旧単価・子供1,000円）へ移行する', () => {
    const data = normalizeAppData({ ...legacyBase, reservations: [] })
    expect(data).not.toBeNull()
    expect(data!.performance.ticketTypes).toEqual([
      { id: 'adult', name: '大人', price: 2000 },
      { id: 'child', name: '子供', price: 1000 },
    ])
    expect(data!.performance.priceNote).toBe('')
  })

  it('明細のない旧予約はデフォルト券種で明細化され、記録金額がそのまま残る', () => {
    const data = normalizeAppData({
      ...legacyBase,
      reservations: [
        {
          id: 'SK-0001',
          seatIds: ['1F-5-12', '1F-5-13'],
          name: '山田 花子',
          phone: '090-0000-0000',
          note: '',
          source: 'online',
          amount: 4000,
          checkedIn: false,
          paid: false,
          cancelled: false,
          createdAt: '2026-11-01T00:00:00.000Z',
        },
      ],
    })
    const res = data!.reservations[0]
    expect(res.amount).toBe(4000)
    expect(res.items).toEqual([
      { seatId: '1F-5-12', typeId: 'adult', typeName: '大人', price: 2000 },
      { seatId: '1F-5-13', typeId: 'adult', typeName: '大人', price: 2000 },
    ])
    expect(totals(data!, ALL_IDS).unpaidTotal).toBe(4000)
  })

  it('旧当日販売の上書き金額（単価と異なる記録金額）も金額が正として残る', () => {
    const data = normalizeAppData({
      ...legacyBase,
      reservations: [
        {
          id: 'SK-0001',
          seatIds: ['1F-6-10'],
          name: '当日',
          phone: '',
          note: '',
          source: 'door',
          amount: 2500, // 旧版の金額上書きで記録された金額
          checkedIn: false,
          paid: true,
          cancelled: false,
          createdAt: '2026-11-01T00:00:00.000Z',
        },
      ],
    })
    const res = data!.reservations[0]
    expect(res.amount).toBe(2500)
    expect(res.items).toEqual([
      { seatId: '1F-6-10', typeId: 'adult', typeName: '大人', price: 2500 },
    ])
    expect(totals(data!, ALL_IDS).salesTotal).toBe(2500)
  })

  it('金額を持たない旧予約には 単価×席数 が補完される', () => {
    const data = normalizeAppData({
      ...legacyBase,
      reservations: [
        {
          id: 'SK-0001',
          seatIds: ['1F-5-12', '1F-5-13'],
          name: '山田 花子',
          phone: '',
          note: '',
          source: 'online',
          checkedIn: false,
          paid: false,
          cancelled: false,
          createdAt: '2026-11-01T00:00:00.000Z',
        },
      ],
    })
    expect(data!.reservations[0].amount).toBe(4000)
    expect(data!.reservations[0].items.reduce((s, i) => s + i.price, 0)).toBe(4000)
  })

  it('読めないデータは null を返す', () => {
    expect(normalizeAppData(null)).toBeNull()
    expect(normalizeAppData('garbage')).toBeNull()
    expect(normalizeAppData({ reservations: 'x' })).toBeNull()
  })
})

describe('販売設定（ブロック席）', () => {
  it('ブロックした席は販売しない状態になり、予約できない', () => {
    const data = toggleBlocked(emptyData(), '1F-1-3')
    expect(seatStatus(data, '1F-1-3')).toBe('blocked')
    expect(() => reserveOnline(data, ['1F-1-3'])).toThrow()
    const t = totals(data, ALL_IDS)
    expect(t.blockedSeatCount).toBe(1)
    expect(t.availableSeatCount).toBe(ALL_IDS.length - 1)
  })

  it('ブロックを外すと再び販売中になる', () => {
    let data = toggleBlocked(emptyData(), '1F-1-3')
    data = toggleBlocked(data, '1F-1-3')
    expect(seatStatus(data, '1F-1-3')).toBe('available')
  })

  it('列一括ブロックができる', () => {
    const row16 = ALL_SEATS.filter((s) => s.id.startsWith('1F-16-')).map((s) => s.id)
    const data = setBlockedForSeats(emptyData(), row16, true)
    expect(row16.every((id) => seatStatus(data, id) === 'blocked')).toBe(true)
    expect(totals(data, ALL_IDS).blockedSeatCount).toBe(8)
  })

  it('予約が入っている席はブロックに切り替わらない', () => {
    const { data, reservation } = reserveOnline(emptyData(), ['1F-5-12'])
    const after = toggleBlocked(data, '1F-5-12')
    expect(seatStatus(after, '1F-5-12')).toBe('reserved')
    const afterBulk = setBlockedForSeats(data, ['1F-5-12'], true)
    expect(seatStatus(afterBulk, '1F-5-12')).toBe('reserved')
    expect(reservation.seatIds).toEqual(['1F-5-12'])
  })
})

describe('予約締切（Phase 2）', () => {
  const past = new Date(Date.now() - 60_000).toISOString().slice(0, 16)
  const future = new Date(Date.now() + 60_000).toISOString().slice(0, 16)

  it('締切未設定なら閉じていない', async () => {
    const { isBookingClosed } = await import('./logic')
    expect(isBookingClosed(emptyData())).toBe(false)
  })

  it('締切を過ぎたらオンライン予約は例外、当日販売は可能', async () => {
    const { isBookingClosed } = await import('./logic')
    const data = { ...emptyData(), bookingDeadline: past }
    expect(isBookingClosed(data)).toBe(true)
    expect(() =>
      createReservation(data, {
        seats: seatsOf(['1F-5-6']),
        name: '山田',
        phone: '090',
        note: '',
        source: 'online',
      }),
    ).toThrow('予約受付は終了しました')
    const door = createReservation(data, {
      seats: seatsOf(['1F-5-6']),
      name: '',
      phone: '',
      note: '',
      source: 'door',
    })
    expect(door.reservation.paid).toBe(true)
  })

  it('締切が未来なら閉じていない', async () => {
    const { isBookingClosed } = await import('./logic')
    expect(isBookingClosed({ ...emptyData(), bookingDeadline: future })).toBe(false)
  })

  it('normalizeAppData は bookingDeadline を読み取る', () => {
    const data = normalizeAppData({
      performance: emptyData().performance,
      reservations: [],
      blocked: [],
      seq: 0,
      bookingDeadline: '2026-12-19T09:00',
    })
    expect(data?.bookingDeadline).toBe('2026-12-19T09:00')
  })
})

describe('予約確認（ローカル照合・Phase 2）', () => {
  it('予約番号（大小文字不問）と電話番号（ハイフン不問）で一致する', async () => {
    const { findReservationByCodePhone } = await import('./logic')
    const { data, reservation } = reserveOnline(emptyData(), ['1F-5-6'])
    expect(findReservationByCodePhone(data, 'sk-0001', '09000000000')?.id).toBe(reservation.id)
    expect(findReservationByCodePhone(data, 'SK-0001', '090-0000-0000')?.id).toBe(reservation.id)
    expect(findReservationByCodePhone(data, 'SK-0001', '080-0000-0000')).toBeNull()
    expect(findReservationByCodePhone(data, 'SK-9999', '090-0000-0000')).toBeNull()
  })

  it('キャンセル済みはヒットしない', async () => {
    const { findReservationByCodePhone } = await import('./logic')
    const { data, reservation } = reserveOnline(emptyData(), ['1F-5-6'])
    const cancelled = cancelReservation(data, reservation.id)
    expect(findReservationByCodePhone(cancelled, 'SK-0001', '090-0000-0000')).toBeNull()
  })
})

describe('階ごとの残席数と seatStates（Phase 2）', () => {
  it('空の状態では全席が残席', async () => {
    const { availableCountByFloor } = await import('./logic')
    const counts = availableCountByFloor(emptyData())
    expect(counts[1] + counts[2]).toBe(ALL_IDS.length)
  })

  it('予約すると残席が減る', async () => {
    const { availableCountByFloor } = await import('./logic')
    const { data } = reserveOnline(emptyData(), ['2F-21-7'])
    const counts = availableCountByFloor(data)
    expect(counts[2]).toBe(ALL_SEATS.filter((s) => s.floor === 2).length - 1)
  })

  it('seatStates がある場合は reservations より優先される', () => {
    const data: AppData = {
      ...emptyData(),
      seatStates: { '1F-5-6': 'reserved', '1F-5-7': 'sold' },
    }
    expect(seatStatus(data, '1F-5-6')).toBe('reserved')
    expect(seatStatus(data, '1F-5-7')).toBe('paid')
    expect(seatStatus(data, '1F-5-8')).toBe('available')
  })
})
