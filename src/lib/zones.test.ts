import { describe, expect, it } from 'vitest'
import {
  ALL_SEATS,
  PARENT_ROOM_SEATS,
  WHEELCHAIR_SEATS,
  seatById,
} from '../data/seats'
import { emptyData, setBlockedForSeats, type AppData } from './logic'
import {
  LOW_STOCK_REMAINING,
  ZONE_IDS,
  ZONE_SEAT_IDS,
  assignZoneSeats,
  countAvailableInZone,
  describeSelection,
  resolveZoneTap,
  summarizeSeatIds,
  zoneAvailability,
  zoneOfSeat,
  type ZoneId,
} from './zones'

const ALL_IDS = ALL_SEATS.map((s) => s.id)
const SPECIAL_IDS = new Set(
  [...WHEELCHAIR_SEATS, ...PARENT_ROOM_SEATS].map((s) => s.id),
)

/** 指定した席「以外」をすべて販売終了にして空席を絞る */
function onlyAvailable(availableIds: string[]): AppData {
  const keep = new Set(availableIds)
  return setBlockedForSeats(
    emptyData(),
    ALL_IDS.filter((id) => !keep.has(id)),
    true,
  )
}

function blockSeats(data: AppData, ids: string[]): AppData {
  return setBlockedForSeats(data, ids, true)
}

/** 席IDがゾーンのセグメント内で連続しているか（グループ単位の検証用） */
function expectContiguousGroups(seatIds: string[], groups: string[][]) {
  expect(groups.flat().sort()).toEqual([...seatIds].sort())
  for (const group of groups) {
    const seats = group.map((id) => seatById(id))
    const first = seats[0]
    for (const s of seats) {
      expect(s.floor).toBe(first.floor)
      expect(s.row).toBe(first.row)
      expect(s.block).toBe(first.block)
      expect(s.kind).toBe(first.kind)
    }
    const numbers = seats.map((s) => s.number ?? 0).sort((a, b) => a - b)
    for (let i = 1; i < numbers.length; i++) {
      expect(numbers[i]).toBe(numbers[i - 1] + 1)
    }
  }
}

describe('ゾーン定義: 席数と振り分け', () => {
  it('各ゾーンの席数が仕様どおりで、合計461席', () => {
    const expected: Record<ZoneId, number> = {
      A: 62,
      B: 95,
      C: 72,
      D: 46,
      E: 24,
      F: 46,
      G: 24,
      H: 78,
      I: 14,
    }
    let total = 0
    for (const z of ZONE_IDS) {
      expect(ZONE_SEAT_IDS[z]).toHaveLength(expected[z])
      total += ZONE_SEAT_IDS[z].length
    }
    expect(total).toBe(461)
  })

  it('販売可能な全席がちょうど1つのゾーンに属する', () => {
    const seen = new Map<string, ZoneId>()
    for (const z of ZONE_IDS) {
      for (const id of ZONE_SEAT_IDS[z]) {
        expect(seen.has(id)).toBe(false)
        seen.set(id, z)
      }
    }
    for (const seat of ALL_SEATS) {
      if (SPECIAL_IDS.has(seat.id)) continue
      expect(zoneOfSeat(seat)).not.toBeNull()
      expect(seen.get(seat.id)).toBe(zoneOfSeat(seat))
    }
    expect(seen.size).toBe(461)
  })

  it('車椅子席・親子室はどのゾーンにも属さない', () => {
    for (const id of SPECIAL_IDS) {
      expect(zoneOfSeat(seatById(id))).toBeNull()
      for (const z of ZONE_IDS) expect(ZONE_SEAT_IDS[z]).not.toContain(id)
    }
  })

  it('代表席のゾーン判定', () => {
    expect(zoneOfSeat(seatById('1F-1-10'))).toBe('A') // 1階中央1列
    expect(zoneOfSeat(seatById('1F-4-20'))).toBe('A')
    expect(zoneOfSeat(seatById('1F-7-12'))).toBe('B') // 1階中央7列
    expect(zoneOfSeat(seatById('1F-13-10'))).toBe('C') // 13列は中央のみ
    expect(zoneOfSeat(seatById('1F-15-21'))).toBe('C')
    expect(zoneOfSeat(seatById('1F-10-3'))).toBe('D') // 1階左10列
    expect(zoneOfSeat(seatById('1F-16-2'))).toBe('E') // 1階左16列
    expect(zoneOfSeat(seatById('1F-2-24'))).toBe('F') // 1階右2列
    expect(zoneOfSeat(seatById('1F-16-25'))).toBe('G') // 1階右16列
    expect(zoneOfSeat(seatById('2F-22-12'))).toBe('H')
    expect(zoneOfSeat(seatById('2F-SIDE-L-3'))).toBe('I')
    expect(zoneOfSeat(seatById('2F-SIDE-R-7'))).toBe('I')
  })
})

describe('ゾーン空き状況', () => {
  it('空きホールでは全ゾーンが満席でも残りわずかでもない', () => {
    const data = emptyData()
    for (const z of ZONE_IDS) {
      const a = zoneAvailability(data, z)
      expect(a.available).toBe(a.total)
      expect(a.soldOut).toBe(false)
      expect(a.low).toBe(false)
    }
  })

  it('満席ゾーンは soldOut、全ゾーン合計の空席は461', () => {
    const data = blockSeats(emptyData(), ZONE_SEAT_IDS.E)
    const a = zoneAvailability(data, 'E')
    expect(a.available).toBe(0)
    expect(a.soldOut).toBe(true)
    expect(a.low).toBe(false)
    let total = 0
    for (const z of ZONE_IDS) total += countAvailableInZone(data, z)
    expect(total).toBe(461 - 24)
  })

  it('残りわずかは「残り10席以下」で判定する', () => {
    // ゾーンI（14席）: 残り11席では通常、残り10席で残りわずか
    const keep11 = ZONE_SEAT_IDS.I.slice(0, 11)
    const data11 = onlyAvailable(keep11)
    expect(zoneAvailability(data11, 'I').available).toBe(11)
    expect(zoneAvailability(data11, 'I').low).toBe(false)
    const keep10 = ZONE_SEAT_IDS.I.slice(0, LOW_STOCK_REMAINING)
    const data10 = onlyAvailable(keep10)
    expect(zoneAvailability(data10, 'I').available).toBe(10)
    expect(zoneAvailability(data10, 'I').low).toBe(true)
  })
})

describe('ゾーンの仮選択（R14: resolveZoneTap）', () => {
  const avail = (available: number) => ({
    total: 24,
    available,
    soldOut: available === 0,
    low: available > 0 && available <= LOW_STOCK_REMAINING,
  })

  it('未選択でタップすると仮選択になる', () => {
    expect(resolveZoneTap(null, 'G', avail(24), 2)).toEqual({ kind: 'select', zone: 'G' })
  })

  it('別のゾーンをタップすると仮選択が切り替わる', () => {
    expect(resolveZoneTap('G', 'H', avail(78), 2)).toEqual({ kind: 'select', zone: 'H' })
  })

  it('仮選択中のゾーンをもう一度タップすると解除になる', () => {
    expect(resolveZoneTap('G', 'G', avail(24), 2)).toEqual({ kind: 'deselect' })
  })

  it('人数分を用意できないゾーンは仮選択せず案内になる（残り席数を返す）', () => {
    expect(resolveZoneTap(null, 'B', avail(2), 3)).toEqual({
      kind: 'insufficient',
      zone: 'B',
      remaining: 2,
    })
    // 仮選択があっても、切り替え先が不足なら案内が優先される
    expect(resolveZoneTap('A', 'B', avail(1), 2)).toEqual({
      kind: 'insufficient',
      zone: 'B',
      remaining: 1,
    })
  })

  it('残り席数がちょうど人数分なら仮選択できる', () => {
    expect(resolveZoneTap(null, 'B', avail(3), 3)).toEqual({ kind: 'select', zone: 'B' })
  })
})

describe('ゾーン自動割当: 基本', () => {
  it('空きホールではどのゾーン・人数でもゾーン内だけから割り当てる（5名までは連続）', () => {
    for (const z of ZONE_IDS) {
      for (const size of [1, 2, 3, 5]) {
        const a = assignZoneSeats(emptyData(), z, size)
        expect(a).not.toBeNull()
        expect(a!.zone).toBe(z)
        expect(a!.seatIds).toHaveLength(size)
        expect(a!.seatIds.every((id) => zoneOfSeat(seatById(id)) === z)).toBe(true)
        expect(a!.seatIds.some((id) => SPECIAL_IDS.has(id))).toBe(false)
        expect(a!.split).toBe(false)
        expect(a!.restricted).toBe(false)
        expectContiguousGroups(a!.seatIds, a!.groups)
      }
    }
  })

  it('8名: 大きいブロックのあるゾーンは連続、細いブロックのゾーンはゾーン内で分割', () => {
    for (const z of ['A', 'B', 'C', 'H'] as ZoneId[]) {
      const a = assignZoneSeats(emptyData(), z, 8)
      expect(a).not.toBeNull()
      expect(a!.split).toBe(false)
      expectContiguousGroups(a!.seatIds, a!.groups)
    }
    // D〜G は1ブロック最大5席、I は1列7席なので、8名はゾーン内分割になる
    for (const z of ['D', 'E', 'F', 'G', 'I'] as ZoneId[]) {
      const a = assignZoneSeats(emptyData(), z, 8)
      expect(a).not.toBeNull()
      expect(a!.seatIds).toHaveLength(8)
      expect(a!.split).toBe(true)
      expect(a!.seatIds.every((id) => zoneOfSeat(seatById(id)) === z)).toBe(true)
      expectContiguousGroups(a!.seatIds, a!.groups)
    }
  })

  it('ゾーンB（おすすめ）の2名は1階中央5〜10列から割り当てられる', () => {
    const a = assignZoneSeats(emptyData(), 'B', 2)
    expect(a).not.toBeNull()
    for (const id of a!.seatIds) {
      const seat = seatById(id)
      expect(seat.floor).toBe(1)
      expect(seat.block).toBe('center')
      expect(seat.row).toBeGreaterThanOrEqual(5)
      expect(seat.row).toBeLessThanOrEqual(10)
    }
  })

  it('他ゾーンに空席があっても、選んだゾーン以外からは絶対に割り当てない', () => {
    // ゾーンBの2席だけ空席。他ゾーンは満席扱い
    const data = onlyAvailable(['1F-7-12', '1F-7-13'])
    expect(assignZoneSeats(data, 'A', 2)).toBeNull()
    expect(assignZoneSeats(data, 'H', 1)).toBeNull()
    expect(assignZoneSeats(data, 'B', 3)).toBeNull() // 残り2席 < 3名
    const a = assignZoneSeats(data, 'B', 2)
    expect(a!.seatIds.sort()).toEqual(['1F-7-12', '1F-7-13'])
  })

  it('人数が0以下なら割当なし', () => {
    expect(assignZoneSeats(emptyData(), 'B', 0)).toBeNull()
  })

  it('除外した席（SEAT_TAKEN再割当用）は使わず、同じゾーンで組み直す', () => {
    const first = assignZoneSeats(emptyData(), 'B', 2)
    expect(first).not.toBeNull()
    const second = assignZoneSeats(emptyData(), 'B', 2, first!.seatIds)
    expect(second).not.toBeNull()
    expect(second!.seatIds.some((id) => first!.seatIds.includes(id))).toBe(false)
    expect(second!.seatIds.every((id) => zoneOfSeat(seatById(id)) === 'B')).toBe(true)
  })
})

describe('ゾーン自動割当: 詰め込み（パッキング）', () => {
  it('1席だけ取り残す配置は選ばない（空席の連なりの端に寄せる）', () => {
    // ゾーンB内: 1階7列センター（6〜21番）だけを空け、6番を占有済みにして連なりを7〜21にする。
    // 2名なら 7・8番（左端寄せ）が正解で、8・9番（7番を1席残す）は選ばれない。
    const segment = ALL_SEATS.filter(
      (s) => s.floor === 1 && s.row === 7 && s.block === 'center',
    ).map((s) => s.id)
    let data = onlyAvailable(segment)
    data = blockSeats(data, ['1F-7-6'])
    const a = assignZoneSeats(data, 'B', 2)
    expect(a!.seatIds).toEqual(['1F-7-7', '1F-7-8'])
  })

  it('右側に1席だけ残す配置も避ける', () => {
    const segment = ALL_SEATS.filter(
      (s) => s.floor === 1 && s.row === 7 && s.block === 'center',
    ).map((s) => s.id)
    let data = onlyAvailable(segment)
    data = blockSeats(data, ['1F-7-21'])
    const a = assignZoneSeats(data, 'B', 2)
    const nums = a!.seatIds.map((id) => seatById(id).number ?? 0)
    const min = Math.min(...nums)
    const max = Math.max(...nums)
    // 連なりは 6〜20。左に残る席数 = min-6、右に残る席数 = 20-max。どちらも1であってはならない
    expect(min - 6).not.toBe(1)
    expect(20 - max).not.toBe(1)
  })

  it('空席の連なりを丸ごと使い切る配置を優先する（部分的に埋まった列から詰める）', () => {
    // ゾーンD: 1列左（3席ちょうどの連なり）と4列左（5席の連なり）だけ空席。
    // 3名なら、5席の連なりを割るより3席ちょうどの連なりを使い切る配置が正解。
    const data = onlyAvailable([
      '1F-1-3',
      '1F-1-4',
      '1F-1-5',
      '1F-4-1',
      '1F-4-2',
      '1F-4-3',
      '1F-4-4',
      '1F-4-5',
    ])
    const a = assignZoneSeats(data, 'D', 3)
    expect(a!.seatIds).toEqual(['1F-1-3', '1F-1-4', '1F-1-5'])
  })

  it('占有済みにくっつけて埋め、空席の塊を割らない', () => {
    // ゾーンB: 7列センターの連なり 6〜21 のうち 6・7番が占有済み。
    // 2名の割当は塊の途中（例: 13・14番）ではなく、占有済みに接する 8・9番になる。
    const segment = ALL_SEATS.filter(
      (s) => s.floor === 1 && s.row === 7 && s.block === 'center',
    ).map((s) => s.id)
    let data = onlyAvailable(segment)
    data = blockSeats(data, ['1F-7-6', '1F-7-7'])
    const a = assignZoneSeats(data, 'B', 2)
    expect(a!.seatIds).toEqual(['1F-7-8', '1F-7-9'])
  })
})

describe('ゾーン自動割当: 分割・売り切れ・見切れ', () => {
  it('ゾーン内に連続席が無い場合は2グループの分割割当を出す（ゾーン外には出ない）', () => {
    const data = onlyAvailable(['1F-7-12', '1F-7-13', '1F-8-12', '1F-8-13'])
    const a = assignZoneSeats(data, 'B', 4)
    expect(a).not.toBeNull()
    expect(a!.split).toBe(true)
    expect(a!.groups).toHaveLength(2)
    expect(a!.groups.map((g) => g.length).sort()).toEqual([2, 2])
    expect(new Set(a!.seatIds).size).toBe(4)
  })

  it('ほぼ満席のゾーン: 残席がバラけていれば分割、それ未満なら割当なし', () => {
    // ゾーンI: L列に2席、R列に1席だけ残す
    const data = onlyAvailable(['2F-SIDE-L-1', '2F-SIDE-L-2', '2F-SIDE-R-1'])
    const a3 = assignZoneSeats(data, 'I', 3)
    expect(a3).not.toBeNull()
    expect(a3!.seatIds.sort()).toEqual(
      ['2F-SIDE-L-1', '2F-SIDE-L-2', '2F-SIDE-R-1'].sort(),
    )
    expect(assignZoneSeats(data, 'I', 4)).toBeNull()
  })

  it('見切れ席は通常の割当に含まれない（通常席がある限り）', () => {
    const a = assignZoneSeats(emptyData(), 'H', 4)
    expect(a!.restricted).toBe(false)
    expect(a!.seatIds.some((id) => seatById(id).restrictedView)).toBe(false)
  })

  it('見切れ席を含むブロックしか残っていない場合のみ、見切れ込みで割り当てる', () => {
    const data = onlyAvailable(['2F-21-3', '2F-21-4', '2F-21-5'])
    const a = assignZoneSeats(data, 'H', 3)
    expect(a).not.toBeNull()
    expect(a!.restricted).toBe(true)
    expect(a!.seatIds).toContain('2F-21-3')
  })

  it('占有が進んだゾーンでも、実際に空いている席だけが割り当てられる', () => {
    const data = blockSeats(emptyData(), ZONE_SEAT_IDS.B)
    expect(assignZoneSeats(data, 'B', 2)).toBeNull()
    const a = assignZoneSeats(data, 'A', 2)
    expect(a!.seatIds.every((id) => zoneOfSeat(seatById(id)) === 'A')).toBe(true)
  })
})

describe('describeSelection / summarizeSeatIds', () => {
  it('選択席からゾーン・分割・見切れを導ける', () => {
    expect(describeSelection(['1F-7-12', '1F-7-13'])).toMatchObject({
      zone: 'B',
      split: false,
      restricted: false,
    })
    expect(describeSelection(['1F-7-12', '1F-8-12']).split).toBe(true)
    expect(describeSelection(['2F-21-3'])).toMatchObject({
      zone: 'H',
      restricted: true,
    })
    expect(describeSelection(['2F-SIDE-L-1', '2F-SIDE-L-2'])).toMatchObject({
      zone: 'I',
      split: false,
    })
  })

  it('席要約は連続番号を範囲表記に圧縮する', () => {
    expect(summarizeSeatIds(['1F-7-12', '1F-7-13', '1F-7-14'])).toBe(
      '1階 7列 12〜14番',
    )
    expect(summarizeSeatIds(['1F-7-12'])).toBe('1階 7列 12番')
    expect(summarizeSeatIds(['1F-7-12', '1F-8-12'])).toBe(
      '1階 7列 12番、1階 8列 12番',
    )
  })
})
