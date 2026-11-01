/**
 * 「直前の予約」の端末内スナップショット（R4・提案3）。
 * 予約完了時に {予約番号・公演・座席・金額} を端末へ残し、完了画面が
 * リロードで消えてもトップページで再表示できるようにする。
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

const LAST_RESERVATION_KEY = 'sakura-seats-last-reservation-v1'

/** 保存・消去を画面側へ知らせるためのイベント名 */
export const LAST_RESERVATION_EVENT = 'sakura-seats:last-reservation-changed'

function notifyChanged(): void {
  try {
    window.dispatchEvent(new Event(LAST_RESERVATION_EVENT))
  } catch {
    // 通知できなくても保存自体は済んでいる
  }
}

/** 保存文字列 → スナップショット。形が崩れていたら null（無言で捨てる） */
export function parseLastReservation(raw: string | null): LastReservationSnapshot | null {
  if (!raw) return null
  try {
    const rec = JSON.parse(raw) as Partial<LastReservationSnapshot>
    if (typeof rec.code !== 'string' || !rec.code) return null
    if (typeof rec.performanceName !== 'string') return null
    if (typeof rec.whenText !== 'string') return null
    if (!Array.isArray(rec.seatLabels)) return null
    if (typeof rec.amount !== 'number' || !Number.isFinite(rec.amount)) return null
    return {
      code: rec.code,
      performanceName: rec.performanceName,
      whenText: rec.whenText,
      seatLabels: rec.seatLabels.filter((s): s is string => typeof s === 'string'),
      amount: rec.amount,
      savedAt: typeof rec.savedAt === 'string' ? rec.savedAt : '',
    }
  } catch {
    return null
  }
}

export function loadLastReservation(): LastReservationSnapshot | null {
  try {
    return parseLastReservation(localStorage.getItem(LAST_RESERVATION_KEY))
  } catch {
    return null
  }
}

export function saveLastReservation(snapshot: LastReservationSnapshot): void {
  try {
    localStorage.setItem(LAST_RESERVATION_KEY, JSON.stringify(snapshot))
  } catch {
    // 控えのコピーが残せなくても、予約そのものは確定しているので画面は継続する
  }
  notifyChanged()
}

export function clearLastReservation(): void {
  try {
    localStorage.removeItem(LAST_RESERVATION_KEY)
  } catch {
    // 何もしない
  }
  notifyChanged()
}
