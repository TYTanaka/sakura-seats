import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  addLastReservation,
  insertLastReservation,
  loadFoldedCodes,
  loadLastReservations,
  MAX_LAST_RESERVATIONS,
  parseFoldedCodes,
  parseLastReservations,
  setReservationFolded,
  type LastReservationSnapshot,
} from './lastReservation'

const KEY = 'sakura-seats-last-reservation-v1'
const FOLDED_KEY = 'sakura-seats-last-reservation-folded-v1'

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

describe('控えの追加', () => {
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
})

describe('公演日・開演時刻（カレンダー導線用）の読み取り', () => {
  it('形式が正しい perfDate / perfTime は引き継がれる', () => {
    const withDate = { ...SNAP_A, perfDate: '2026-12-19', perfTime: '13:00' }
    expect(parseLastReservations(JSON.stringify([withDate]))).toEqual([withDate])
  })

  it('形式が崩れた perfDate / perfTime は「無し」として落とされる', () => {
    const broken = { ...SNAP_A, perfDate: '2026/12/19', perfTime: '13時' }
    const [parsed] = parseLastReservations(JSON.stringify([broken]))
    expect(parsed?.perfDate).toBeUndefined()
    expect(parsed?.perfTime).toBeUndefined()
  })

  it('追加前に保存された控え（項目なし）はそのまま読める', () => {
    expect(parseLastReservations(JSON.stringify([SNAP_A]))).toEqual([SNAP_A])
  })
})

describe('QRトークン（R7）の読み取り', () => {
  it('形式が正しい qrToken は引き継がれる', () => {
    const withToken = { ...SNAP_A, qrToken: 'abcdefghij0123456789AB' }
    expect(parseLastReservations(JSON.stringify([withToken]))).toEqual([withToken])
  })

  it('形式が崩れた qrToken（予約番号など）は「無し」として落とされる', () => {
    const broken = { ...SNAP_A, qrToken: 'SK-0001' }
    const [parsed] = parseLastReservations(JSON.stringify([broken]))
    expect(parsed?.qrToken).toBeUndefined()
  })

  it('追加前に保存された控え（項目なし）はそのまま読める', () => {
    const [parsed] = parseLastReservations(JSON.stringify([SNAP_A]))
    expect(parsed?.qrToken).toBeUndefined()
  })
})

describe('折りたたみ状態の保存', () => {
  it('折りたたみ→読み戻しで往復できる（広げ直しも）', () => {
    stubStorage()
    setReservationFolded('SK-0001', true)
    expect(loadFoldedCodes()).toEqual(new Set(['SK-0001']))
    setReservationFolded('SK-0002', true)
    expect(loadFoldedCodes()).toEqual(new Set(['SK-0001', 'SK-0002']))
    setReservationFolded('SK-0001', false)
    expect(loadFoldedCodes()).toEqual(new Set(['SK-0002']))
  })

  it('折りたたみ保存は控え一覧そのものには触れない', () => {
    const s = stubStorage()
    addLastReservation(SNAP_A)
    setReservationFolded('SK-0001', true)
    expect(loadLastReservations()).toEqual([SNAP_A])
    expect(s.getItem(FOLDED_KEY)).toBe(JSON.stringify(['SK-0001']))
  })

  it('折りたたみ保存が無い端末では全て「広げた」状態（デフォルト）', () => {
    stubStorage()
    expect(loadFoldedCodes().size).toBe(0)
    expect(loadFoldedCodes().has('SK-0001')).toBe(false)
  })

  it('壊れた折りたたみ保存は空集合として扱う', () => {
    expect(parseFoldedCodes(null)).toEqual(new Set())
    expect(parseFoldedCodes('')).toEqual(new Set())
    expect(parseFoldedCodes('{oops')).toEqual(new Set())
    expect(parseFoldedCodes('"SK-0001"')).toEqual(new Set())
    expect(parseFoldedCodes(JSON.stringify(['SK-0001', 42, '', null]))).toEqual(
      new Set(['SK-0001']),
    )
  })
})

describe('電話番号の保持（R25: 控えのキャンセル状態を照会で取り直すため）', () => {
  it('数字のみの電話番号は保存・読み戻しできる', () => {
    stubStorage()
    addLastReservation({ ...SNAP_A, phone: '09011112222' })
    const loaded = loadLastReservations()
    expect(loaded).toHaveLength(1)
    expect(loaded[0].phone).toBe('09011112222')
  })

  it('数字以外を含む値・数値型は落とす（壊れた値で照会しない）', () => {
    expect(
      parseLastReservations(JSON.stringify([{ ...SNAP_A, phone: '090-1111-2222' }]))[0]
        .phone,
    ).toBeUndefined()
    expect(
      parseLastReservations(JSON.stringify([{ ...SNAP_A, phone: 9011112222 }]))[0].phone,
    ).toBeUndefined()
  })

  it('電話番号の無い旧い控えはそのまま読める（phone は undefined）', () => {
    expect(parseLastReservations(JSON.stringify([SNAP_A]))[0].phone).toBeUndefined()
  })
})
