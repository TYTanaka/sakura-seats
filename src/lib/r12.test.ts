import { describe, expect, it } from 'vitest'
import { ALL_SEATS, seatById } from '../data/seats'
import {
  assignSeatsToReservation,
  clearReservationSeats,
  createReservation,
  createZoneReservation,
  emptyData,
  isUnassignedZoneBooking,
  normalizeAppData,
  setBlockedForSeats,
  setPaid,
  totals,
  type AppData,
} from './logic'
import {
  ZONE_SEAT_IDS,
  assignZoneSeats,
  reservationSeatDisplay,
  zoneAvailability,
  zoneHoldCount,
  zoneOfSeat,
  type ZoneId,
} from './zones'

const ALL_IDS = ALL_SEATS.map((s) => s.id)

/** 指定した席「以外」をすべて販売終了にして空席を絞る */
function onlyAvailable(availableIds: string[]): AppData {
  const keep = new Set(availableIds)
  return setBlockedForSeats(
    emptyData(),
    ALL_IDS.filter((id) => !keep.has(id)),
    true,
  )
}

function zoneBooking(
  data: AppData,
  zone: ZoneId,
  typeIds: string[],
  name = '山田 花子',
) {
  return createZoneReservation(data, {
    zone,
    typeIds,
    name,
    phone: '09000000000',
    note: '',
  })
}

describe('createZoneReservation（R12: 席は確定しない）', () => {
  it('明細の seatId は空文字・seatIds は空で、ゾーンと金額スナップショットを持つ', () => {
    const { reservation } = zoneBooking(emptyData(), 'B', ['adult', 'child'])
    expect(reservation.zone).toBe('B')
    expect(reservation.seatIds).toEqual([])
    expect(reservation.items).toHaveLength(2)
    expect(reservation.items.every((i) => i.seatId === '')).toBe(true)
    expect(reservation.items.map((i) => i.typeName)).toEqual(['大人', '子供'])
    expect(reservation.amount).toBe(3000)
    expect(reservation.paid).toBe(false)
    expect(reservation.source).toBe('online')
    expect(isUnassignedZoneBooking(reservation)).toBe(true)
    expect(reservation.qrToken).toBeTruthy()
  })

  it('人数0・9名以上・名前なしは例外', () => {
    expect(() => zoneBooking(emptyData(), 'B', [])).toThrow()
    expect(() =>
      zoneBooking(emptyData(), 'B', Array(9).fill('adult')),
    ).toThrow(/8名/)
    expect(() =>
      createZoneReservation(emptyData(), {
        zone: 'B',
        typeIds: ['adult'],
        name: ' ',
        phone: '09000000000',
        note: '',
      }),
    ).toThrow(/お名前/)
  })

  it('localStorage 往復（normalizeAppData）でゾーン予約が消えない', () => {
    const { data } = zoneBooking(emptyData(), 'E', ['adult', 'adult'])
    const roundTripped = normalizeAppData(JSON.parse(JSON.stringify(data)))
    expect(roundTripped).not.toBeNull()
    expect(roundTripped!.reservations).toHaveLength(1)
    const res = roundTripped!.reservations[0]
    expect(res.zone).toBe('E')
    expect(res.seatIds).toEqual([])
    expect(res.items).toHaveLength(2)
    expect(res.amount).toBe(4000)
  })

  it('ゾーンの無い「席なし予約」は従来どおり不正として捨てられる', () => {
    const raw = {
      performance: emptyData().performance,
      reservations: [
        {
          id: 'SK-0001',
          seatIds: [],
          items: [{ seatId: '', typeId: 'adult', typeName: '大人', price: 2000 }],
          name: '誰か',
          phone: '09000000000',
          note: '',
          source: 'online',
          amount: 2000,
          checkedIn: false,
          paid: false,
          cancelled: false,
          createdAt: '2026-11-01T00:00:00.000Z',
        },
      ],
      blocked: [],
      seq: 1,
      bookingDeadline: null,
    }
    const normalized = normalizeAppData(raw)
    expect(normalized!.reservations).toHaveLength(0)
  })
})

describe('カウントホールド（zoneAvailability / zoneHoldCount）', () => {
  it('未払いのゾーン予約は人数分だけ残席を減らす（特定の席は押さえない）', () => {
    const before = zoneAvailability(emptyData(), 'I')
    expect(before.available).toBe(14)
    const { data } = zoneBooking(emptyData(), 'I', ['adult', 'adult', 'child'])
    expect(zoneHoldCount(data, 'I')).toBe(3)
    const after = zoneAvailability(data, 'I')
    expect(after.available).toBe(11)
    // 席そのものは空席のまま（割当はされていない）
    expect(after.total).toBe(14)
  })

  it('キャンセルしたゾーン予約はホールドしない', () => {
    const { data, reservation } = zoneBooking(emptyData(), 'I', ['adult', 'adult'])
    const cancelled: AppData = {
      ...data,
      reservations: data.reservations.map((r) =>
        r.id === reservation.id ? { ...r, cancelled: true } : r,
      ),
    }
    expect(zoneHoldCount(cancelled, 'I')).toBe(0)
    expect(zoneAvailability(cancelled, 'I').available).toBe(14)
  })

  it('ホールドだけで満席になるゾーンは soldOut になる', () => {
    // ゾーンE（24席）のうち3席だけ販売し、2名の未割当予約で残り1にする
    const keep = ZONE_SEAT_IDS.E.slice(0, 3)
    let data = onlyAvailable([...keep, ...ZONE_SEAT_IDS.A])
    const booked = zoneBooking(data, 'E', ['adult', 'adult'])
    data = booked.data
    expect(zoneAvailability(data, 'E').available).toBe(1)
    const booked2 = zoneBooking(data, 'E', ['adult'])
    expect(zoneAvailability(booked2.data, 'E').soldOut).toBe(true)
  })

  it('クラウド集計（data.zoneHolds）があればそちらを優先し、二重に数えない', () => {
    const { data } = zoneBooking(emptyData(), 'B', ['adult', 'adult'])
    const withHolds: AppData = { ...data, zoneHolds: { B: 10 } }
    expect(zoneHoldCount(withHolds, 'B')).toBe(10)
    expect(zoneAvailability(withHolds, 'B').available).toBe(95 - 10)
  })

  it('従来型の未払い予約（席あり）はホールドではなく割当済みとして減る（grandfathering）', () => {
    const legacy = createReservation(emptyData(), {
      seats: [
        { seatId: '1F-5-6', typeId: 'adult' },
        { seatId: '1F-5-7', typeId: 'adult' },
      ],
      name: '従来 太郎',
      phone: '09000000000',
      note: '',
      source: 'online',
    })
    expect(zoneOfSeat(seatById('1F-5-6'))).toBe('B')
    expect(zoneHoldCount(legacy.data, 'B')).toBe(0)
    expect(zoneAvailability(legacy.data, 'B').available).toBe(93)
  })
})

describe('支払い時の割当（assignSeatsToReservation / clearReservationSeats）', () => {
  it('割当は明細の順序のまま席を入れ、人数と合わない席数は例外', () => {
    const { data, reservation } = zoneBooking(emptyData(), 'B', ['adult', 'child'])
    expect(() => assignSeatsToReservation(data, reservation.id, ['1F-5-6'])).toThrow()
    const next = assignSeatsToReservation(data, reservation.id, ['1F-5-6', '1F-5-7'])
    const assigned = next.reservations[0]
    expect(assigned.seatIds).toEqual(['1F-5-6', '1F-5-7'])
    expect(assigned.items.map((i) => i.seatId)).toEqual(['1F-5-6', '1F-5-7'])
    expect(assigned.items.map((i) => i.typeName)).toEqual(['大人', '子供'])
    expect(isUnassignedZoneBooking(assigned)).toBe(false)
  })

  it('割当解除で席が空に戻り、ホールドとして再び数えられる', () => {
    const { data, reservation } = zoneBooking(emptyData(), 'B', ['adult', 'adult'])
    const assigned = assignSeatsToReservation(data, reservation.id, ['1F-5-6', '1F-5-7'])
    expect(zoneHoldCount(assigned, 'B')).toBe(0)
    const cleared = clearReservationSeats(assigned, reservation.id)
    const res = cleared.reservations[0]
    expect(res.seatIds).toEqual([])
    expect(res.items.every((i) => i.seatId === '')).toBe(true)
    expect(zoneHoldCount(cleared, 'B')).toBe(2)
  })

  it('支払い時の割当はゾーン内の物理空席から行う（他者のホールドは席を塞がない）', () => {
    // ゾーンEで3席だけ販売。2名の未割当予約があっても、割当は物理空席から行える
    const keep = ZONE_SEAT_IDS.E.slice(0, 3)
    let data = onlyAvailable([...keep, ...ZONE_SEAT_IDS.A])
    const first = zoneBooking(data, 'E', ['adult', 'adult'], '先客')
    data = first.data
    const second = zoneBooking(data, 'E', ['adult'], '後客')
    data = second.data
    const assignment = assignZoneSeats(data, 'E', 2)
    expect(assignment).not.toBeNull()
    expect(assignment!.seatIds).toHaveLength(2)
    expect(assignment!.seatIds.every((id) => keep.includes(id))).toBe(true)
  })
})

describe('集計（totals は人数で数える）', () => {
  it('未払いのゾーン予約は人数分の未払い席数・金額に数えられる', () => {
    const { data } = zoneBooking(emptyData(), 'B', ['adult', 'child'])
    const t = totals(data, ALL_IDS)
    expect(t.reservationCount).toBe(1)
    expect(t.reservedSeatCount).toBe(2)
    expect(t.paidSeatCount).toBe(0)
    expect(t.unpaidTotal).toBe(3000)
    const byType = Object.fromEntries(t.byType.map((r) => [r.typeName, r]))
    expect(byType['大人'].reservedSeatCount).toBe(1)
    expect(byType['子供'].reservedSeatCount).toBe(1)
  })

  it('割当＋支払い済みで売上側へ移る', () => {
    const { data, reservation } = zoneBooking(emptyData(), 'B', ['adult', 'child'])
    const assigned = assignSeatsToReservation(data, reservation.id, ['1F-5-6', '1F-5-7'])
    const paid = setPaid(assigned, reservation.id, true)
    const t = totals(paid, ALL_IDS)
    expect(t.paidSeatCount).toBe(2)
    expect(t.salesTotal).toBe(3000)
    expect(t.reservedSeatCount).toBe(0)
  })
})

describe('reservationSeatDisplay（表示規則）', () => {
  it('未割当のゾーン予約: ゾーン名と「席未確定」だけを表示し、席番号は出さない', () => {
    const { reservation } = zoneBooking(emptyData(), 'B', ['adult', 'adult'])
    const display = reservationSeatDisplay(reservation)
    expect(display.isZone).toBe(true)
    expect(display.assigned).toBe(false)
    expect(display.text).toContain('ゾーンB')
    expect(display.text).toContain('席未確定')
    expect(display.text).toContain('2名')
    expect(display.text).not.toMatch(/\d+F-/)
    expect(display.text).not.toContain('列')
  })

  it('割当済みのゾーン予約: 従来どおり席を表示する', () => {
    const { data, reservation } = zoneBooking(emptyData(), 'B', ['adult', 'adult'])
    const assigned = assignSeatsToReservation(data, reservation.id, ['1F-5-6', '1F-5-7'])
    const display = reservationSeatDisplay(assigned.reservations[0])
    expect(display.isZone).toBe(true)
    expect(display.assigned).toBe(true)
    expect(display.text).toContain('1階 5列')
  })

  it('従来型の予約: 席を表示し、ゾーン扱いにはならない', () => {
    const legacy = createReservation(emptyData(), {
      seats: [{ seatId: '1F-5-6', typeId: 'adult' }],
      name: '従来 太郎',
      phone: '09000000000',
      note: '',
      source: 'online',
    })
    const display = reservationSeatDisplay(legacy.reservation)
    expect(display.isZone).toBe(false)
    expect(display.assigned).toBe(true)
    expect(display.text).toContain('1階 5列')
  })
})
