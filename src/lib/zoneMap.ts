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

/* ---------------- 公式図レイアウト（R13） ----------------
 *
 * 公式座席表（hall_zaseki2021.pdf）の図形に合わせた、単一プランの
 * 絶対座標モデル。舞台→1階（左右ブロックは扇形に傾斜）→親子室→
 * 2階サイド席（左右の縦ボックス）→2階後列（扇形）までを1枚に描く。
 * 座標はプラン単位（幅 1000）。席の所属ゾーン・状態は buildZoneMap と
 * 同じものをそのまま使い、ここでは「置き場所」だけを決める。
 */

export const PLAN_W = 1000
export const PLAN_H = 1084

export interface ZoneMapLayoutCell {
  seatId: string
  zone: ZoneId | null
  status: SeatStatus
  /** 中心座標（プラン単位） */
  cx: number
  cy: number
  w: number
  h: number
  /** 傾き（deg、CSS rotate と同じ向き） */
  rotate: number
  shape: 'rect' | 'diamond'
}

export interface ZoneMapRowLabel {
  label: string
  cx: number
  cy: number
}

export interface ZoneMapLayout {
  width: number
  height: number
  cells: ZoneMapLayoutCell[]
  /** バッジ位置（プラン全体に対する %、floor は従来互換のための所属階） */
  anchors: ZoneAnchor[]
  rowLabels: ZoneMapRowLabel[]
}

/* --- 1階の寸法 --- */
const F1_Y = 56
const F1_PITCH = 33
const F1_SEAT_H = 22
const F1_AISLE = 24 // 12列と13列の間の横通路ぶんの追加オフセット
const CENTER_X = 302
const CENTER_SLOT = 25
const SIDE_PITCH = 26

const f1RowTop = (row: number): number =>
  F1_Y + (row - 1) * F1_PITCH + (row >= 13 ? F1_AISLE : 0)
const f1RowCy = (row: number): number => f1RowTop(row) + F1_SEAT_H / 2
/** 左右ブロックの傾き（列が後方ほど扇が開く） */
const f1Tilt = (row: number): number => 6.5 + (row - 1) * 0.55

/* --- 2階後列の寸法 --- */
const F2_Y = 946
const F2_PITCH = 37
const F2_SEAT_H = 24
const F2_TILT = 11
const F2_ROWS: Record<number, { x0: number; w: number }> = {
  21: { x0: 150, w: 700 },
  22: { x0: 112, w: 776 },
  23: { x0: 74, w: 852 },
}

/* --- 特殊席の寸法 --- */
const WC_BOX = { x: 278, y: 380, w: 118, h: 68 }
const PARENT_BOX = { x: 296, y: 606, w: 408, h: 64 }
const SIDE_BOX_Y = 712
const SIDE_L_CX = 51
const SIDE_R_CX = 949
const SIDE_FIRST_CY = SIDE_BOX_Y + 44
const SIDE_PITCH_Y = 25

export function buildZoneMapLayout(data: AppData): ZoneMapLayout {
  const floors = buildZoneMap(data)
  const cellById = new Map<string, ZoneMapCell>()
  for (const f of floors) {
    for (const r of f.rows) {
      for (const b of r.blocks) {
        for (const c of b.cells) cellById.set(c.seatId, c)
      }
    }
  }

  const cells: ZoneMapLayoutCell[] = []
  const push = (
    seatId: string,
    cx: number,
    cy: number,
    w: number,
    h: number,
    rotate = 0,
    shape: 'rect' | 'diamond' = 'rect',
  ) => {
    const base = cellById.get(seatId)
    if (!base) return
    cells.push({ seatId, zone: base.zone, status: base.status, cx, cy, w, h, rotate, shape })
  }

  /* 1階 通常席 */
  for (const rowLayout of ROW_LAYOUT_1F) {
    const row = rowLayout.row
    const cy = f1RowCy(row)
    const tilt = f1Tilt(row)
    const rad = (tilt * Math.PI) / 180
    for (const block of rowLayout.blocks) {
      const nums = block.seats.map((s) => s.number ?? 0)
      if (block.block === 'center') {
        for (const s of block.seats) {
          push(s.id, CENTER_X + ((s.number ?? 6) - 6) * CENTER_SLOT + CENTER_SLOT / 2, cy, 21, F1_SEAT_H)
        }
      } else if (block.block === 'left') {
        const max = Math.max(...nums)
        const innerCx = 280 - (row - 1) * 1.1
        for (const s of block.seats) {
          const j = max - (s.number ?? max) // 0 = 最も中央寄り
          push(
            s.id,
            innerCx - (j + 0.5) * SIDE_PITCH * Math.cos(rad),
            cy + j * SIDE_PITCH * Math.sin(rad),
            22,
            F1_SEAT_H - 2,
            -tilt,
          )
        }
      } else {
        const min = Math.min(...nums)
        const innerCx = 720 + (row - 1) * 1.1
        for (const s of block.seats) {
          const j = (s.number ?? min) - min // 0 = 最も中央寄り
          push(
            s.id,
            innerCx + (j + 0.5) * SIDE_PITCH * Math.cos(rad),
            cy + j * SIDE_PITCH * Math.sin(rad),
            22,
            F1_SEAT_H - 2,
            tilt,
          )
        }
      }
    }
  }

  /* 車椅子席（左ブロックと中央ブロックの間、11〜12列にまたがる箱の中） */
  WHEELCHAIR_SEATS.forEach((s, i) => {
    push(s.id, WC_BOX.x + 34 + i * 56, WC_BOX.y + 38, 48, 30)
  })

  /* 親子室（16列の後方・室内に1列。ラベルは室内左側に置く） */
  PARENT_ROOM_SEATS.forEach((s, i) => {
    push(s.id, PARENT_BOX.x + 157 + i * 42, PARENT_BOX.y + 32, 34, 22)
  })

  /* 2階サイド席（左右の縦ボックスにダイヤを縦積み） */
  SIDE_L_SEATS.forEach((s, i) => {
    push(s.id, SIDE_L_CX, SIDE_FIRST_CY + i * SIDE_PITCH_Y, 21, 21, 45, 'diamond')
  })
  SIDE_R_SEATS.forEach((s, i) => {
    push(s.id, SIDE_R_CX, SIDE_FIRST_CY + i * SIDE_PITCH_Y, 21, 21, 45, 'diamond')
  })

  /* 2階 後列（後方ほど広い扇形。両端ブロックは傾斜） */
  for (const rowLayout of ROW_LAYOUT_2F) {
    const row = rowLayout.row
    const spec = F2_ROWS[row]
    const cyTop = F2_Y + (row - 21) * F2_PITCH
    const cy = cyTop + F2_SEAT_H / 2
    const counts = rowLayout.blocks.map((b) => b.seats.length)
    const total = counts.reduce((a, b) => a + b, 0)
    const gap = 16
    const unit = (spec.w - gap * (rowLayout.blocks.length - 1)) / total
    const rad = (F2_TILT * Math.PI) / 180
    let blockStart = spec.x0
    rowLayout.blocks.forEach((block, bi) => {
      if (bi > 0) blockStart += gap
      const nums = block.seats.map((s) => s.number ?? 0)
      block.seats.forEach((s, ci) => {
        if (block.block === 'center') {
          push(s.id, blockStart + (ci + 0.5) * unit, cy, unit - 5, F2_SEAT_H)
        } else if (block.block === 'left') {
          const j = Math.max(...nums) - (s.number ?? 0)
          push(
            s.id,
            blockStart + block.seats.length * unit - (j + 0.5) * unit * Math.cos(rad),
            cy + j * unit * Math.sin(rad),
            unit - 5,
            F2_SEAT_H - 2,
            -F2_TILT,
          )
        } else {
          const j = (s.number ?? 0) - Math.min(...nums)
          push(
            s.id,
            blockStart + (j + 0.5) * unit * Math.cos(rad),
            cy + j * unit * Math.sin(rad),
            unit - 5,
            F2_SEAT_H - 2,
            F2_TILT,
          )
        }
      })
      blockStart += block.seats.length * unit
    })
  }

  /* バッジ: ゾーン席の重心 */
  const acc = new Map<ZoneId, { x: number; y: number; n: number }>()
  for (const c of cells) {
    if (!c.zone) continue
    const e = acc.get(c.zone) ?? { x: 0, y: 0, n: 0 }
    e.x += c.cx
    e.y += c.cy
    e.n += 1
    acc.set(c.zone, e)
  }
  const anchors: ZoneAnchor[] = [...acc.entries()].map(([zone, a]) => ({
    zone,
    floor: zone === 'H' || zone === 'I' ? 2 : 1,
    xPct: (a.x / a.n / PLAN_W) * 100,
    yPct: (a.y / a.n / PLAN_H) * 100,
  }))

  const rowLabels: ZoneMapRowLabel[] = [
    ...ROW_LAYOUT_1F.map((r) => ({ label: String(r.row), cx: 16, cy: f1RowCy(r.row) })),
    ...ROW_LAYOUT_2F.map((r) => ({
      label: String(r.row),
      cx: 16,
      cy: F2_Y + (r.row - 21) * F2_PITCH + F2_SEAT_H / 2,
    })),
  ]

  return { width: PLAN_W, height: PLAN_H, cells, anchors, rowLabels }
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
