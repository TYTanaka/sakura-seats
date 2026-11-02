import { describe, expect, it } from 'vitest'
import { ALL_SEATS } from '../data/seats'
import { emptyData, setBlockedForSeats, type AppData } from './logic'
import { ZONE_SEAT_IDS, type ZoneId } from './zones'
import { buildZoneMap, buildZoneMapLayout, zoneAnchors } from './zoneMap'

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

describe('公式図レイアウト（R13）', () => {
  const layout = buildZoneMapLayout(emptyData())
  const byId = new Map(layout.cells.map((c) => [c.seatId, c]))
  const cell = (id: string) => byId.get(id)!

  it('全469席に座標が付き、ゾーン別席数は不変', () => {
    expect(layout.cells.length).toBe(469)
    expect(new Set(layout.cells.map((c) => c.seatId)).size).toBe(469)
    for (const z of Object.keys(EXPECTED) as ZoneId[]) {
      expect(layout.cells.filter((c) => c.zone === z).length).toBe(EXPECTED[z])
    }
    expect(layout.cells.filter((c) => c.zone === null).length).toBe(8)
    for (const c of layout.cells) {
      expect(c.cx).toBeGreaterThan(0)
      expect(c.cx).toBeLessThan(layout.width)
      expect(c.cy).toBeGreaterThan(0)
      expect(c.cy).toBeLessThan(layout.height)
    }
  })

  it('1階左右ブロックは扇形に傾斜する（外側ほど後方＝cy が大きい）', () => {
    // 左ブロック7列: 番号が小さい（外側）ほど下がる
    expect(cell('1F-7-1').cy).toBeGreaterThan(cell('1F-7-3').cy)
    expect(cell('1F-7-3').cy).toBeGreaterThan(cell('1F-7-5').cy)
    expect(cell('1F-7-1').rotate).toBeLessThan(0)
    expect(cell('1F-7-1').cx).toBeLessThan(cell('1F-7-5').cx)
    // 右ブロックは鏡像
    expect(cell('1F-7-26').cy).toBeGreaterThan(cell('1F-7-24').cy)
    expect(cell('1F-7-24').cy).toBeGreaterThan(cell('1F-7-22').cy)
    expect(cell('1F-7-26').rotate).toBeGreaterThan(0)
    // 中央ブロックは水平
    expect(cell('1F-7-6').rotate).toBe(0)
    expect(cell('1F-7-6').cy).toBe(cell('1F-7-21').cy)
    // 後方の列ほど扇が開く（傾きが大きい）
    expect(Math.abs(cell('1F-15-1').rotate)).toBeGreaterThan(Math.abs(cell('1F-2-2').rotate))
  })

  it('車椅子席は左ブロックと中央ブロックの間（11〜12列）にある', () => {
    const wc = cell('WC-L')
    expect(wc.cx).toBeGreaterThan(cell('1F-11-5').cx) // 左ブロックの内側端より右
    expect(wc.cx).toBeLessThan(cell('1F-11-10').cx) // 中央ブロック先頭（10番）より左
    expect(wc.cy).toBeGreaterThan(cell('1F-11-12').cy)
    expect(wc.cy).toBeLessThan(cell('1F-12-12').cy)
    expect(cell('WC-R').cx).toBeGreaterThan(wc.cx)
  })

  it('12列と13列の間には横通路ぶんの広い間隔がある', () => {
    const gapAisle = cell('1F-13-12').cy - cell('1F-12-12').cy
    const gapNormal = cell('1F-12-12').cy - cell('1F-11-12').cy
    expect(gapAisle).toBeGreaterThan(gapNormal)
  })

  it('親子室は16列の後方・中央にある', () => {
    const oyako = layout.cells.filter((c) => c.seatId.startsWith('OYAKO-'))
    expect(oyako.length).toBe(6)
    expect(oyako[0].cy).toBeGreaterThan(cell('1F-16-1').cy)
    expect(oyako.every((c) => c.cy === oyako[0].cy)).toBe(true)
    for (let i = 1; i < oyako.length; i++) {
      expect(oyako[i].cx).toBeGreaterThan(oyako[i - 1].cx)
    }
    expect(oyako[0].cx).toBeGreaterThan(300)
    expect(oyako[5].cx).toBeLessThan(700)
  })

  it('2階サイド席は左右の縦列（x 一定・y 増加）でダイヤ型', () => {
    const l = layout.cells.filter((c) => c.seatId.startsWith('2F-SIDE-L-'))
    const r = layout.cells.filter((c) => c.seatId.startsWith('2F-SIDE-R-'))
    expect(l.length).toBe(7)
    expect(r.length).toBe(7)
    expect(l.every((c) => c.cx === l[0].cx && c.shape === 'diamond')).toBe(true)
    expect(r.every((c) => c.cx === r[0].cx && c.shape === 'diamond')).toBe(true)
    for (let i = 1; i < 7; i++) {
      expect(l[i].cy).toBeGreaterThan(l[i - 1].cy)
      expect(r[i].cy).toBeGreaterThan(r[i - 1].cy)
    }
    expect(l[0].cx).toBeLessThan(100)
    expect(r[0].cx).toBeGreaterThan(900)
    // サイド列は2階後列より上（＝舞台寄り）に描かれる
    expect(l[6].cy).toBeLessThan(cell('2F-21-12').cy)
  })

  it('2階後列は後方ほど幅が広い扇形で、両端が傾斜する', () => {
    const widthOf = (row: number) => {
      const cs = layout.cells.filter((c) => c.seatId.startsWith(`2F-${row}-`))
      return Math.max(...cs.map((c) => c.cx)) - Math.min(...cs.map((c) => c.cx))
    }
    expect(widthOf(23)).toBeGreaterThan(widthOf(22))
    expect(widthOf(22)).toBeGreaterThan(widthOf(21))
    expect(cell('2F-23-12').cy).toBeGreaterThan(cell('2F-21-12').cy)
    expect(cell('2F-22-2').rotate).toBeLessThan(0)
    expect(cell('2F-22-2').cy).toBeGreaterThan(cell('2F-22-6').cy)
    expect(cell('2F-22-27').rotate).toBeGreaterThan(0)
    expect(cell('2F-22-27').cy).toBeGreaterThan(cell('2F-22-23').cy)
    expect(cell('2F-22-12').rotate).toBe(0)
  })

  it('レイアウトのアンカー: 9ゾーン範囲内、I は H より上・中央帯', () => {
    expect(layout.anchors.length).toBe(9)
    const byZone = new Map(layout.anchors.map((a) => [a.zone, a]))
    for (const a of layout.anchors) {
      expect(a.xPct).toBeGreaterThan(0)
      expect(a.xPct).toBeLessThan(100)
      expect(a.yPct).toBeGreaterThan(0)
      expect(a.yPct).toBeLessThan(100)
    }
    // 公式図ではサイド席ボックスは2階後列より舞台寄り（上）に描かれる
    expect(byZone.get('I')!.yPct).toBeLessThan(byZone.get('H')!.yPct)
    expect(byZone.get('I')!.xPct).toBeGreaterThan(40)
    expect(byZone.get('I')!.xPct).toBeLessThan(60)
    expect(byZone.get('A')!.yPct).toBeLessThan(byZone.get('B')!.yPct)
    expect(byZone.get('B')!.yPct).toBeLessThan(byZone.get('C')!.yPct)
  })

  it('列ラベルは1〜16・21〜23の19件', () => {
    expect(layout.rowLabels.map((l) => l.label)).toEqual([
      '1', '2', '3', '4', '5', '6', '7', '8', '9', '10', '11', '12', '13', '14',
      '15', '16', '21', '22', '23',
    ])
  })
})

// ALL_SEATS を使う前提の健全性（import 漏れ防止ではなく件数の突き合わせ）
describe('前提データ', () => {
  it('ALL_SEATS は469席', () => {
    expect(ALL_SEATS.length).toBe(469)
  })
})
