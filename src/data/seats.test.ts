import { describe, expect, it } from 'vitest'
import {
  ALL_SEATS,
  PARENT_ROOM_SEATS,
  RESTRICTED_VIEW_SEATS,
  SEATS_1F_NORMAL,
  SEATS_1F_SPECIAL,
  SEATS_2F,
  SIDE_L_SEATS,
  SIDE_R_SEATS,
  WHEELCHAIR_SEATS,
  seatById,
} from './seats'

describe('座席データの整合性（公式座席表PDFの転記仕様）', () => {
  it('1Fの通常席（図面に描かれた席）は369席', () => {
    expect(SEATS_1F_NORMAL.length).toBe(369)
  })

  it('1Fの特殊席は車椅子2 + 親子室6 = 8席', () => {
    expect(WHEELCHAIR_SEATS.length).toBe(2)
    expect(PARENT_ROOM_SEATS.length).toBe(6)
    expect(SEATS_1F_SPECIAL.length).toBe(8)
  })

  it('2Fは92席（公式数と一致）', () => {
    expect(SEATS_2F.length).toBe(92)
  })

  it('全席IDが一意である', () => {
    const ids = ALL_SEATS.map((s) => s.id)
    expect(new Set(ids).size).toBe(ids.length)
    expect(ALL_SEATS.length).toBe(369 + 8 + 92)
  })

  it('見切れ席は10席', () => {
    expect(RESTRICTED_VIEW_SEATS.length).toBe(10)
    const expected = [
      '2F-21-3',
      '2F-21-26',
      '2F-22-2',
      '2F-22-6',
      '2F-22-23',
      '2F-22-27',
      '2F-23-1',
      '2F-23-6',
      '2F-23-23',
      '2F-23-28',
    ]
    for (const id of expected) {
      expect(seatById(id).restrictedView, id).toBe(true)
    }
  })

  it('列ごとの席数が仕様表と一致する', () => {
    const expectedRowCounts: Record<string, number> = {
      '1-1': 21,
      '1-2': 24,
      '1-3': 23,
      '1-4': 26,
      '1-5': 25,
      '1-6': 26,
      '1-7': 26,
      '1-8': 26,
      '1-9': 26,
      '1-10': 26,
      '1-11': 22,
      '1-12': 22,
      '1-13': 16,
      '1-14': 26,
      '1-15': 26,
      '1-16': 8,
      '2-21': 24,
      '2-22': 26,
      '2-23': 28,
    }
    for (const [key, count] of Object.entries(expectedRowCounts)) {
      const [floor, row] = key.split('-').map(Number)
      const actual = ALL_SEATS.filter(
        (s) => s.floor === floor && s.kind === 'normal' && s.row === row,
      ).length
      expect(actual, `${floor}階 ${row}列`).toBe(count)
    }
    expect(SIDE_L_SEATS.length).toBe(7)
    expect(SIDE_R_SEATS.length).toBe(7)
  })

  it('ブロック範囲の端が仕様どおり', () => {
    // 1列は左3-5（1,2番は存在しない）
    expect(() => seatById('1F-1-1')).toThrow()
    expect(seatById('1F-1-3').number).toBe(3)
    // 13列は中央のみ
    expect(() => seatById('1F-13-1')).toThrow()
    expect(seatById('1F-13-6').number).toBe(6)
    // 16列は中央なし・左1-4/右23-26
    expect(() => seatById('1F-16-10')).toThrow()
    expect(seatById('1F-16-4').number).toBe(4)
    expect(seatById('1F-16-23').number).toBe(23)
    // 11列の中央は10番から（6-9番は車椅子席スペースで欠落）
    expect(() => seatById('1F-11-6')).toThrow()
    expect(seatById('1F-11-10').number).toBe(10)
    // 23列は28番まで
    expect(seatById('2F-23-28').number).toBe(28)
  })

  it('表示名が表記ルールどおり', () => {
    expect(seatById('1F-5-12').label).toBe('1階 5列 12番')
    expect(seatById('2F-21-3').label).toBe('2階 21列 3番')
    expect(seatById('2F-SIDE-L-3').label).toBe('2階 L席 3番')
    expect(seatById('2F-SIDE-R-5').label).toBe('2階 R席 5番')
    expect(seatById('WC-L').label).toBe('車椅子席 L')
    expect(seatById('WC-R').label).toBe('車椅子席 R')
    expect(seatById('OYAKO-2').label).toBe('親子室 2番')
  })
})
