/**
 * ローカルモードの保存リビジョン（R5-1: 2タブ競合対策）。
 *
 * 保存データ本体（sakura-seats-v1）は従来形式のままにし、単調増加のリビジョン
 * 番号だけを別キー（sakura-seats-v1-rev）に持つ。保存の直前に「保存済み
 * リビジョン」と「このタブが知っているリビジョン」を比べ、ずれていたら
 * 他タブが先に保存したと判断して最新を取り込んでから操作し直す。
 * これにより、古い状態を持ったタブが新しい予約を無言で上書きしたり、
 * 予約番号（seq 由来）を再発番したりすることがなくなる。
 */

/** リビジョン文字列の解釈: 0以上の整数でなければ 0（未保存・旧形式は 0 扱い） */
export function parseRevision(raw: string | null): number {
  if (raw === null) return 0
  const n = Number(raw.trim())
  return Number.isInteger(n) && n >= 0 ? n : 0
}

/** 次のリビジョン（保存のたびに +1） */
export function nextRevision(current: number): number {
  return current + 1
}

/**
 * 保存済みリビジョンが自分の知る値と違うか。
 * リビジョンは単調増加なので実質「他タブが先に保存した」判定になる。
 */
export function isStaleRevision(storedRev: number, knownRev: number): boolean {
  return storedRev !== knownRev
}
