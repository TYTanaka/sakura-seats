import { describe, expect, it } from 'vitest'
import {
  checkInByToken,
  createReservation,
  defaultPerformance,
  emptyData,
  type AppData,
} from './logic'
import { generateQrToken } from './qrToken'

/** テスト用: 1件予約したデータと、その予約を返す */
function dataWithReservation(): { data: AppData; token: string; id: string } {
  const base = emptyData()
  const { data, reservation } = createReservation(base, {
    seats: [{ seatId: '1F-5-12', typeId: 'adult' }],
    name: '検証 太郎',
    phone: '09000000000',
    note: '',
    source: 'online',
  })
  if (!reservation.qrToken) throw new Error('token が発行されていません')
  return { data, token: reservation.qrToken, id: reservation.id }
}

const NOW = new Date('2026-12-19T12:45:00.000Z')

describe('checkInByToken（ローカルQR受付の状態機械）', () => {
  it('正しいトークン → OK で checkedIn + 受付日時が記録される', () => {
    const { data, token } = dataWithReservation()
    const out = checkInByToken(data, token, NOW)
    expect(out.result).toBe('OK')
    expect(out.reservation?.checkedIn).toBe(true)
    expect(out.reservation?.checkedInAt).toBe(NOW.toISOString())
    // 元データは変更しない（純粋関数）
    expect(data.reservations[0].checkedIn).toBe(false)
  })

  it('2回目の受付 → ALREADY_CHECKED_IN（元の受付日時を返す・二重受付しない）', () => {
    const { data, token } = dataWithReservation()
    const first = checkInByToken(data, token, NOW)
    const second = checkInByToken(first.data, token, new Date('2026-12-19T13:00:00Z'))
    expect(second.result).toBe('ALREADY_CHECKED_IN')
    expect(second.reservation?.checkedInAt).toBe(NOW.toISOString())
  })

  it('キャンセル済み → CANCELLED', () => {
    const { data, token, id } = dataWithReservation()
    const cancelled: AppData = {
      ...data,
      reservations: data.reservations.map((r) =>
        r.id === id ? { ...r, cancelled: true } : r,
      ),
    }
    const out = checkInByToken(cancelled, token, NOW)
    expect(out.result).toBe('CANCELLED')
    expect(out.reservation?.id).toBe(id)
  })

  it('別の公演で発行されたトークン → WRONG_PERFORMANCE（日付 or 公演名の相違）', () => {
    const { data, token } = dataWithReservation()
    const otherDate: AppData = {
      ...data,
      performance: { ...defaultPerformance(), date: '2027-05-15' },
    }
    expect(checkInByToken(otherDate, token, NOW).result).toBe('WRONG_PERFORMANCE')
    const otherName: AppData = {
      ...data,
      performance: { ...defaultPerformance(), name: '別の公演' },
    }
    expect(checkInByToken(otherName, token, NOW).result).toBe('WRONG_PERFORMANCE')
    // 同じ公演設定なら通常どおり OK
    expect(checkInByToken(data, token, NOW).result).toBe('OK')
  })

  it('存在しないトークン（偽造）→ NOT_FOUND、データは不変', () => {
    const { data } = dataWithReservation()
    const forged = generateQrToken()
    const out = checkInByToken(data, forged, NOW)
    expect(out.result).toBe('NOT_FOUND')
    expect(out.reservation).toBeNull()
    expect(out.data).toBe(data)
  })

  it('1文字改ざんしたトークン → NOT_FOUND', () => {
    const { data, token } = dataWithReservation()
    const tampered = (token[0] === 'A' ? 'B' : 'A') + token.slice(1)
    expect(checkInByToken(data, tampered, NOW).result).toBe('NOT_FOUND')
  })

  it('優先順位: 別公演 かつ キャンセル済み → WRONG_PERFORMANCE が先', () => {
    const { data, token, id } = dataWithReservation()
    const both: AppData = {
      ...data,
      performance: { ...defaultPerformance(), date: '2027-05-15' },
      reservations: data.reservations.map((r) =>
        r.id === id ? { ...r, cancelled: true } : r,
      ),
    }
    expect(checkInByToken(both, token, NOW).result).toBe('WRONG_PERFORMANCE')
  })

  it('createReservation は公演スナップショットとトークンを記録する', () => {
    const { data, id } = dataWithReservation()
    const r = data.reservations.find((x) => x.id === id)
    expect(r?.perfDate).toBe(data.performance.date)
    expect(r?.perfName).toBe(data.performance.name)
    expect(r?.qrToken).toHaveLength(22)
  })
})
