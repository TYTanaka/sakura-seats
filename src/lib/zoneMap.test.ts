import { describe, expect, it } from 'vitest'
import { ALL_SEATS } from '../data/seats'
import { emptyData, setBlockedForSeats, type AppData } from './logic'
import { ZONE_SEAT_IDS, type ZoneId } from './zones'
import { buildZoneMap, zoneAnchors } from './zoneMap'

const EXPECTED: Record<ZoneId, number> = {
  A: 62, B: 95, C: 72, D: 46, E: 24, F: 46, G: 24, H: 78, I: 14,
}

function allCells(data: AppData) {
  return buildZoneMap(data).flatMap((f) => f.rows.flatMap((r) => r.blocks.flatMap((b) => b.cells)))
}

describe('ゾーン選択マップのモデル', () => {
  it('全469席をセルとして持ち、ゾーン別席数が zones.ts と一致する', () => {
    const cells = allCells(emptyData())
    expect(cells.length).toBe(469)
    expect(new Set(cells.map((c) => c.seatId)).size).toBe(469)
    for (const z of Object.keys(EXPECTED) as ZoneId[]) {
      expect(cells.filter((c) => c.zone === z).length).toBe(EXPECTED[z])
      expect(cells.filter((c) => c.zone === z).map((c) => c.seatId).sort()).toEqual(
        [...ZONE_SEAT_IDS[z]].sort(),
      )
    }
    // 車椅子2＋親子室6はどのゾーンにも属さない
    expect(cells.filter((c) => c.zone === null).length).toBe(8)
  })

  it('空きホールでは全席 available', () => {
    const cells = allCells(emptyData())
    expect(cells.every((c) => c.status === 'available')).toBe(true)
  })

  it('販売終了にした席は blocked として反映される', () => {
    const data = setBlockedForSeats(emptyData(), ['1F-7-12', '2F-22-10'], true)
    const cells = allCells(data)
    expect(cells.find((c) => c.seatId === '1F-7-12')?.status).toBe('blocked')
    expect(cells.find((c) => c.seatId === '2F-22-10')?.status).toBe('blocked')
    expect(cells.find((c) => c.seatId === '1F-7-13')?.status).toBe('available')
  })

  it('フロア構成は 1階=17行（通常16＋特殊） / 2階=4行（通常3＋サイド）', () => {
    const floors = buildZoneMap(emptyData())
    expect(floors.map((f) => f.floor)).toEqual([1, 2])
    expect(floors[0].rows.length).toBe(17)
    expect(floors[1].rows.length).toBe(4)
  })
})

describe('ゾーンバッジのアンカー', () => {
  const anchors = zoneAnchors(buildZoneMap(emptyData()))
  const byZone = new Map(anchors.map((a) => [a.zone, a]))

  it('9ゾーン分のアンカーがある', () => {
    expect(anchors.length).toBe(9)
  })

  it('中央ゾーンは前→中央→後方の順に下がる（A < B < C）', () => {
    expect(byZone.get('A')!.yPct).toBeLessThan(byZone.get('B')!.yPct)
    expect(byZone.get('B')!.yPct).toBeLessThan(byZone.get('C')!.yPct)
  })

  it('左右ゾーンは中央より外側にある（D・E < A < F・G）', () => {
    expect(byZone.get('D')!.xPct).toBeLessThan(byZone.get('A')!.xPct)
    expect(byZone.get('E')!.xPct).toBeLessThan(byZone.get('A')!.xPct)
    expect(byZone.get('F')!.xPct).toBeGreaterThan(byZone.get('A')!.xPct)
    expect(byZone.get('G')!.xPct).toBeGreaterThan(byZone.get('A')!.xPct)
  })

  it('H・I は2階のアンカー', () => {
    expect(byZone.get('H')!.floor).toBe(2)
    expect(byZone.get('I')!.floor).toBe(2)
    // I（サイド席行）は H（21〜23列）より下
    expect(byZone.get('I')!.yPct).toBeGreaterThan(byZone.get('H')!.yPct)
  })

  it('すべてのアンカーが 0〜100% の範囲内', () => {
    for (const a of anchors) {
      expect(a.xPct).toBeGreaterThan(0)
      expect(a.xPct).toBeLessThan(100)
      expect(a.yPct).toBeGreaterThan(0)
      expect(a.yPct).toBeLessThan(100)
    }
  })
})

// ALL_SEATS を使う前提の健全性（import 漏れ防止ではなく件数の突き合わせ）
describe('前提データ', () => {
  it('ALL_SEATS は469席', () => {
    expect(ALL_SEATS.length).toBe(469)
  })
})
