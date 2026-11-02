/**
 * ゾーン選択用の「上から見た座席表」モデル。
 *
 * お客様がホールを上から見て「ここがいいな」とエリア（ゾーン）を選べるよう、
 * 全席を実際の座席配置（data/seats.ts のレイアウト）どおりに並べ、
 * 席ごとに「属するゾーン」と「現在の状態」を持たせる。
 *
 * overview.ts（割当結果の確認図）との違い:
 * - こちらは選択UI用なので、予約・販売状態（AppData）を入力に含む。
 *   埋まっている席は暗く落として「残りの空き具合」が正直に見えるようにする。
 * - 結果確認図（overview.ts）は従来どおり状態を一切参照しない。
 *
 * ゾーンの定義・空き状況・割当ロジックは lib/zones.ts が正で、ここは
 * その表示モデルだけを担う（座標の二重管理はしない）。
 */
import {
  PARENT_ROOM_SEATS,
  ROW_LAYOUT_1F,
  ROW_LAYOUT_2F,
  SIDE_L_SEATS,
  SIDE_R_SEATS,
  WHEELCHAIR_SEATS,
  seatById,
  type Floor,
  type RowLayout,
} from '../data/seats'
import { seatStatus, type AppData, type SeatStatus } from './logic'
import { zoneOfSeat, type ZoneId } from './zones'

export interface ZoneMapCell {
  seatId: string
  /** 属するゾーン。車椅子席・親子室は null */
  zone: ZoneId | null
  status: SeatStatus
}

export interface ZoneMapBlock {
  block: string
  cells: ZoneMapCell[]
}

export interface ZoneMapRow {
  /** 通常席の列番号。特殊行（サイド席・車椅子/親子室）は null */
  row: number | null
  kind: 'normal' | 'side' | 'special'
  blocks: ZoneMapBlock[]
}

export interface ZoneMapFloor {
  floor: Floor
  rows: ZoneMapRow[]
}

export function buildZoneMap(data: AppData): ZoneMapFloor[] {
  const cell = (seatId: string): ZoneMapCell => ({
    seatId,
    zone: zoneOfSeat(seatById(seatId)),
    status: seatStatus(data, seatId),
  })
  const layoutRows = (layout: RowLayout[]): ZoneMapRow[] =>
    layout.map((row) => ({
      row: row.row,
      kind: 'normal',
      blocks: row.blocks.map((b) => ({
        block: b.block,
        cells: b.seats.map((s) => cell(s.id)),
      })),
    }))

  const floor1: ZoneMapFloor = {
    floor: 1,
    rows: [
      ...layoutRows(ROW_LAYOUT_1F),
      {
        row: null,
        kind: 'special',
        blocks: [
          { block: 'wheelchair', cells: WHEELCHAIR_SEATS.map((s) => cell(s.id)) },
          { block: 'parentRoom', cells: PARENT_ROOM_SEATS.map((s) => cell(s.id)) },
        ],
      },
    ],
  }
  const floor2: ZoneMapFloor = {
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

/* ---------------- ゾーンバッジの配置 ---------------- */

/** 1階の横通路（12列と13列の間）が占める高さ（行 = 1.0 とした単位） */
const AISLE_UNITS_1F = 0.75
/** 列ラベル＋余白が座席エリアの左に占める割合（バッジの x 補正） */
const LABEL_FRAC = 0.06
/** ブロック間（縦通路）の幅（席 = 1.0 とした単位） */
const BLOCK_GAP_SLOTS = 0.7

export interface ZoneAnchor {
  zone: ZoneId
  floor: Floor
  /** バッジ中心の位置（行エリアに対する %） */
  xPct: number
  yPct: number
}

/**
 * 各ゾーンのバッジを、そのゾーンの席の重心位置に置くためのアンカーを計算する。
 * x は列内の席位置（ブロック間の通路も単位に含む）、y は行位置
 * （1階は横通路の高さも単位に含む）から出す。描画側の行レイアウト
 * （等高の行＋通路）と対応するため、% は行エリア全体に対する値になる。
 */
export function zoneAnchors(floors: ZoneMapFloor[]): ZoneAnchor[] {
  const anchors: ZoneAnchor[] = []
  for (const f of floors) {
    // 行ごとの縦位置（単位: 行 = 1）
    const rowTop: number[] = []
    let units = 0
    f.rows.forEach((row, i) => {
      rowTop[i] = units
      units += 1
      if (f.floor === 1 && row.row === 12) units += AISLE_UNITS_1F
    })
    const totalUnits = units

    const acc = new Map<ZoneId, { nx: number; uy: number; n: number }>()
    f.rows.forEach((row, ri) => {
      // 行内の横位置（単位: 席 = 1、ブロック間に通路）
      const totalSlots =
        row.blocks.reduce((s, b) => s + b.cells.length, 0) +
        (row.blocks.length - 1) * BLOCK_GAP_SLOTS
      let blockStart = 0
      row.blocks.forEach((b, bi) => {
        if (bi > 0) blockStart += BLOCK_GAP_SLOTS
        b.cells.forEach((c, ci) => {
          if (!c.zone) return
          const nx = (blockStart + ci + 0.5) / totalSlots
          const entry = acc.get(c.zone) ?? { nx: 0, uy: 0, n: 0 }
          entry.nx += nx
          entry.uy += rowTop[ri] + 0.5
          entry.n += 1
          acc.set(c.zone, entry)
        })
        blockStart += b.cells.length
      })
    })
    for (const [zone, a] of acc) {
      const nx = a.nx / a.n
      anchors.push({
        zone,
        floor: f.floor,
        xPct: (LABEL_FRAC + nx * (1 - LABEL_FRAC)) * 100,
        yPct: ((a.uy / a.n) / totalUnits) * 100,
      })
    }
  }
  return anchors
}
