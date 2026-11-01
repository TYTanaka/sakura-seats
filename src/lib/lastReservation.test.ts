import { describe, expect, it } from 'vitest'
import { parseLastReservation, type LastReservationSnapshot } from './lastReservation'

const SNAP: LastReservationSnapshot = {
  code: 'SK-0042',
  performanceName: 'サンプル公演',
  whenText: '12月19日（土）13:00開演',
  seatLabels: ['1階 5列 6番', '1階 5列 7番'],
  amount: 3000,
  savedAt: '2026-12-01T12:00:00.000Z',
}

describe('直前の予約スナップショット（R4・F3）', () => {
  it('保存した形をそのまま読み戻せる', () => {
    expect(parseLastReservation(JSON.stringify(SNAP))).toEqual(SNAP)
  })

  it('空・壊れたJSON・必須項目の欠落は null', () => {
    expect(parseLastReservation(null)).toBeNull()
    expect(parseLastReservation('')).toBeNull()
    expect(parseLastReservation('{oops')).toBeNull()
    expect(parseLastReservation(JSON.stringify({ code: 'SK-1' }))).toBeNull()
    expect(parseLastReservation(JSON.stringify({ ...SNAP, amount: '3000' }))).toBeNull()
  })

  it('座席ラベルの非文字列は取り除かれる', () => {
    const parsed = parseLastReservation(
      JSON.stringify({ ...SNAP, seatLabels: ['1階 5列 6番', 42, null] }),
    )
    expect(parsed?.seatLabels).toEqual(['1階 5列 6番'])
  })
})
