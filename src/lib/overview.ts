/**
 * 「ホール全体での位置」オーバービュー用モデル。
 *
 * ゾーン割当の結果確認で、割り当てられた席がホール全体のどこかを
 * 示すために使う。ここでは全席の模式図を作り、指定された席グループ
 * だけをグループごとの色番号で示せるようにする。
 *
 * 重要な設計制約:
 * - 入力は候補（seatIds の並び）だけ。予約・販売状態（AppData）は受け取らない。
 *   構造的に「空き／埋まり」を参照できないため、空席情報は一切出ない
 *   （埋まっているかどうかで見た目が変わることもない）。
 * - 座席の並びは data/seats.ts のレイアウト定義（MiniMap・SeatMap と同じ）を
 *   再利用し、座標を二重に持たない。
 * - 車椅子席・親子室・2階サイド席も含め、全席を中立セルとして描く。
 */
import {
  PARENT_ROOM_SEATS,
  ROW_LAYOUT_1F,
  ROW_LAYOUT_2F,
  SIDE_L_SEATS,
  SIDE_R_SEATS,
  WHEELCHAIR_SEATS,
  type Floor,
  type RowLayout,
} from '../data/seats'

export interface OverviewCell {
  seatId: string
  /** 候補の何番目か（0始まり）。候補に含まれない席は null（=中立） */
  candidateIndex: number | null
}

export interface OverviewBlock {
  block: string
  cells: OverviewCell[]
}

export interface OverviewRow {
  /** 通常席の列番号。特殊行（サイド席・車椅子/親子室）は null */
  row: number | null
  kind: 'normal' | 'side' | 'special'
  blocks: OverviewBlock[]
}

export interface OverviewFloor {
  floor: Floor
  rows: OverviewRow[]
}

/**
 * 候補の席ID → 候補番号。
 * 候補同士で席が重なることは allocator が保証する（重なった場合は後の候補が勝つ）。
 */
function candidateIndexBySeat(
  candidates: readonly { seatIds: string[] }[],
): Map<string, number> {
  const map = new Map<string, number>()
  candidates.forEach((cand, i) => {
    for (const id of cand.seatIds) map.set(id, i)
  })
  return map
}

export function buildOverview(
  candidates: readonly { seatIds: string[] }[],
): OverviewFloor[] {
  const indexBySeat = candidateIndexBySeat(candidates)
  const cell = (seatId: string): OverviewCell => ({
    seatId,
    candidateIndex: indexBySeat.get(seatId) ?? null,
  })
  const layoutRows = (layout: RowLayout[]): OverviewRow[] =>
    layout.map((row) => ({
      row: row.row,
      kind: 'normal',
      blocks: row.blocks.map((b) => ({
        block: b.block,
        cells: b.seats.map((s) => cell(s.id)),
      })),
    }))

  const floor1: OverviewFloor = {
    floor: 1,
    rows: [
      ...layoutRows(ROW_LAYOUT_1F),
      {
        // 車椅子席・親子室もホールの形の一部として中立に描く（候補にはならない）
        row: null,
        kind: 'special',
        blocks: [
          { block: 'wheelchair', cells: WHEELCHAIR_SEATS.map((s) => cell(s.id)) },
          { block: 'parentRoom', cells: PARENT_ROOM_SEATS.map((s) => cell(s.id)) },
        ],
      },
    ],
  }
  const floor2: OverviewFloor = {
    floor: 2,
    rows: [
      ...layoutRows(ROW_LAYOUT_2F),
      {
        row: null,
        kind: 'side',
        blocks: [
          { block: 'sideL', cells: SIDE_L_SEATS.map((s) => cell(s.id)) },
          { block: 'sideR', cells: SIDE_R_SEATS.map((s) => cell(s.id)) },
        ],
      },
    ],
  }
  return [floor1, floor2]
}
