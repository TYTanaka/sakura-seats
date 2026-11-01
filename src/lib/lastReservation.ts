/**
 * 「この端末で予約した控え」のスナップショット一覧（R4・提案3 / R6 でリスト化）。
 * 予約が完了するたびに {予約番号・公演・座席・金額} を端末へ追加で残し、
 * 完了画面がリロードで消えてもトップページで再表示できるようにする。
 * 1人で2回以上買う人もいるため、控えは最新1件ではなく一覧で保持する
 * （上限を超えたら古いものから静かに落とす）。
 * あくまで控えのコピーであり、最新の状態（支払い・キャンセル等）は
 * 予約確認ページで確認してもらう前提。
 */

export interface LastReservationSnapshot {
  code: string
  performanceName: string
  /** 「12月19日（土）13:00開演」のような整形済み日時 */
  whenText: string
  seatLabels: string[]
  amount: number
  savedAt: string
}

/**
 * 保存キー。旧形式（単一オブジェクト）で保存された既存ユーザーの控えを
 * 失わないよう、キーは据え置き、読み取り側で旧形式→リストへ移行する。
 */
const LAST_RESERVATION_KEY = 'sakura-seats-last-reservation-v1'

/** 控えの保持上限（新しい順にこの件数まで） */
export const MAX_LAST_RESERVATIONS = 10

/** 保存・削除を画面側へ知らせるためのイベント名 */
export const LAST_RESERVATION_EVENT = 'sakura-seats:last-reservation-changed'

function notifyChanged(): void {
  try {
    window.dispatchEvent(new Event(LAST_RESERVATION_EVENT))
  } catch {
    // 通知できなくても保存自体は済んでいる
  }
}

/** 1件分の形チェック。形が崩れていたら null（無言で捨てる） */
export function parseLastReservationSnapshot(rec: unknown): LastReservationSnapshot | null {
  if (typeof rec !== 'object' || rec === null) return null
  const r = rec as Partial<LastReservationSnapshot>
  if (typeof r.code !== 'string' || !r.code) return null
  if (typeof r.performanceName !== 'string') return null
  if (typeof r.whenText !== 'string') return null
  if (!Array.isArray(r.seatLabels)) return null
  if (typeof r.amount !== 'number' || !Number.isFinite(r.amount)) return null
  return {
    code: r.code,
    performanceName: r.performanceName,
    whenText: r.whenText,
    seatLabels: r.seatLabels.filter((s): s is string => typeof s === 'string'),
    amount: r.amount,
    savedAt: typeof r.savedAt === 'string' ? r.savedAt : '',
  }
}

/**
 * 保存文字列 → 控え一覧（新しい順）。
 * 新形式（配列）と旧形式（単一オブジェクト＝移行前の保存）の両方を受ける。
 * 旧形式は1件のリストとして読み、そのまま保存し直せば新形式に移行する。
 */
export function parseLastReservations(raw: string | null): LastReservationSnapshot[] {
  if (!raw) return []
  try {
    const parsed: unknown = JSON.parse(raw)
    const records = Array.isArray(parsed) ? parsed : [parsed]
    const seen = new Set<string>()
    const list: LastReservationSnapshot[] = []
    for (const rec of records) {
      const snap = parseLastReservationSnapshot(rec)
      if (!snap || seen.has(snap.code)) continue
      seen.add(snap.code)
      list.push(snap)
      if (list.length >= MAX_LAST_RESERVATIONS) break
    }
    return list
  } catch {
    return []
  }
}

/** 一覧へ1件追加した新しい一覧を返す（同じ番号は新しい控えで置き換え、先頭へ） */
export function insertLastReservation(
  list: LastReservationSnapshot[],
  snapshot: LastReservationSnapshot,
): LastReservationSnapshot[] {
  return [snapshot, ...list.filter((s) => s.code !== snapshot.code)].slice(
    0,
    MAX_LAST_RESERVATIONS,
  )
}

/** 一覧から1件だけ取り除いた新しい一覧を返す */
export function removeLastReservationFromList(
  list: LastReservationSnapshot[],
  code: string,
): LastReservationSnapshot[] {
  return list.filter((s) => s.code !== code)
}

function saveList(list: LastReservationSnapshot[]): void {
  try {
    localStorage.setItem(LAST_RESERVATION_KEY, JSON.stringify(list))
  } catch {
    // 控えのコピーが残せなくても、予約そのものは確定しているので画面は継続する
  }
  notifyChanged()
}

export function loadLastReservations(): LastReservationSnapshot[] {
  try {
    return parseLastReservations(localStorage.getItem(LAST_RESERVATION_KEY))
  } catch {
    return []
  }
}

/** 予約完了時に控えを一覧へ追加する（旧形式で保存されていた控えも一緒に移行する） */
export function addLastReservation(snapshot: LastReservationSnapshot): void {
  saveList(insertLastReservation(loadLastReservations(), snapshot))
}

/** 控えを1件だけ消す（他の控えは残る） */
export function removeLastReservation(code: string): void {
  saveList(removeLastReservationFromList(loadLastReservations(), code))
}
