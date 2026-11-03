/**
 * 「この端末で予約した控え」のスナップショット一覧（R4・提案3 / R6 でリスト化）。
 * 予約が完了するたびに {予約番号・公演・座席・金額} を端末へ追加で残し、
 * 完了画面がリロードで消えてもトップページで再表示できるようにする。
 * 1人で2回以上買う人もいるため、控えは最新1件ではなく一覧で保持する
 * （上限を超えたら古いものから静かに落とす）。
 * あくまで控えのコピーであり、最新の状態（支払い・キャンセル等）は
 * 予約確認ページで確認してもらう前提。
 *
 * 控えの削除はできない（誤操作防止のため、ユーザー判断で削除UI自体を廃止）。
 * 長くなった一覧は各カードを「小さくする」で1行に折りたためる。
 * 折りたたみ状態は予約番号ごとに端末へ保存し、リロード後も保たれる。
 */

import { isQrToken } from './qrToken'

export interface LastReservationSnapshot {
  code: string
  performanceName: string
  /** 「12月19日（土）13:00開演」のような整形済み日時 */
  whenText: string
  seatLabels: string[]
  amount: number
  savedAt: string
  /**
   * 公演日（YYYY-MM-DD）。控えからカレンダー登録リンクを作るために保存する。
   * この項目が追加される前に保存された控えには無いため任意項目とし、
   * 無い場合はカレンダー導線を出さない（Gmail / LINE は whenText で賄える）。
   */
  perfDate?: string
  /** 開演時刻（HH:mm）。perfDate と同じ扱い */
  perfTime?: string
  /**
   * 受付用 QR トークン（R7）。控えの QR はこのトークンから作り直す。
   * この項目が追加される前に保存された控えには無いため任意項目とし、
   * 無い場合は QR ではなく予約番号を表示する。
   */
  qrToken?: string
  /**
   * ゾーン予約の控え表示用（R12）: 「ゾーンB（1階中央・中央）」のような
   * 整形済みゾーン名。ゾーン予約では seatLabels は空で、こちらと
   * partySize で内容を表す。従来型の控えには無いため任意項目。
   */
  zoneLabel?: string
  /** ゾーン予約の人数（R12）。zoneLabel と対で使う */
  partySize?: number
  /**
   * 申込時の電話番号（正規化済み・数字のみ。R25）。
   * 控えの現在状態（キャンセル済みかどうか）を、クラウドモードで
   * 照会 RPC（予約番号＋電話番号）から取り直すために保存する。
   * 自分の端末・自分の番号であり、申込下書きも同じ形で端末内に残る。
   * この項目が追加される前に保存された控えには無いため任意項目とし、
   * 無い場合は端末内ストアで分かる範囲（ローカルモード等）だけを反映する。
   */
  phone?: string
}

/**
 * 保存キー。旧形式（単一オブジェクト）で保存された既存ユーザーの控えを
 * 失わないよう、キーは据え置き、読み取り側で旧形式→リストへ移行する。
 */
const LAST_RESERVATION_KEY = 'sakura-seats-last-reservation-v1'

/** 控えの保持上限（新しい順にこの件数まで） */
export const MAX_LAST_RESERVATIONS = 10

/** 保存・折りたたみ変更を画面側へ知らせるためのイベント名 */
export const LAST_RESERVATION_EVENT = 'sakura-seats:last-reservation-changed'

function notifyChanged(): void {
  try {
    window.dispatchEvent(new Event(LAST_RESERVATION_EVENT))
  } catch {
    // 通知できなくても保存自体は済んでいる
  }
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/
const TIME_RE = /^\d{2}:\d{2}$/

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
    // 形式が正しいものだけ引き継ぐ（旧い控えや壊れた値は「無し」として扱う）
    ...(typeof r.perfDate === 'string' && DATE_RE.test(r.perfDate)
      ? { perfDate: r.perfDate }
      : {}),
    ...(typeof r.perfTime === 'string' && TIME_RE.test(r.perfTime)
      ? { perfTime: r.perfTime }
      : {}),
    ...(isQrToken(r.qrToken) ? { qrToken: r.qrToken } : {}),
    ...(typeof r.zoneLabel === 'string' && r.zoneLabel ? { zoneLabel: r.zoneLabel } : {}),
    ...(typeof r.partySize === 'number' && Number.isFinite(r.partySize) && r.partySize > 0
      ? { partySize: Math.floor(r.partySize) }
      : {}),
    // 電話番号は数字のみの形だけを引き継ぐ（壊れた値・旧形式は「無し」として扱う）
    ...(typeof r.phone === 'string' && /^[0-9]+$/.test(r.phone) ? { phone: r.phone } : {}),
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

/* ================= 折りたたみ状態（予約番号ごと） ================= */

/** 折りたたんだ控えの予約番号一覧を保存するキー */
const FOLDED_KEY = 'sakura-seats-last-reservation-folded-v1'

/** 保存文字列 → 折りたたみ中の予約番号集合。壊れた値は無言で捨てる */
export function parseFoldedCodes(raw: string | null): Set<string> {
  if (!raw) return new Set()
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return new Set()
    return new Set(parsed.filter((v): v is string => typeof v === 'string' && !!v))
  } catch {
    return new Set()
  }
}

/** 折りたたみ中の予約番号集合を読む（保存が無ければ全て「広げた」状態） */
export function loadFoldedCodes(): Set<string> {
  try {
    return parseFoldedCodes(localStorage.getItem(FOLDED_KEY))
  } catch {
    return new Set()
  }
}

/** 1件分の折りたたみ状態を保存する（控え自体は消えない） */
export function setReservationFolded(code: string, folded: boolean): void {
  const codes = loadFoldedCodes()
  if (folded) codes.add(code)
  else codes.delete(code)
  try {
    localStorage.setItem(FOLDED_KEY, JSON.stringify([...codes]))
  } catch {
    // 折りたたみ状態が残せなくても、控えの表示自体は継続する
  }
  notifyChanged()
}
