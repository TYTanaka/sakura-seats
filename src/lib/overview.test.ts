import { describe, expect, it } from 'vitest'
import { ALL_SEATS, PARENT_ROOM_SEATS, WHEELCHAIR_SEATS } from '../data/seats'
import { buildOverview, type OverviewCell, type OverviewFloor } from './overview'

interface FlatCell extends OverviewCell {
  floor: 1 | 2
}

function flatCells(floors: OverviewFloor[]): FlatCell[] {
  return floors.flatMap((f) =>
    f.rows.flatMap((r) =>
      r.blocks.flatMap((b) => b.cells.map((c) => ({ ...c, floor: f.floor }))),
    ),
  )
}

const CANDIDATES = [
  { seatIds: ['1F-7-12', '1F-7-13', '1F-7-14'] }, // 1階 中央
  { seatIds: ['1F-15-10', '1F-15-11', '1F-15-12'] }, // 1階 後方
  { seatIds: ['2F-22-12', '2F-22-13', '2F-22-14'] }, // 2階
]

describe('ホール全体オーバービュー: 構造', () => {
  it('1階・2階の2フロアで、全席がちょうど1回ずつ並ぶ', () => {
    const floors = buildOverview(CANDIDATES)
    expect(floors.map((f) => f.floor)).toEqual([1, 2])
    const cells = flatCells(floors)
    expect(cells).toHaveLength(ALL_SEATS.length)
    expect(new Set(cells.map((c) => c.seatId)).size).toBe(ALL_SEATS.length)
    expect(new Set(cells.map((c) => c.seatId))).toEqual(
      new Set(ALL_SEATS.map((s) => s.id)),
    )
  })

  it('1階の通常列は16列、2階は3列＋サイド行を持つ（既存レイアウトの再利用）', () => {
    const floors = buildOverview([])
    const f1 = floors[0]
    const f2 = floors[1]
    expect(f1.rows.filter((r) => r.kind === 'normal').map((r) => r.row)).toEqual([
      1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16,
    ])
    expect(f2.rows.filter((r) => r.kind === 'normal').map((r) => r.row)).toEqual([
      21, 22, 23,
    ])
    expect(f2.rows.some((r) => r.kind === 'side')).toBe(true)
    expect(f1.rows.some((r) => r.kind === 'special')).toBe(true)
  })
})

describe('ホール全体オーバービュー: 候補の色分け', () => {
  it('候補の席は候補番号（0/1/2）で色分けされ、階も正しい', () => {
    const cells = flatCells(buildOverview(CANDIDATES))
    const byId = new Map(cells.map((c) => [c.seatId, c]))
    CANDIDATES.forEach((cand, i) => {
      for (const id of cand.seatIds) {
        expect(byId.get(id)?.candidateIndex).toBe(i)
      }
    })
    expect(byId.get('1F-7-12')?.floor).toBe(1)
    expect(byId.get('2F-22-12')?.floor).toBe(2)
    // 色の付いたセルの総数は候補席の合計と一致する
    const colored = cells.filter((c) => c.candidateIndex !== null)
    expect(colored).toHaveLength(9)
    expect(new Set(colored.map((c) => c.candidateIndex))).toEqual(new Set([0, 1, 2]))
  })

  it('2階サイド席の候補も2階側に色が付く', () => {
    const cells = flatCells(
      buildOverview([{ seatIds: ['2F-SIDE-L-2', '2F-SIDE-L-3'] }]),
    )
    const side = cells.filter((c) => c.seatId.startsWith('2F-SIDE'))
    expect(side).toHaveLength(14)
    expect(side.every((c) => c.floor === 2)).toBe(true)
    expect(
      side
        .filter((c) => c.seatId === '2F-SIDE-L-2' || c.seatId === '2F-SIDE-L-3')
        .every((c) => c.candidateIndex === 0),
    ).toBe(true)
  })

  it('車椅子席・親子室は1階に含まれ、常に中立（候補色は付かない）', () => {
    const cells = flatCells(buildOverview(CANDIDATES))
    const specialIds = new Set(
      [...WHEELCHAIR_SEATS, ...PARENT_ROOM_SEATS].map((s) => s.id),
    )
    const special = cells.filter((c) => specialIds.has(c.seatId))
    expect(special).toHaveLength(specialIds.size)
    expect(special.every((c) => c.floor === 1 && c.candidateIndex === null)).toBe(
      true,
    )
  })

  it('候補が無ければ全セル中立', () => {
    const cells = flatCells(buildOverview([]))
    expect(cells.every((c) => c.candidateIndex === null)).toBe(true)
  })

  it('候補が1〜2つでも、その分だけ色が付く', () => {
    const cells = flatCells(buildOverview([CANDIDATES[0]]))
    expect(new Set(cells.map((c) => c.candidateIndex))).toEqual(new Set([null, 0]))
  })
})

describe('ホール全体オーバービュー: 空席情報を参照しない', () => {
  it('入力は候補だけ（引数1つ）で、予約・販売状態を受け取る口がない', () => {
    expect(buildOverview.length).toBe(1)
  })

  it('純粋関数: 同じ候補からは常に同じ結果が返る（状態に依存しない）', () => {
    expect(buildOverview(CANDIDATES)).toEqual(buildOverview(CANDIDATES))
  })
})
