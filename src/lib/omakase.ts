/**
 * おまかせ割当（自動配席）ロジック。
 *
 * お客様は座席表から席を選ばず、人数と階の希望だけを指定する。
 * このモジュールは「物理的な座席の連なり（セグメント）」の中から
 * 人数ちょうどの連続ブロックを探し、見やすさ・中央寄り・断片化回避で
 * スコア付けして、性格の異なる候補を最大3つずつセットにして返す純粋関数群。
 *
 * ルール:
 * - セグメント（列内のブロック、2階サイド席の縦列）をまたがない（通路を越えない）。
 * - 車椅子席・親子室は候補に含めない（希望者は備考欄で受付）。
 * - 見切れ席を含むブロックは、他に候補がまったくない場合の最終手段としてのみ出す。
 * - 1席だけ取り残す配置（両側の残りが1）は強く避ける。
 */
import {
  RECOMMENDED_SEAT_IDS,
  ROW_LAYOUT_1F,
  ROW_LAYOUT_2F,
  SIDE_L_SEATS,
  SIDE_R_SEATS,
  seatById,
  type SeatDef,
} from '../data/seats'
import { seatStatus, type AppData } from './logic'

export type FloorPreference = 'any' | 1 | 2

export type AreaClass =
  | 'center'
  | 'front'
  | 'rear'
  | 'other'
  | 'floor2-front'
  | 'floor2-mid'
  | 'floor2-rear'
  | 'floor2-side'

export interface OmakaseCandidate {
  /** 割り当てられた席ID（表示順） */
  seatIds: string[]
  /** 連続ブロックのまとまり。通常は1つ、分割候補は2つ */
  groups: string[][]
  areaClass: AreaClass
  /** 候補の性格ラベル（例: いちばん見やすい中央エリア） */
  label: string
  /** ラベルの理由（エリアの実態から生成） */
  reason: string
  /** 2か所に分かれる候補か */
  split: boolean
  /** 見切れ席を含む候補か */
  restricted: boolean
  /** 席の要約表示（例: 1階 7列 12〜14番） */
  summary: string
}

/** 1セットに並べる候補の最大数 */
export const CANDIDATES_PER_SET = 3
/** 生成する候補セットの最大数（画面に出すのは最初の1組のみ。複数組は内部生成だけに留める） */
export const MAX_CANDIDATE_SETS = 6

interface Segment {
  seatIds: string[]
}

function buildSegments(): Segment[] {
  const segments: Segment[] = []
  for (const layout of [ROW_LAYOUT_1F, ROW_LAYOUT_2F]) {
    for (const row of layout) {
      for (const block of row.blocks) {
        if (block.seats.length > 0) {
          segments.push({ seatIds: block.seats.map((s) => s.id) })
        }
      }
    }
  }
  // 2階サイド席は縦の連なりとして1セグメントずつ扱う
  if (SIDE_L_SEATS.length > 0) segments.push({ seatIds: SIDE_L_SEATS.map((s) => s.id) })
  if (SIDE_R_SEATS.length > 0) segments.push({ seatIds: SIDE_R_SEATS.map((s) => s.id) })
  return segments
}

const SEGMENTS = buildSegments()

/** エリア分類の優先度（小さいほど良い候補として先に並ぶ） */
const CLASS_RANK: Record<AreaClass, number> = {
  center: 0,
  front: 1,
  rear: 2,
  other: 3,
  'floor2-front': 4,
  'floor2-mid': 5,
  'floor2-side': 6,
  'floor2-rear': 7,
}

const CLASS_TEXT: Record<AreaClass, { label: string; reason: string }> = {
  center: {
    label: 'いちばん見やすい中央エリア',
    reason: '舞台全体を見渡せる、おすすめのエリアです',
  },
  front: {
    label: '前方で臨場感',
    reason: '舞台に近く、出演者の表情までよく見えます',
  },
  rear: {
    label: '後方でゆったり',
    reason: '少し離れて、舞台全体を落ち着いて見渡せます',
  },
  other: {
    label: '1階サイドエリア',
    reason: '中央寄りで、舞台全体が見やすいエリアです',
  },
  'floor2-front': {
    label: '2階の前方エリア',
    reason: '高い位置から、舞台全体を見下ろせます',
  },
  'floor2-mid': {
    label: '2階席',
    reason: '高い位置から、舞台全体を見渡せます',
  },
  'floor2-rear': {
    label: '2階の後方エリア',
    reason: '高い位置から、舞台全体を落ち着いて見渡せます',
  },
  'floor2-side': {
    label: '2階サイド席',
    reason: '側面から、舞台を近くに感じられる席です',
  },
}

/** 窓（連続ブロック）のエリア分類。窓は同一ブロック内なので代表席で決まる */
export function classifySeats(seatIds: string[]): AreaClass {
  const first = seatById(seatIds[0])
  if (!first) return 'other'
  if (first.floor === 2) {
    if (first.kind === 'side') return 'floor2-side'
    if (first.row === 21) return 'floor2-front'
    if (first.row === 22) return 'floor2-mid'
    return 'floor2-rear'
  }
  if (first.block === 'center' && first.row !== null && first.row >= 5 && first.row <= 10) {
    return 'center'
  }
  if (first.row !== null && first.row <= 4) return 'front'
  if (first.row !== null && first.row >= 11) return 'rear'
  return 'other'
}

interface Window {
  seatIds: string[]
  segment: Segment
  start: number
  score: number
  restricted: boolean
  areaClass: AreaClass
}

/**
 * 窓のスコア（小さいほど良い）。
 * - 1席だけ取り残す配置は +100 の強いペナルティ
 * - 占有済みの境界に寄せて埋める配置はボーナス（空席の塊を割らない）
 * - セグメント内での中央寄り、列の甘い位置（1階は7列前後）も加味
 */
function scoreWindow(data: AppData, segment: Segment, start: number, size: number): number {
  const ids = segment.seatIds
  // 窓を含む「空席の連なり」の範囲
  let runStart = start
  while (runStart > 0 && seatStatus(data, ids[runStart - 1]) === 'available') runStart--
  let runEnd = start + size - 1
  while (runEnd < ids.length - 1 && seatStatus(data, ids[runEnd + 1]) === 'available') runEnd++
  const leftGap = start - runStart
  const rightGap = runEnd - (start + size - 1)

  let score = 0
  if (leftGap === 1) score += 100
  if (rightGap === 1) score += 100
  // 占有済み・販売終了の境界に接して埋める（塊の端から詰める）
  if (leftGap === 0) score += runStart > 0 ? -8 : -2
  if (rightGap === 0) score += runEnd < ids.length - 1 ? -8 : -2
  // セグメント内での中央寄り
  const windowCenter = start + (size - 1) / 2
  const segmentCenter = (ids.length - 1) / 2
  score += (Math.abs(windowCenter - segmentCenter) / Math.max(1, ids.length)) * 20
  // 列の甘さ: 1階は7列前後が最も見やすい。前方は後ろ寄り、後方は前寄りを優遇
  const first = seatById(ids[start])
  if (first) {
    if (first.floor === 1 && first.row !== null) score += Math.abs(first.row - 7) * 2
    else if (first.floor === 2 && first.row !== null) score += (first.row - 21) * 3
    else if (first.kind === 'side') score += 4
  }
  // おすすめゾーン（1階中央 5〜10列）にすべて入る窓は優遇
  const windowIds = ids.slice(start, start + size)
  if (windowIds.every((id) => RECOMMENDED_SEAT_IDS.has(id))) score -= 10
  return score
}

function enumerateWindows(
  data: AppData,
  size: number,
  pref: FloorPreference,
  allowRestricted: boolean,
): Window[] {
  const windows: Window[] = []
  if (size < 1) return windows
  for (const segment of SEGMENTS) {
    const ids = segment.seatIds
    const first = seatById(ids[0])
    if (!first) continue
    if (pref !== 'any' && first.floor !== pref) continue
    for (let start = 0; start + size <= ids.length; start++) {
      const seatIds = ids.slice(start, start + size)
      if (!seatIds.every((id) => seatStatus(data, id) === 'available')) continue
      const restricted = seatIds.some((id) => seatById(id)?.restrictedView)
      if (restricted && !allowRestricted) continue
      windows.push({
        seatIds,
        segment,
        start,
        score: scoreWindow(data, segment, start, size),
        restricted,
        areaClass: classifySeats(seatIds),
      })
    }
  }
  windows.sort(
    (a, b) =>
      a.score - b.score ||
      a.seatIds[0].localeCompare(b.seatIds[0]) ||
      a.start - b.start,
  )
  return windows
}

/** 席ID群の要約表示（例: 1階 7列 12〜14番 / 2階 L席 3番） */
export function summarizeSeatIds(seatIds: string[]): string {
  const seats = seatIds.map((id) => seatById(id))
  const parts: string[] = []
  // 通常席: 同じ階・列・ブロックで番号の連続を圧縮
  const normals = seats.filter((s) => s.kind === 'normal')
  const byGroup = new Map<string, SeatDef[]>()
  for (const s of normals) {
    const key = `${s.floor}-${s.row}-${s.block ?? ''}`
    const arr = byGroup.get(key) ?? []
    arr.push(s)
    byGroup.set(key, arr)
  }
  const groupList = [...byGroup.values()].sort((a, b) =>
    a[0].floor !== b[0].floor
      ? a[0].floor - b[0].floor
      : (a[0].row ?? 0) - (b[0].row ?? 0),
  )
  for (const group of groupList) {
    // 通常席は number を必ず持つ（null は車椅子席のみ）
    const numOf = (s: SeatDef): number => s.number ?? 0
    const sorted = [...group].sort((a, b) => numOf(a) - numOf(b))
    let runStart = sorted[0]
    let prev = sorted[0]
    const flush = () => {
      if (runStart === prev) parts.push(runStart.label)
      else parts.push(`${runStart.floor}階 ${runStart.row}列 ${numOf(runStart)}〜${numOf(prev)}番`)
    }
    for (let i = 1; i < sorted.length; i++) {
      if (numOf(sorted[i]) === numOf(prev) + 1) {
        prev = sorted[i]
      } else {
        flush()
        runStart = sorted[i]
        prev = sorted[i]
      }
    }
    flush()
  }
  for (const s of seats.filter((x) => x.kind !== 'normal')) parts.push(s.label)
  return parts.join('、')
}

/**
 * 2階候補の理由文への補足（R6・D-4）: 2階の列番号は会場の実番号で21列から
 * 始まるため、初見では「22列＝後ろの方？」と誤読しやすい。実番号である
 * ことが分かるよう一言添える。ミニ座席表の位置表示と併せて距離感を伝える。
 */
const FLOOR2_ROW_NOTE = '（2階の列番号は21列から始まります）'

function reasonWithFloorNote(base: string, seatIds: string[], restricted: boolean): string {
  const isFloor2 = seatById(seatIds[0])?.floor === 2
  return (
    base +
    (isFloor2 ? FLOOR2_ROW_NOTE : '') +
    (restricted ? '（見切れ席＝舞台の一部が見えにくい席を含みます）' : '')
  )
}

function toCandidate(w: Window, split: boolean): OmakaseCandidate {
  const text = CLASS_TEXT[w.areaClass]
  return {
    seatIds: w.seatIds,
    groups: [w.seatIds],
    areaClass: w.areaClass,
    label: text.label,
    reason: reasonWithFloorNote(text.reason, w.seatIds, w.restricted),
    split,
    restricted: w.restricted,
    summary: summarizeSeatIds(w.seatIds),
  }
}

/** 窓の集合から、クラス多様性を保った候補セット列を作る */
function setsFromWindows(windows: Window[]): OmakaseCandidate[][] {
  const byClass = new Map<AreaClass, Window[]>()
  for (const w of windows) {
    const arr = byClass.get(w.areaClass) ?? []
    arr.push(w)
    byClass.set(w.areaClass, arr)
  }
  const classOrder = [...byClass.keys()].sort((a, b) => CLASS_RANK[a] - CLASS_RANK[b])
  const sets: OmakaseCandidate[][] = []
  for (let k = 0; k < MAX_CANDIDATE_SETS; k++) {
    const set: OmakaseCandidate[] = []
    for (const cls of classOrder) {
      if (set.length >= CANDIDATES_PER_SET) break
      const w = byClass.get(cls)?.[k]
      if (w) set.push(toCandidate(w, false))
    }
    if (set.length === 0) break
    sets.push(set)
  }
  return sets
}

/** 2グループ間の近さ（小さいほど近い）。同セグメント→同列→階内→階違い */
function groupDistance(a: Window, b: Window): number {
  if (a.segment === b.segment) {
    const gap =
      Math.min(
        Math.abs(a.start - (b.start + b.seatIds.length - 1)),
        Math.abs(b.start - (a.start + a.seatIds.length - 1)),
      ) - 1
    return Math.max(0, gap)
  }
  const sa = seatById(a.seatIds[0])
  const sb = seatById(b.seatIds[0])
  if (!sa || !sb) return 10000
  if (sa.floor !== sb.floor) return 1000
  const ra = sa.row ?? 24
  const rb = sb.row ?? 24
  if (ra === rb) return 10
  return 10 + Math.abs(ra - rb) * 10
}

/** 連続ブロックが無い場合の分割候補（2グループ、できるだけ近く・大きく） */
function findSplitCandidate(
  data: AppData,
  partySize: number,
  pref: FloorPreference,
  allowRestricted: boolean,
): OmakaseCandidate | null {
  const sizeA = Math.ceil(partySize / 2)
  const sizeB = partySize - sizeA
  if (sizeB < 1) return null
  const windowsA = enumerateWindows(data, sizeA, pref, allowRestricted)
  const windowsB = enumerateWindows(data, sizeB, pref, allowRestricted)
  let best: { a: Window; b: Window; cost: number } | null = null
  for (const a of windowsA.slice(0, 40)) {
    for (const b of windowsB.slice(0, 300)) {
      if (b.seatIds.some((id) => a.seatIds.includes(id))) continue
      const cost = groupDistance(a, b) * 100 + a.score + b.score
      if (!best || cost < best.cost) best = { a, b, cost }
    }
  }
  if (!best) return null
  const groups = [best.a.seatIds, best.b.seatIds]
  const seatIds = [...best.a.seatIds, ...best.b.seatIds]
  const restricted = best.a.restricted || best.b.restricted
  const areaClass = classifySeats(best.a.seatIds)
  const text = CLASS_TEXT[areaClass]
  return {
    seatIds,
    groups,
    areaClass,
    label: text.label,
    reason: reasonWithFloorNote(
      '連続した席がご用意できず、2か所に分かれる候補です。' + text.reason,
      seatIds,
      restricted,
    ),
    split: true,
    restricted,
    summary: summarizeSeatIds(seatIds),
  }
}

/** 指定範囲（階の希望）内の空席総数 */
export function countAvailableForPreference(
  data: AppData,
  pref: FloorPreference,
): number {
  let count = 0
  for (const segment of SEGMENTS) {
    const first = seatById(segment.seatIds[0])
    if (!first) continue
    if (pref !== 'any' && first.floor !== pref) continue
    for (const id of segment.seatIds) {
      if (seatStatus(data, id) === 'available') count++
    }
  }
  return count
}

/**
 * 候補セット列を生成する。
 * 優先順位: 通常の連続ブロック → 分割候補 → 見切れ込みの連続ブロック → 見切れ込みの分割候補。
 * 空配列は「範囲内の空席が人数未満（＝売り切れ）」または「どう組んでも人数分が揃わない」。
 */
export function buildCandidateSets(
  data: AppData,
  partySize: number,
  pref: FloorPreference,
): OmakaseCandidate[][] {
  if (partySize < 1) return []
  if (countAvailableForPreference(data, pref) < partySize) return []
  const windows = enumerateWindows(data, partySize, pref, false)
  if (windows.length > 0) return setsFromWindows(windows)
  const split = findSplitCandidate(data, partySize, pref, false)
  if (split) return [[split]]
  const restrictedWindows = enumerateWindows(data, partySize, pref, true)
  if (restrictedWindows.length > 0) return setsFromWindows(restrictedWindows)
  const restrictedSplit = findSplitCandidate(data, partySize, pref, true)
  if (restrictedSplit) return [[restrictedSplit]]
  return []
}
