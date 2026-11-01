import { describe, expect, it } from 'vitest'
import { ALL_SEATS } from '../data/seats'
import {
  cancelReservation,
  createReservation,
  emptyData,
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

function reserveOnline(data: AppData, seatIds: string[], name = '山田 花子') {
  return createReservation(data, {
    seatIds,
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
      seatIds: ['2F-21-10'],
      name: '',
      phone: '',
      note: '',
      source: 'door',
    })
    expect(reservation.paid).toBe(true)
    expect(reservation.name).toBe('当日')
    expect(seatStatus(data, '2F-21-10')).toBe('paid')
  })

  it('売上・未払い合計が正しく計算される（単価2000円）', () => {
    let data = emptyData()
    const r1 = reserveOnline(data, ['1F-5-12', '1F-5-13']) // 2席・未払い 4000円
    data = r1.data
    const r2 = createReservation(data, {
      seatIds: ['1F-6-10'],
      name: '当日',
      phone: '',
      note: '',
      source: 'door',
    }) // 1席・支払済 2000円
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

describe('金額の記録と上書き（当日料金対応）', () => {
  it('オンライン予約の金額は単価×席数で記録される', () => {
    const { reservation } = reserveOnline(emptyData(), ['1F-5-12', '1F-5-13'])
    expect(reservation.amount).toBe(4000)
  })

  it('当日販売では確定時に金額を上書きでき、集計は記録金額で計算される', () => {
    // 単価2000円×2席 = 4000円のところを、当日料金として3500円で記録
    const { data, reservation } = createReservation(emptyData(), {
      seatIds: ['1F-6-10', '1F-6-11'],
      name: '',
      phone: '',
      note: '',
      source: 'door',
      amount: 3500,
    })
    expect(reservation.amount).toBe(3500)
    const t = totals(data, ALL_IDS)
    expect(t.salesTotal).toBe(3500)
    expect(t.paidSeatCount).toBe(2)
  })

  it('公演料金を後から変更しても、記録済みの金額は変わらない', () => {
    const { data } = reserveOnline(emptyData(), ['1F-5-12', '1F-5-13']) // 4000円で記録
    const repriced = updatePerformance(data, { ...data.performance, price: 3000 })
    expect(totals(repriced, ALL_IDS).unpaidTotal).toBe(4000)
  })

  it('負の金額は記録できない', () => {
    expect(() =>
      createReservation(emptyData(), {
        seatIds: ['1F-6-10'],
        name: '',
        phone: '',
        note: '',
        source: 'door',
        amount: -100,
      }),
    ).toThrow()
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
