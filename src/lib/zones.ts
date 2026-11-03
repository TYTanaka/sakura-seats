/**
 * ゾーン制予約（ライブ会場方式）の定義と自動割当ロジック。
 *
 * お客様は座席表から席を選ばず、まず人数を決め、ホールを9つのゾーン
 * （A〜I）に分けた模式図からエリアを選ぶ。席は選んだゾーンの中でだけ
 * システムが自動で割り当てる（ゾーンをまたがない）。
 *
 * ゾーン定義（座席表データ data/seats.ts の列・ブロックから導出する）:
 * - A: 1階 中央ブロック 1〜4列（62席）
 * - B: 1階 中央ブロック 5〜10列（95席）= おすすめ席ゾーン
 * - C: 1階 中央ブロック 11〜15列（72席）
 * - D: 1階 左ブロック 1〜10列（46席）
 * - E: 1階 左ブロック 11〜16列（24席）
 * - F: 1階 右ブロック 1〜10列（46席）
 * - G: 1階 右ブロック 11〜16列（24席）
 * - H: 2階 通常席 21〜23列（78席）
 * - I: 2階 サイド席 L/R（14席）
 * 合計 461席。車椅子席（2）・親子室（6）はどのゾーンにも含めない
 * （希望者は従来どおり申込フォームの備考欄で受付）。
 * 料金はゾーンによらず一律（券種のみで決まる）。
 *
 * 割当ルール（ゾーン内）:
 * - セグメント（列内のブロック、2階サイド席の縦列）をまたがない連続席を優先。
 * - 詰め込み（パッキング）: 1席だけ取り残す配置は強く避け、占有済みに
 *   くっつけて埋め、空席の連なりは丸ごと使い切る配置を優遇する。
 *   孤立した1席空きを作らないことが最優先のスコア項。
 * - 連続席が無い場合はゾーン内での分割（2か所）がfallback。
 * - 見切れ席を含む配置は、他に手が無い場合の最終手段としてのみ出す。
 * - ゾーン内の空席が人数未満なら割当なし（他ゾーンへは絶対に漏らさない）。
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
import {
  formatSeatList,
  seatStatus,
  type AppData,
  type Reservation,
} from './logic'

export type ZoneId = 'A' | 'B' | 'C' | 'D' | 'E' | 'F' | 'G' | 'H' | 'I'

export const ZONE_IDS: ZoneId[] = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I']

export interface ZoneDef {
  id: ZoneId
  /** 表示名（例: 1階中央・前方） */
  name: string
  /** エリアの短い説明 */
  description: string
}

export const ZONE_DEFS: ZoneDef[] = [
  { id: 'A', name: '1階中央・前方', description: '舞台に近く、出演者の表情までよく見えます' },
  { id: 'B', name: '1階中央・中央', description: '舞台全体を見渡せる、いちばんおすすめのエリアです' },
  { id: 'C', name: '1階中央・後方', description: '少し離れて、舞台全体を落ち着いて見渡せます' },
  { id: 'D', name: '1階左・前方〜中央', description: '1階の左ブロック、前方から中央のエリアです' },
  { id: 'E', name: '1階左・後方', description: '1階の左ブロック、後方のエリアです' },
  { id: 'F', name: '1階右・前方〜中央', description: '1階の右ブロック、前方から中央のエリアです' },
  { id: 'G', name: '1階右・後方', description: '1階の右ブロック、後方のエリアです' },
  {
    id: 'H',
    name: '2階席',
    description:
      '高い位置から、舞台全体を見下ろせます（2階の列番号は21列から始まります）',
  },
  { id: 'I', name: '2階サイド席', description: '側面から、舞台を近くに感じられる席です' },
]

export const ZONE_DEF_BY_ID: ReadonlyMap<ZoneId, ZoneDef> = new Map(
  ZONE_DEFS.map((z) => [z.id, z]),
)

/** 席が属するゾーン。車椅子席・親子室は null（どのゾーンにも属さない） */
export function zoneOfSeat(seat: SeatDef): ZoneId | null {
  if (seat.kind === 'wheelchair' || seat.kind === 'parentRoom') return null
  if (seat.floor === 2) return seat.kind === 'side' ? 'I' : 'H'
  const row = seat.row ?? 0
  if (seat.block === 'center') return row <= 4 ? 'A' : row <= 10 ? 'B' : 'C'
  if (seat.block === 'left') return row <= 10 ? 'D' : 'E'
  if (seat.block === 'right') return row <= 10 ? 'F' : 'G'
  return null
}

function buildZoneSeatIds(): Record<ZoneId, string[]> {
  const out = {} as Record<ZoneId, string[]>
  for (const id of ZONE_IDS) out[id] = []
  // レイアウト順（列・ブロック・番号順）に並ぶよう ALL_SEATS の生成順で振り分ける
  for (const seat of [
    ...ROW_LAYOUT_1F.flatMap((r) => r.blocks.flatMap((b) => b.seats)),
  ]) {
    const z = zoneOfSeat(seat)
    if (z) out[z].push(seat.id)
  }
  for (const seat of [
    ...ROW_LAYOUT_2F.flatMap((r) => r.blocks.flatMap((b) => b.seats)),
    ...SIDE_L_SEATS,
    ...SIDE_R_SEATS,
  ]) {
    const z = zoneOfSeat(seat)
    if (z) out[z].push(seat.id)
  }
  return out
}

/** ゾーンごとの席ID（レイアウト順） */
export const ZONE_SEAT_IDS: Record<ZoneId, string[]> = buildZoneSeatIds()

/** ゾーン内の総席数 */
export function zoneTotalSeats(zone: ZoneId): number {
  return ZONE_SEAT_IDS[zone].length
}

/* ---------------- 空き状況 ---------------- */

/**
 * 「残りわずか」の定義: 残り10席以下（かつ1席以上）。
 * 絶対数で統一する（ゾーンの広さに依らず、お客様にとっての
 * 「もうすぐ無くなる」感覚が揃うため）。
 */
export const LOW_STOCK_REMAINING = 10

export interface ZoneAvailability {
  /** ゾーンの総席数 */
  total: number
  /** 現在の空席数（未割当ホールドを差し引いた、申し込める残り） */
  available: number
  /** 満席（空席0） */
  soldOut: boolean
  /** 残りわずか（LOW_STOCK_REMAINING 以下・満席でない） */
  low: boolean
}

/**
 * ゾーンの「未割当ホールド人数」（R12）。
 * 席がまだ割り当たっていない有効なゾーン予約の人数合計で、その分だけ
 * ゾーンの残席は減る（カウントホールド。特定の席は押さえていない）。
 * - クラウド（お客様画面）: data.zoneHolds にサーバ集計が入っていればそれを使う
 * - ローカル / スタッフ画面: data.reservations から同じ定義で導出する
 */
export function zoneHoldCount(data: AppData, zone: ZoneId): number {
  if (data.zoneHolds) return data.zoneHolds[zone] ?? 0
  let holds = 0
  for (const res of data.reservations) {
    if (res.cancelled) continue
    if (res.zone !== zone) continue
    if (res.seatIds.length > 0) continue
    holds += res.items.length
  }
  return holds
}

export function zoneAvailability(data: AppData, zone: ZoneId): ZoneAvailability {
  const ids = ZONE_SEAT_IDS[zone]
  let freeSeats = 0
  for (const id of ids) {
    if (seatStatus(data, id) === 'available') freeSeats++
  }
  // 物理的な空席から未割当ホールドを差し引いたものが「申し込める残り」
  const available = Math.max(0, freeSeats - zoneHoldCount(data, zone))
  return {
    total: ids.length,
    available,
    soldOut: available === 0,
    low: available > 0 && available <= LOW_STOCK_REMAINING,
  }
}

export function allZoneAvailability(data: AppData): Record<ZoneId, ZoneAvailability> {
  const out = {} as Record<ZoneId, ZoneAvailability>
  for (const id of ZONE_IDS) out[id] = zoneAvailability(data, id)
  return out
}

/* ---------------- ゾーンの仮選択（R14: 座席表を見ながら決める） ---------------- */

/**
 * ゾーンをタップしたときの結果（2段階選択の状態遷移）。
 * お客様はまず座席表の上でゾーンを「仮選択」し、座席表を見たまま
 * 画面下のバーで確定して初めて申込フォームへ進む。
 * - 別のゾーンをタップ → そのゾーンを仮選択（select）
 * - 仮選択中のゾーンをもう一度タップ → 仮選択を維持（select のまま。
 *   R16・C-3: ダブルタップや押し直しで選択が無言で消えると「進めない」
 *   状態になるため、解除は画面下バーの「やめる」だけに一本化した）
 * - 人数分を用意できないゾーン → 仮選択せず案内を出す（insufficient）
 * 満席ゾーンは UI 側でタップ自体を無効化しているため、ここでは扱わない。
 */
export type ZoneTapOutcome =
  | { kind: 'select'; zone: ZoneId }
  | { kind: 'insufficient'; zone: ZoneId; remaining: number }

export function resolveZoneTap(
  selected: ZoneId | null,
  tapped: ZoneId,
  availability: ZoneAvailability,
  partySize: number,
): ZoneTapOutcome {
  if (availability.available < partySize) {
    return { kind: 'insufficient', zone: tapped, remaining: availability.available }
  }
  // 仮選択中のゾーンの再タップは選択維持（解除は「やめる」だけ）
  if (tapped === selected) return { kind: 'select', zone: tapped }
  return { kind: 'select', zone: tapped }
}

/* ---------------- セグメント ---------------- */

interface Segment {
  seatIds: string[]
}

function buildZoneSegments(): Record<ZoneId, Segment[]> {
  const out = {} as Record<ZoneId, Segment[]>
  for (const id of ZONE_IDS) out[id] = []
  for (const layout of [ROW_LAYOUT_1F, ROW_LAYOUT_2F]) {
    for (const row of layout) {
      for (const block of row.blocks) {
        if (block.seats.length === 0) continue
        const z = zoneOfSeat(block.seats[0])
        if (z) out[z].push({ seatIds: block.seats.map((s) => s.id) })
      }
    }
  }
  // 2階サイド席は縦の連なりとして1セグメントずつ（ゾーンI）
  if (SIDE_L_SEATS.length > 0) out.I.push({ seatIds: SIDE_L_SEATS.map((s) => s.id) })
  if (SIDE_R_SEATS.length > 0) out.I.push({ seatIds: SIDE_R_SEATS.map((s) => s.id) })
  return out
}

const ZONE_SEGMENTS = buildZoneSegments()

/* ---------------- 席要約（旧 omakase.ts から移設） ---------------- */

/** 席ID群の要約表示（例: 1階 7列 12〜14番 / 2階 L席 3番） */
export function summarizeSeatIds(seatIds: string[]): string {
  const seats = seatIds.map((id) => seatById(id))
  const parts: string[] = []
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

/* ---------------- 自動割当 ---------------- */

export interface ZoneAssignment {
  zone: ZoneId
  /** 割り当てられた席ID（表示順） */
  seatIds: string[]
  /** 連続ブロックのまとまり。通常は1つ、分割時は2つ */
  groups: string[][]
  /** 2か所に分かれる割当か */
  split: boolean
  /** 見切れ席を含む割当か */
  restricted: boolean
  /** 席の要約表示（例: 1階 7列 12〜14番） */
  summary: string
}

interface Window {
  seatIds: string[]
  segment: Segment
  start: number
  score: number
  restricted: boolean
}

const NO_EXCLUDE: ReadonlySet<string> = new Set()

function isFree(data: AppData, id: string, excluded: ReadonlySet<string>): boolean {
  return !excluded.has(id) && seatStatus(data, id) === 'available'
}

/**
 * 窓のスコア（小さいほど良い）。詰め込み（パッキング）を最優先する:
 * - 孤立した1席空きを作る配置（左右どちらかに1席だけ余らせる）は +120 の
 *   強いペナルティ。他に手がある限り絶対に選ばれない。
 * - 空席の連なりを丸ごと使い切る配置（両側の余り0）は追加ボーナス。
 *   部分的に埋まった列・連なりから先に詰める効果がある。
 * - 占有済み・販売終了の境界に接して埋める配置はボーナス（空席の塊を割らない）。
 * - その上で、セグメント内の中央寄り・列の見やすさ・おすすめゾーンで調整する。
 */
function scoreWindow(
  data: AppData,
  segment: Segment,
  start: number,
  size: number,
  excluded: ReadonlySet<string>,
): number {
  const ids = segment.seatIds
  // 窓を含む「空席の連なり」の範囲
  let runStart = start
  while (runStart > 0 && isFree(data, ids[runStart - 1], excluded)) runStart--
  let runEnd = start + size - 1
  while (runEnd < ids.length - 1 && isFree(data, ids[runEnd + 1], excluded)) runEnd++
  const leftGap = start - runStart
  const rightGap = runEnd - (start + size - 1)
  const runLength = runEnd - runStart + 1

  let score = 0
  // 孤立した1席空きを作らない（最優先）
  if (leftGap === 1) score += 120
  if (rightGap === 1) score += 120
  // 境界に接して詰める
  if (leftGap === 0) score += runStart > 0 ? -8 : -2
  if (rightGap === 0) score += runEnd < ids.length - 1 ? -8 : -2
  // 連なりを丸ごと使い切る（部分的に埋まった連なりを完成させる）
  if (leftGap === 0 && rightGap === 0 && runLength === size) score -= 12
  // セグメント内での中央寄り
  const windowCenter = start + (size - 1) / 2
  const segmentCenter = (ids.length - 1) / 2
  score += (Math.abs(windowCenter - segmentCenter) / Math.max(1, ids.length)) * 20
  // 列の甘さ: 1階は7列前後が最も見やすい。2階は前列寄り
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
  zone: ZoneId,
  size: number,
  allowRestricted: boolean,
  excluded: ReadonlySet<string>,
): Window[] {
  const windows: Window[] = []
  if (size < 1) return windows
  for (const segment of ZONE_SEGMENTS[zone]) {
    const ids = segment.seatIds
    for (let start = 0; start + size <= ids.length; start++) {
      const seatIds = ids.slice(start, start + size)
      if (!seatIds.every((id) => isFree(data, id, excluded))) continue
      const restricted = seatIds.some((id) => seatById(id)?.restrictedView)
      if (restricted && !allowRestricted) continue
      windows.push({
        seatIds,
        segment,
        start,
        score: scoreWindow(data, segment, start, size, excluded),
        restricted,
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

/** 2グループ間の近さ（小さいほど近い）。同セグメント→同列→列の近さ */
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
  const ra = sa.row ?? 24
  const rb = sb.row ?? 24
  if (ra === rb) return 10
  return 10 + Math.abs(ra - rb) * 10
}

/** ゾーン内で連続ブロックが無い場合の分割割当（2グループ、できるだけ近く・大きく） */
function findZoneSplit(
  data: AppData,
  zone: ZoneId,
  partySize: number,
  allowRestricted: boolean,
  excluded: ReadonlySet<string>,
): ZoneAssignment | null {
  const sizeA = Math.ceil(partySize / 2)
  const sizeB = partySize - sizeA
  if (sizeB < 1) return null
  const windowsA = enumerateWindows(data, zone, sizeA, allowRestricted, excluded)
  const windowsB = enumerateWindows(data, zone, sizeB, allowRestricted, excluded)
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
  return {
    zone,
    seatIds,
    groups,
    split: true,
    restricted: best.a.restricted || best.b.restricted,
    summary: summarizeSeatIds(seatIds),
  }
}

function toAssignment(zone: ZoneId, w: Window): ZoneAssignment {
  return {
    zone,
    seatIds: w.seatIds,
    groups: [w.seatIds],
    split: false,
    restricted: w.restricted,
    summary: summarizeSeatIds(w.seatIds),
  }
}

/** ゾーン内の現在の空席数（除外席を除く） */
export function countAvailableInZone(
  data: AppData,
  zone: ZoneId,
  excluded: ReadonlySet<string> = NO_EXCLUDE,
): number {
  let count = 0
  for (const id of ZONE_SEAT_IDS[zone]) {
    if (isFree(data, id, excluded)) count++
  }
  return count
}

/**
 * 選ばれたゾーンの中でだけ、人数分の席を自動で割り当てる。
 * 優先順位: 通常の連続ブロック → 分割 → 見切れ込みの連続ブロック → 見切れ込みの分割。
 * ゾーン内の空席が人数未満、またはどう組んでも揃わない場合は null
 * （呼び出し側は「このゾーンではご用意できません」を案内し、他ゾーンへは漏らさない）。
 *
 * excludeIds は、送信直前に他者に取られた席など「状態がまだ反映されていないが
 * 使えない席」を割当から外すためのもの（SEAT_TAKEN 時の再割当で使う）。
 */
export function assignZoneSeats(
  data: AppData,
  zone: ZoneId,
  partySize: number,
  excludeIds: readonly string[] = [],
): ZoneAssignment | null {
  if (partySize < 1) return null
  const excluded: ReadonlySet<string> =
    excludeIds.length > 0 ? new Set(excludeIds) : NO_EXCLUDE
  if (countAvailableInZone(data, zone, excluded) < partySize) return null
  const windows = enumerateWindows(data, zone, partySize, false, excluded)
  if (windows.length > 0) return toAssignment(zone, windows[0])
  const split = findZoneSplit(data, zone, partySize, false, excluded)
  if (split) return split
  const restrictedWindows = enumerateWindows(data, zone, partySize, true, excluded)
  if (restrictedWindows.length > 0) return toAssignment(zone, restrictedWindows[0])
  return findZoneSplit(data, zone, partySize, true, excluded)
}

/* ---------------- 予約の座席表示（R12） ---------------- */

/** ゾーンの表示名「ゾーンB（1階中央・中央）」。未知のゾーンIDはそのまま出す */
export function zoneLabel(zone: string): string {
  const def = ZONE_DEF_BY_ID.get(zone as ZoneId)
  return def ? `ゾーン${def.id}（${def.name}）` : `ゾーン${zone}`
}

/**
 * 席未確定の案内文（お客様向けに統一する）。
 * R21（評価ラウンド8・C-1）: R17 で当日の受付（チェックイン）でも席が
 * 確定するようになったため、「お支払い後に確定」という旧文言は実挙動と
 * 食い違っていた。支払い・受付のどちらか早い方で確定する、が正しい。
 */
export const SEATS_UNDECIDED_NOTICE = '座席はお支払い時、または当日の受付時に確定します'

export interface ReservationSeatDisplay {
  /** ゾーン予約か */
  isZone: boolean
  /** 席が割り当てられているか */
  assigned: boolean
  /** 一行表示用テキスト（スタッフ一覧・印刷・CSV向け） */
  text: string
}

/**
 * 予約の座席表示を決める（スタッフ・お客様で同じ規則を使う）。
 * - 席が割り当てられていれば従来どおり席の表記（ゾーン予約でも同じ）
 * - ゾーン予約で未割当なら「ゾーン名＋席未確定」。席番号は出さない
 * - ゾーンでないのに席が無い予約は空（通常は存在しない）
 */
export function reservationSeatDisplay(res: Reservation): ReservationSeatDisplay {
  const isZone = typeof res.zone === 'string' && res.zone.length > 0
  if (res.seatIds.length > 0) {
    return { isZone, assigned: true, text: formatSeatList(res.seatIds) }
  }
  if (isZone) {
    return {
      isZone,
      assigned: false,
      text: `${zoneLabel(res.zone as string)}・${res.items.length}名（席未確定）`,
    }
  }
  return { isZone, assigned: false, text: '' }
}

/**
 * 選択済みの席IDから表示用のメタ情報を導く（下書き復元時など、
 * 割当結果オブジェクトが手元に無い場合に使う）。
 * split は「同一セグメント内の連続」になっていない場合に true とみなす。
 */
export function describeSelection(seatIds: string[]): {
  zone: ZoneId | null
  split: boolean
  restricted: boolean
  summary: string
} {
  const seats = seatIds.map((id) => seatById(id))
  const zone = seats.length > 0 ? zoneOfSeat(seats[0]) : null
  const restricted = seats.some((s) => s.restrictedView)
  let split = false
  if (seatIds.length > 1) {
    // セグメントごとにまとめ、連続でなければ分割扱い
    const bySegment = new Map<object, number[]>()
    for (const zoneSegs of Object.values(ZONE_SEGMENTS)) {
      for (const seg of zoneSegs) {
        const idxs = seatIds
          .map((id) => seg.seatIds.indexOf(id))
          .filter((i) => i >= 0)
          .sort((a, b) => a - b)
        if (idxs.length > 0) bySegment.set(seg, idxs)
      }
    }
    if (bySegment.size !== 1) split = true
    else {
      const idxs = [...bySegment.values()][0]
      for (let i = 1; i < idxs.length; i++) {
        if (idxs[i] !== idxs[i - 1] + 1) split = true
      }
    }
  }
  return { zone, split, restricted, summary: summarizeSeatIds(seatIds) }
}
