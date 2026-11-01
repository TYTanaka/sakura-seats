/**
 * さくらプラザ・ホール 座席定義
 * 出典: 公式座席表PDF (hall_zaseki2021.pdf) を seat-by-seat に転記した
 * ~/workspace/sakura-seats/research/seat-map-spec.md に完全準拠する。
 *
 * 公式固定席数: 1F 359 / 2F 92 / 合計 451（車いす席・親子席除く）
 * ただし図面に描かれた 1F の席を数えると 369 席あり、公式数と10席差がある。
 * 本データは「描かれた全席」を収録し、差分は公演ごとの販売ON/OFFで吸収する。
 */

export type Floor = 1 | 2
export type SeatKind = 'normal' | 'side' | 'wheelchair' | 'parentRoom'
export type BlockName = 'left' | 'center' | 'right'

export interface SeatDef {
  id: string
  floor: Floor
  kind: SeatKind
  /** 通常席の列番号（サイド席・特殊席は null） */
  row: number | null
  /** ブロック（特殊席・サイド席は null） */
  block: BlockName | null
  /** 席番号（車椅子席は null） */
  number: number | null
  /** サイド席・車椅子席の左右 */
  side: 'L' | 'R' | null
  /** 見切れ席（舞台の一部が見えにくい席） */
  restrictedView: boolean
  /** 表記ルールに基づく表示名。例: 「1階 5列 12番」「2階 L席 3番」「車椅子席 L」「親子室 2番」 */
  label: string
  /** 座席表上の短い表示（番号 or L/R） */
  shortLabel: string
}

interface BlockSpec {
  block: BlockName
  from: number
  to: number
}

interface RowSpec {
  row: number
  blocks: BlockSpec[]
}

const B = (block: BlockName, from: number, to: number): BlockSpec => ({ block, from, to })
function range(from: number, to: number): number[] {
  const out: number[] = []
  for (let n = from; n <= to; n++) out.push(n)
  return out
}

/** 1階席: 列は舞台側から1〜16。12列と13列の間に横通路。 */
const ROWS_1F: RowSpec[] = [
  { row: 1, blocks: [B('left', 3, 5), B('center', 6, 20), B('right', 22, 24)] },
  { row: 2, blocks: [B('left', 2, 5), B('center', 6, 21), B('right', 22, 25)] },
  { row: 3, blocks: [B('left', 2, 5), B('center', 6, 20), B('right', 22, 25)] },
  { row: 4, blocks: [B('left', 1, 5), B('center', 6, 21), B('right', 22, 26)] },
  { row: 5, blocks: [B('left', 1, 5), B('center', 6, 20), B('right', 22, 26)] },
  { row: 6, blocks: [B('left', 1, 5), B('center', 6, 21), B('right', 22, 26)] },
  { row: 7, blocks: [B('left', 1, 5), B('center', 6, 21), B('right', 22, 26)] },
  { row: 8, blocks: [B('left', 1, 5), B('center', 6, 21), B('right', 22, 26)] },
  { row: 9, blocks: [B('left', 1, 5), B('center', 6, 21), B('right', 22, 26)] },
  { row: 10, blocks: [B('left', 1, 5), B('center', 6, 21), B('right', 22, 26)] },
  { row: 11, blocks: [B('left', 1, 5), B('center', 10, 21), B('right', 22, 26)] },
  { row: 12, blocks: [B('left', 1, 5), B('center', 10, 21), B('right', 22, 26)] },
  { row: 13, blocks: [B('center', 6, 21)] },
  { row: 14, blocks: [B('left', 1, 5), B('center', 6, 21), B('right', 22, 26)] },
  { row: 15, blocks: [B('left', 1, 5), B('center', 6, 21), B('right', 22, 26)] },
  { row: 16, blocks: [B('left', 1, 4), B('right', 23, 26)] },
]

/** 2階席: 列番号は21〜23。後方ほど横に広い扇形。 */
const ROWS_2F: RowSpec[] = [
  { row: 21, blocks: [B('left', 3, 6), B('center', 7, 22), B('right', 23, 26)] },
  { row: 22, blocks: [B('left', 2, 6), B('center', 7, 22), B('right', 23, 27)] },
  { row: 23, blocks: [B('left', 1, 6), B('center', 7, 22), B('right', 23, 28)] },
]

/** 見切れ席（2F）: 「2F-{列}-{番}」 */
const RESTRICTED_VIEW_IDS = new Set<string>([
  '2F-21-3', '2F-21-26',
  '2F-22-2', '2F-22-6', '2F-22-23', '2F-22-27',
  '2F-23-1', '2F-23-6', '2F-23-23', '2F-23-28',
])

function buildSeats(): SeatDef[] {
  const seats: SeatDef[] = []
  const pushRows = (floor: Floor, rows: RowSpec[]) => {
    for (const spec of rows) {
      for (const blk of spec.blocks) {
        for (const num of range(blk.from, blk.to)) {
          const id = `${floor}F-${spec.row}-${num}`
          seats.push({
            id,
            floor,
            kind: 'normal',
            row: spec.row,
            block: blk.block,
            number: num,
            side: null,
            restrictedView: RESTRICTED_VIEW_IDS.has(id),
            label: `${floor}階 ${spec.row}列 ${num}番`,
            shortLabel: String(num),
          })
        }
      }
    }
  }
  pushRows(1, ROWS_1F)
  // 車椅子席 L / R（1階11-12列にまたがる位置。便宜上11列に付随。固定席数に含まない）
  for (const side of ['L', 'R'] as const) {
    seats.push({
      id: `WC-${side}`,
      floor: 1,
      kind: 'wheelchair',
      row: null,
      block: null,
      number: null,
      side,
      restrictedView: false,
      label: `車椅子席 ${side}`,
      shortLabel: side,
    })
  }
  // 親子室 1-6（1階16列の後方・室内。固定席数に含まない）
  for (const num of range(1, 6)) {
    seats.push({
      id: `OYAKO-${num}`,
      floor: 1,
      kind: 'parentRoom',
      row: null,
      block: null,
      number: num,
      side: null,
      restrictedView: false,
      label: `親子室 ${num}番`,
      shortLabel: String(num),
    })
  }
  pushRows(2, ROWS_2F)
  // 2Fサイド席 L席 1-7 / R席 1-7（側面に縦7席ずつ）
  for (const side of ['L', 'R'] as const) {
    for (const num of range(1, 7)) {
      seats.push({
        id: `2F-SIDE-${side}-${num}`,
        floor: 2,
        kind: 'side',
        row: null,
        block: null,
        number: num,
        side,
        restrictedView: false,
        label: `2階 ${side}席 ${num}番`,
        shortLabel: String(num),
      })
    }
  }
  return seats
}

export const ALL_SEATS: SeatDef[] = buildSeats()

export const SEAT_BY_ID: ReadonlyMap<string, SeatDef> = new Map(
  ALL_SEATS.map((s) => [s.id, s]),
)

export function seatById(id: string): SeatDef {
  const seat = SEAT_BY_ID.get(id)
  if (!seat) throw new Error(`未知の座席IDです: ${id}`)
  return seat
}

/** 1Fの通常席（図面に描かれた席）= 369 */
export const SEATS_1F_NORMAL = ALL_SEATS.filter((s) => s.floor === 1 && s.kind === 'normal')
/** 1Fの特殊席（車椅子2 + 親子室6）= 8 */
export const SEATS_1F_SPECIAL = ALL_SEATS.filter((s) => s.floor === 1 && s.kind !== 'normal')
/** 2Fの全席（通常78 + サイド14）= 92 */
export const SEATS_2F = ALL_SEATS.filter((s) => s.floor === 2)

export const WHEELCHAIR_SEATS = ALL_SEATS.filter((s) => s.kind === 'wheelchair')
export const PARENT_ROOM_SEATS = ALL_SEATS.filter((s) => s.kind === 'parentRoom')
export const SIDE_L_SEATS = ALL_SEATS.filter((s) => s.kind === 'side' && s.side === 'L')
export const SIDE_R_SEATS = ALL_SEATS.filter((s) => s.kind === 'side' && s.side === 'R')
export const RESTRICTED_VIEW_SEATS = ALL_SEATS.filter((s) => s.restrictedView)

export interface RowLayout {
  row: number
  blocks: { block: BlockName; seats: SeatDef[] }[]
}

function buildRowLayout(rows: RowSpec[]): RowLayout[] {
  return rows.map((spec) => ({
    row: spec.row,
    blocks: spec.blocks.map((blk) => ({
      block: blk.block,
      seats: range(blk.from, blk.to).map((num) =>
        seatById(`${spec.row >= 21 ? 2 : 1}F-${spec.row}-${num}`),
      ),
    })),
  }))
}

/** 描画用レイアウト: 1F（rows 1-16） */
export const ROW_LAYOUT_1F: RowLayout[] = buildRowLayout(ROWS_1F)
/** 描画用レイアウト: 2F（rows 21-23） */
export const ROW_LAYOUT_2F: RowLayout[] = buildRowLayout(ROWS_2F)

/** 1Fの列番号一覧（販売設定の一括切替などに使う） */
export function seatIdsOfRow(floor: Floor, row: number): string[] {
  return ALL_SEATS.filter((s) => s.floor === floor && s.kind === 'normal' && s.row === row).map(
    (s) => s.id,
  )
}
