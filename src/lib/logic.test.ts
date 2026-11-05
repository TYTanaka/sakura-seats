import { describe, expect, it } from 'vitest'
import { ALL_SEATS } from '../data/seats'
import {
  cancelReservation,
  createReservation,
  doorsOpenBeforeStart,
  emptyData,
  formatSeatList,
  normalizeAppData,
  normalizeSellerNames,
  reservationTypeSummary,
  seatStatus,
  selfCancelEligibility,
  selfCancelLimit,
  setBlockedForSeats,
  setCheckedIn,
  setPaid,
  toggleBlocked,
  totals,
  uncancelReservation,
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

  it('キャンセルの取り消しで元の予約番号・内容のまま復旧し、席も再占有される（R6・O-1）', () => {
    const { data, reservation } = reserveOnline(emptyData(), ['1F-5-12', '1F-5-13'])
    const cancelled = cancelReservation(data, reservation.id)
    expect(seatStatus(cancelled, '1F-5-12')).toBe('available')
    const { data: restored, result } = uncancelReservation(cancelled, reservation.id)
    expect(result).toBe('OK')
    const r = restored.reservations.find((x) => x.id === reservation.id)
    expect(r?.cancelled).toBe(false)
    expect(r?.name).toBe('山田 花子')
    expect(r?.phone).toBe('090-0000-0000')
    expect(r?.amount).toBe(reservation.amount)
    expect(seatStatus(restored, '1F-5-12')).toBe('reserved')
    expect(seatStatus(restored, '1F-5-13')).toBe('reserved')
  })

  it('キャンセル取り消し: 席が別の有効な予約に取られていたら SEAT_TAKEN で復旧しない（R6・O-1）', () => {
    const { data, reservation } = reserveOnline(emptyData(), ['1F-5-12'])
    const cancelled = cancelReservation(data, reservation.id)
    // 解放された席を別の人が予約する
    const other = reserveOnline(cancelled, ['1F-5-12'], '佐藤 一郎')
    const { data: after, result } = uncancelReservation(other.data, reservation.id)
    expect(result).toBe('SEAT_TAKEN')
    expect(after.reservations.find((x) => x.id === reservation.id)?.cancelled).toBe(true)
    expect(seatStatus(after, '1F-5-12')).toBe('reserved')
  })

  it('キャンセル取り消し: 対象が無い・キャンセル済みでない場合は結果コードだけ返す（R6・O-1）', () => {
    const { data, reservation } = reserveOnline(emptyData(), ['1F-5-12'])
    expect(uncancelReservation(data, 'SK-9999').result).toBe('NOT_FOUND')
    expect(uncancelReservation(data, reservation.id).result).toBe('NOT_CANCELLED')
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

  it('件数＋人数と来場進捗が数えられる（R33 #1/#2）', () => {
    let data = emptyData()
    const r1 = reserveOnline(data, ['1F-5-12', '1F-5-13']) // 2名・未払い
    data = r1.data
    const r2 = createReservation(data, {
      seats: seatsOf(['1F-6-10', '1F-6-11', '1F-6-12']),
      name: '当日',
      phone: '',
      note: '',
      source: 'door',
    }) // 3名・支払済
    data = r2.data
    const t = totals(data, ALL_IDS)
    expect(t.totalPeople).toBe(5)
    expect(t.paidReservationCount).toBe(1)
    expect(t.unpaidReservationCount).toBe(1)
    expect(t.checkedInCount).toBe(0)
    // R37: 当日販売は購入時点で入場まで済んでいる前提のため「未受付」に
    // 数えず、doorSale として分離する（旧仕様は未受付に混ぜていた）
    expect(t.doorSaleCount).toBe(1)
    expect(t.doorSalePeople).toBe(3)
    expect(t.notCheckedInCount).toBe(1)
    expect(t.notCheckedInPeople).toBe(2)
    // 来場済みにすると進捗が移る（キャンセル済みは母数に入らない）
    const arrived = setCheckedIn(data, r1.reservation.id, true)
    const t2 = totals(arrived, ALL_IDS)
    expect(t2.checkedInCount).toBe(1)
    expect(t2.checkedInPeople).toBe(2)
    expect(t2.notCheckedInCount).toBe(0)
    expect(t2.notCheckedInPeople).toBe(0)
    expect(t2.doorSaleCount).toBe(1)
    expect(t2.doorSalePeople).toBe(3)
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
  // bookingDeadline はローカル時刻の文字列として解釈されるため、
  // toISOString()（UTC）で作ると TZ によって過去/未来が入れ替わる。
  // ローカル時刻で文字列化して環境に依存しないようにする。
  const toLocalInputValue = (d: Date) => {
    const pad = (n: number) => String(n).padStart(2, '0')
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
  }
  const past = toLocalInputValue(new Date(Date.now() - 120_000))
  const future = toLocalInputValue(new Date(Date.now() + 120_000))

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

  it('キャンセル済みもヒットする（画面側で文言を出し分ける）', async () => {
    const { findReservationByCodePhone } = await import('./logic')
    const { data, reservation } = reserveOnline(emptyData(), ['1F-5-6'])
    const cancelled = cancelReservation(data, reservation.id)
    const found = findReservationByCodePhone(cancelled, 'SK-0001', '090-0000-0000')
    expect(found?.id).toBe(reservation.id)
    expect(found?.cancelled).toBe(true)
  })

  it('電話番号は全角数字でもヒットする（正規化して比較）', async () => {
    const { findReservationByCodePhone } = await import('./logic')
    const { data, reservation } = reserveOnline(emptyData(), ['1F-5-6'])
    expect(findReservationByCodePhone(data, 'SK-0001', '０９０-００００-００００')?.id).toBe(
      reservation.id,
    )
    expect(findReservationByCodePhone(data, 'SK-0001', '（０９０）００００-００００')?.id).toBe(
      reservation.id,
    )
  })
})

describe('電話番号の正規化（R3-2）', () => {
  it('全角数字を半角にし、記号を取り除く', async () => {
    const { normalizePhone } = await import('./logic')
    expect(normalizePhone('０９０-１２３４-５６７８')).toBe('09012345678')
    expect(normalizePhone('090-1234-5678')).toBe('09012345678')
    expect(normalizePhone('（090） 1234 5678')).toBe('09012345678')
    expect(normalizePhone('090　1234　5678')).toBe('09012345678')
    expect(normalizePhone('')).toBe('')
  })

  it('形式チェックは10〜11桁の数字のみ通す', async () => {
    const { isValidPhone } = await import('./logic')
    expect(isValidPhone('090-1111-2222')).toBe(true)
    expect(isValidPhone('０９０１１１１２２２２')).toBe(true)
    expect(isValidPhone('03-3545-1111')).toBe(true)
    expect(isValidPhone('abc-def')).toBe(false)
    expect(isValidPhone('090-1234')).toBe(false)
    expect(isValidPhone('090-1234-56789')).toBe(false)
    expect(isValidPhone('')).toBe(false)
  })

  it('国際形式 +81 は国内形式にそろえて保存・判定する', async () => {
    const { normalizePhone, isValidPhone } = await import('./logic')
    expect(normalizePhone('+81-90-1111-2222')).toBe('09011112222')
    expect(isValidPhone('+81-90-1111-2222')).toBe(true)
  })
})

/**
 * R15: 電話番号の厳格チェック用ベクタ表。サーバ側 sakura_valid_phone の
 * 検証（verify-r15-local.mjs）と同じ表を使う（クライアント/サーバ一致）。
 */
describe('電話番号の厳格チェック（R15）', () => {
  const VALID = [
    '09011112222', // 携帯 090
    '08033334444', // 携帯 080
    '07055556666', // 携帯 070
    '05011112222', // IP電話 050
    '0335451111', // 固定電話（東京 03）
    '0120111222', // フリーダイヤル 0120
    '0800111222', // フリーダイヤル 0800
    '090-1111-2222', // ハイフンあり
    '０９０１１１１２２２２', // 全角
    '+81-90-1111-2222', // 国際形式
  ]
  const INVALID = [
    '09000000000', // 0の長い連続
    '09012345678', // 8桁の連番（昇順）
    '0312345678', // 固定電話の形だが連番を含む
    '08098765432', // 8桁の連番（降順）
    '11111111111', // 全桁同一
    '0000000000', // 全桁同一
    '0901112222', // 携帯 090 の桁落ち（10桁）
    '0501112222', // IP 050 の桁落ち（10桁）
    '0801112222', // 携帯 080 の桁落ち（10桁・0800ではない）
    '1234567890', // 0始まりでない
    '090111122223', // 12桁
    '06011112222', // 11桁だが割当のないプレフィックス
    '0310000000', // 固定電話の形だが0の長い連続
    '0901234', // 短すぎる
    '', // 空
    'abcdefghij', // 英字のみ（数字ゼロ）
  ]

  it('正しい番号を通す', async () => {
    const { isValidPhone } = await import('./logic')
    for (const v of VALID) expect(isValidPhone(v), v).toBe(true)
  })

  it('実在しない・形式の違う番号を弾く', async () => {
    const { isValidPhone } = await import('./logic')
    for (const v of INVALID) expect(isValidPhone(v), v).toBe(false)
  })

  it('エラー種別: 形は合っているが偽番号パターンは fake、形が違うものは format（R16・C-2）', async () => {
    const { phoneErrorKind } = await import('./logic')
    // 通る番号は null
    expect(phoneErrorKind('09011112222')).toBeNull()
    expect(phoneErrorKind('0335451111')).toBeNull()
    expect(phoneErrorKind('0800111222')).toBeNull()
    // fake: 形は合っているが、全桁同一・0の連続・連番で弾かれる
    expect(phoneErrorKind('09000000000')).toBe('fake') // 0の長い連続
    expect(phoneErrorKind('09012345678')).toBe('fake') // 連番（昇順）
    expect(phoneErrorKind('08098765432')).toBe('fake') // 連番（降順）
    expect(phoneErrorKind('0312345678')).toBe('fake') // 固定電話の形だが連番（R15規則のまま）
    expect(phoneErrorKind('0310000000')).toBe('fake') // 固定電話の形だが0の長い連続
    // format: 桁数・プレフィックスなど形が合わない
    expect(phoneErrorKind('0901112222')).toBe('format') // 携帯の桁落ち
    expect(phoneErrorKind('1234567890')).toBe('format') // 0始まりでない
    expect(phoneErrorKind('06011112222')).toBe('format') // 割当のないプレフィックス
    expect(phoneErrorKind('090111122223')).toBe('format') // 12桁
    expect(phoneErrorKind('0901234')).toBe('format') // 短すぎる
    expect(phoneErrorKind('')).toBe('format') // 空
  })
})

describe('開場時刻（本日開演カード）', () => {
  it('デフォルト公演は開演30分前が開場', () => {
    const perf = emptyData().performance
    expect(perf.time).toBe('13:00')
    expect(perf.doorsOpen).toBe('12:30')
  })

  it('開場時刻のない旧データは開演から30分前で補完される', () => {
    const data = normalizeAppData({
      performance: {
        name: '旧公演',
        date: '2027-05-01',
        time: '18:00',
        ticketTypes: [{ id: 'adult', name: '大人', price: 2000 }],
        priceNote: '',
        note: '',
      },
      reservations: [],
      blocked: [],
      seq: 0,
    })
    expect(data?.performance.doorsOpen).toBe('17:30')
  })

  it('保存済みの開場時刻はそのまま保持される', () => {
    const data = normalizeAppData({
      performance: {
        name: '公演',
        date: '2027-05-01',
        time: '18:00',
        doorsOpen: '17:15',
        ticketTypes: [{ id: 'adult', name: '大人', price: 2000 }],
        priceNote: '',
        note: '',
      },
      reservations: [],
      blocked: [],
      seq: 0,
    })
    expect(data?.performance.doorsOpen).toBe('17:15')
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

describe('本人キャンセルの可否判定（R4・RPC cancel_reservation と同じ規則）', () => {
  const NOW = new Date('2026-12-01T12:00:00')

  function booked(data: AppData = emptyData()) {
    return createReservation(data, {
      seats: seatsOf(['1F-5-6']),
      name: '山田 花子',
      phone: '09000000000',
      note: '',
      source: 'online',
    })
  }

  it('予約がなければ NOT_FOUND', () => {
    expect(selfCancelEligibility(null, emptyData(), NOW)).toBe('NOT_FOUND')
  })

  it('通常の未払い予約は OK（期限は公演日時が使われる）', () => {
    const { data, reservation } = booked()
    expect(selfCancelLimit(data)?.getTime()).toBe(new Date('2026-12-19T13:00:00').getTime())
    expect(selfCancelEligibility(reservation, data, NOW)).toBe('OK')
  })

  it('キャンセル済みは ALREADY_CANCELLED（支払い済みでも優先される）', () => {
    const { data, reservation } = booked()
    const paid = setPaid(data, reservation.id, true)
    const cancelled = cancelReservation(paid, reservation.id)
    const target = cancelled.reservations.find((r) => r.id === reservation.id)!
    expect(selfCancelEligibility(target, cancelled, NOW)).toBe('ALREADY_CANCELLED')
  })

  it('支払い済みは PAID_LOCKED（来場済みでも優先される）', () => {
    const { data, reservation } = booked()
    const both = setCheckedIn(setPaid(data, reservation.id, true), reservation.id, true)
    const target = both.reservations.find((r) => r.id === reservation.id)!
    expect(selfCancelEligibility(target, both, NOW)).toBe('PAID_LOCKED')
  })

  it('来場済みは CHECKED_IN_LOCKED', () => {
    const { data, reservation } = booked()
    const checked = setCheckedIn(data, reservation.id, true)
    const target = checked.reservations.find((r) => r.id === reservation.id)!
    expect(selfCancelEligibility(target, checked, NOW)).toBe('CHECKED_IN_LOCKED')
  })

  it('予約締切が設定されていれば公演日時より締切が優先され、過ぎれば TOO_LATE', () => {
    const base = booked()
    const data: AppData = { ...base.data, bookingDeadline: '2026-11-30T23:59' }
    expect(selfCancelLimit(data)?.getTime()).toBe(new Date('2026-11-30T23:59').getTime())
    expect(selfCancelEligibility(base.reservation, data, NOW)).toBe('TOO_LATE')
  })

  it('締切が無ければ公演日時を過ぎると TOO_LATE（ちょうどその時刻も不可）', () => {
    const { data, reservation } = booked()
    expect(selfCancelEligibility(reservation, data, new Date('2026-12-19T12:59:59'))).toBe('OK')
    expect(selfCancelEligibility(reservation, data, new Date('2026-12-19T13:00:00'))).toBe(
      'TOO_LATE',
    )
  })
})

describe('開場時刻の整合チェック（R4-5）', () => {
  it('開場が開演より前なら OK、同じ・後なら NG', () => {
    expect(doorsOpenBeforeStart('12:30', '13:00')).toBe(true)
    expect(doorsOpenBeforeStart('13:00', '13:00')).toBe(false)
    expect(doorsOpenBeforeStart('19:00', '18:30')).toBe(false)
  })

  it('解釈できない時刻は NG（保存させない）', () => {
    expect(doorsOpenBeforeStart('', '13:00')).toBe(false)
    expect(doorsOpenBeforeStart('12:30', '')).toBe(false)
  })
})

describe('販売者記録（R4・F6）', () => {
  it('当日販売では販売者が記録され、前後の空白は除かれる', () => {
    const { reservation } = createReservation(emptyData(), {
      seats: seatsOf(['1F-5-6', '1F-5-7']),
      name: '',
      phone: '',
      note: '',
      source: 'door',
      seller: ' 田中 ',
    })
    expect(reservation.seller).toBe('田中')
  })

  it('販売者未選択なら記録されず、Web予約には付けられない', () => {
    const door = createReservation(emptyData(), {
      seats: seatsOf(['1F-5-6']),
      name: '',
      phone: '',
      note: '',
      source: 'door',
    })
    expect(door.reservation.seller).toBeUndefined()
    const online = createReservation(emptyData(), {
      seats: seatsOf(['1F-5-6']),
      name: '山田 花子',
      phone: '09000000000',
      note: '',
      source: 'online',
      seller: '田中',
    })
    expect(online.reservation.seller).toBeUndefined()
  })

  it('販売者別集計は、販売者つきの有効な予約だけを席数・金額で集計する', () => {
    let data = emptyData()
    const sell = (seatIds: string[], seller?: string) => {
      const r = createReservation(data, {
        seats: seatsOf(seatIds),
        name: '',
        phone: '',
        note: '',
        source: 'door',
        seller,
      })
      data = r.data
      return r.reservation
    }
    sell(['1F-5-6', '1F-5-7'], '田中')
    sell(['1F-5-8'], '田中')
    sell(['1F-5-9'], '鈴木')
    sell(['1F-5-10'])
    const cancelled = sell(['1F-5-11'], '田中')
    data = cancelReservation(data, cancelled.id)

    const t = totals(data, ALL_IDS)
    expect(t.bySeller).toEqual([
      { seller: '田中', seatCount: 3, amount: 6000 },
      { seller: '鈴木', seatCount: 1, amount: 2000 },
    ])
  })

  it('販売者名リストは正規化される（空白除去・重複排除）', () => {
    expect(normalizeSellerNames([' 田中 ', '', '鈴木', '田中', 42, null])).toEqual([
      '田中',
      '鈴木',
    ])
    expect(normalizeSellerNames('田中')).toEqual([])
    expect(normalizeSellerNames(undefined)).toEqual([])
  })

  it('normalizeAppData は販売者と予約の販売者を保持する', () => {
    const data = normalizeAppData({
      performance: { ...defaultPerformanceRaw(), sellerNames: ['田中'] },
      reservations: [
        {
          id: 'SK-0001',
          seatIds: ['1F-5-6'],
          items: [{ seatId: '1F-5-6', typeId: 'adult', typeName: '大人', price: 2000 }],
          name: '当日',
          phone: '',
          note: '',
          source: 'door',
          amount: 2000,
          checkedIn: false,
          paid: true,
          cancelled: false,
          createdAt: '2026-11-01T00:00:00.000Z',
          seller: '田中',
        },
      ],
      blocked: [],
      seq: 1,
    })
    expect(data?.performance.sellerNames).toEqual(['田中'])
    expect(data?.reservations[0].seller).toBe('田中')
  })
})

function defaultPerformanceRaw() {
  return {
    name: 'サンプル公演',
    date: '2026-12-19',
    time: '13:00',
    doorsOpen: '12:30',
    ticketTypes: [{ id: 'adult', name: '大人', price: 2000 }],
    priceNote: '',
    note: '',
  }
}

describe('formatSeatList（スタッフ表示の席リスト圧縮）', () => {
  it('同じ列の連続席は範囲に圧縮する', () => {
    expect(
      formatSeatList(['1F-3-11', '1F-3-12', '1F-3-13', '1F-3-14', '1F-3-15', '1F-3-16']),
    ).toBe('1階 3列 11〜16番')
  })

  it('単独席・離れた席はそのまま並べ、列が違えば列ごとに分ける', () => {
    expect(formatSeatList(['1F-3-11'])).toBe('1階 3列 11番')
    expect(formatSeatList(['1F-3-11', '1F-3-13'])).toBe('1階 3列 11番・13番')
    expect(formatSeatList(['1F-3-11', '1F-3-12', '1F-5-1'])).toBe(
      '1階 3列 11〜12番、1階 5列 1番',
    )
  })

  it('入力順に依存せず、階→列→番号の順に整列する（重複は畳む）', () => {
    expect(formatSeatList(['2F-21-8', '1F-3-12', '2F-21-7', '1F-3-11', '1F-3-11'])).toBe(
      '1階 3列 11〜12番、2階 21列 7〜8番',
    )
  })

  it('特殊席（車椅子・親子室・サイド席）はラベルのまま末尾に付ける', () => {
    const mixed = formatSeatList(['1F-3-11', '1F-3-12', 'WC-L', '2F-SIDE-L-3'])
    expect(mixed).toBe('1階 3列 11〜12番、車椅子席 L、2階 L席 3番')
  })

  it('空リストは空文字、未知のIDはそのまま出す', () => {
    expect(formatSeatList([])).toBe('')
    expect(formatSeatList(['UNKNOWN-1'])).toBe('UNKNOWN-1')
  })
})
