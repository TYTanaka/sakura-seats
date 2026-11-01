import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  addLastReservation,
  insertLastReservation,
  loadLastReservations,
  MAX_LAST_RESERVATIONS,
  parseLastReservations,
  removeLastReservation,
  removeLastReservationFromList,
  type LastReservationSnapshot,
} from './lastReservation'

const KEY = 'sakura-seats-last-reservation-v1'

const snap = (code: string, seat = '1階 5列 6番'): LastReservationSnapshot => ({
  code,
  performanceName: 'サンプル公演',
  whenText: '12月19日（土）13:00開演',
  seatLabels: [seat],
  amount: 2000,
  savedAt: '2026-12-01T12:00:00.000Z',
})

const SNAP_A = snap('SK-0001')
const SNAP_B = snap('SK-0002', '1階 5列 7番')

class MemoryStorage {
  private map = new Map<string, string>()
  getItem(k: string) {
    return this.map.has(k) ? this.map.get(k)! : null
  }
  setItem(k: string, v: string) {
    this.map.set(k, String(v))
  }
  removeItem(k: string) {
    this.map.delete(k)
  }
  clear() {
    this.map.clear()
  }
}

let storage: MemoryStorage
function stubStorage() {
  storage = new MemoryStorage()
  vi.stubGlobal('localStorage', storage)
  return storage
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('控え一覧の読み取り（R6・リスト化）', () => {
  it('保存した形（配列）をそのまま読み戻せる', () => {
    expect(parseLastReservations(JSON.stringify([SNAP_B, SNAP_A]))).toEqual([SNAP_B, SNAP_A])
  })

  it('空・壊れたJSONは空リスト', () => {
    expect(parseLastReservations(null)).toEqual([])
    expect(parseLastReservations('')).toEqual([])
    expect(parseLastReservations('{oops')).toEqual([])
    expect(parseLastReservations('42')).toEqual([])
  })

  it('形の崩れた要素は落とし、正しい要素だけ残す', () => {
    const raw = JSON.stringify([SNAP_A, { code: 'SK-9' }, null, { ...SNAP_B, amount: '2000' }])
    expect(parseLastReservations(raw)).toEqual([SNAP_A])
  })

  it('座席ラベルの非文字列は取り除かれる', () => {
    const parsed = parseLastReservations(
      JSON.stringify([{ ...SNAP_A, seatLabels: ['1階 5列 6番', 42, null] }]),
    )
    expect(parsed[0]?.seatLabels).toEqual(['1階 5列 6番'])
  })

  it('同じ予約番号が重複していたら先勝ちで1件にする', () => {
    expect(parseLastReservations(JSON.stringify([SNAP_A, SNAP_A]))).toEqual([SNAP_A])
  })
})

describe('旧形式（単一オブジェクト）からの移行', () => {
  it('旧形式の保存文字列は1件のリストとして読める', () => {
    expect(parseLastReservations(JSON.stringify(SNAP_A))).toEqual([SNAP_A])
  })

  it('旧形式が端末に残っていても、新しい予約の追加で控えが消えない', () => {
    const s = stubStorage()
    s.setItem(KEY, JSON.stringify(SNAP_A)) // 移行前の保存
    addLastReservation(SNAP_B)
    expect(loadLastReservations()).toEqual([SNAP_B, SNAP_A])
    // 保存し直された中身は新形式（配列）になっている
    expect(Array.isArray(JSON.parse(s.getItem(KEY)!))).toBe(true)
  })

  it('旧形式が壊れていたら空リストとして扱う', () => {
    expect(parseLastReservations(JSON.stringify({ code: 'SK-1' }))).toEqual([])
  })
})

describe('控えの追加・削除', () => {
  it('2回目の予約を追加しても1回目の控えは消えない（新しい順）', () => {
    stubStorage()
    addLastReservation(SNAP_A)
    addLastReservation(SNAP_B)
    expect(loadLastReservations()).toEqual([SNAP_B, SNAP_A])
  })

  it('同じ番号を保存し直したら置き換わって重複しない', () => {
    const updated = { ...SNAP_A, amount: 4000 }
    expect(insertLastReservation([SNAP_A, SNAP_B], updated)).toEqual([updated, SNAP_B])
  })

  it('上限を超えたら古いものから落ちる', () => {
    stubStorage()
    for (let i = 1; i <= MAX_LAST_RESERVATIONS + 2; i++) {
      addLastReservation(snap(`SK-${String(i).padStart(4, '0')}`))
    }
    const list = loadLastReservations()
    expect(list).toHaveLength(MAX_LAST_RESERVATIONS)
    expect(list[0].code).toBe(`SK-${String(MAX_LAST_RESERVATIONS + 2).padStart(4, '0')}`)
    expect(list.some((s) => s.code === 'SK-0001')).toBe(false)
    expect(list.some((s) => s.code === 'SK-0003')).toBe(true)
  })

  it('1件だけ消しても他の控えは残る', () => {
    stubStorage()
    addLastReservation(SNAP_A)
    addLastReservation(SNAP_B)
    removeLastReservation(SNAP_B.code)
    expect(loadLastReservations()).toEqual([SNAP_A])
  })

  it('removeLastReservationFromList は対象以外をそのまま返す', () => {
    expect(removeLastReservationFromList([SNAP_B, SNAP_A], 'SK-9999')).toEqual([SNAP_B, SNAP_A])
    expect(removeLastReservationFromList([SNAP_B, SNAP_A], SNAP_A.code)).toEqual([SNAP_B])
  })
})
