import { describe, expect, it } from 'vitest'
import { createReservation, emptyData } from './logic'
import { reservationsToCsv } from './csv'

function sampleReservations() {
  const r1 = createReservation(emptyData(), {
    seats: [
      { seatId: '1F-5-6', typeId: 'adult' },
      { seatId: '1F-5-7', typeId: 'child' },
    ],
    name: '山田,花子',
    phone: '090-0000-0000',
    note: '',
    source: 'online',
  })
  const r2 = createReservation(r1.data, {
    seats: [{ seatId: '1F-5-8', typeId: 'adult' }],
    name: '当日',
    phone: '',
    note: '',
    source: 'door',
  })
  return [r1.reservation, r2.reservation]
}

describe('reservationsToCsv', () => {
  it('BOM 付きで始まり、ヘッダー行が仕様通り', () => {
    const csv = reservationsToCsv(sampleReservations())
    expect(csv.charCodeAt(0)).toBe(0xfeff)
    const header = csv.slice(1).split('\r\n')[0]
    expect(header).toBe('予約番号,名前,電話,席,券種内訳,金額,支払い,来場,種別,販売者,申込日時')
  })

  it('予約行に席ラベル・券種内訳・金額・種別が入る', () => {
    const csv = reservationsToCsv(sampleReservations())
    expect(csv).toContain('SK-0001')
    expect(csv).toContain('大人×1・子供×1')
    expect(csv).toContain('未払い')
    expect(csv).toContain('予約')
    expect(csv).toContain('SK-0002')
    expect(csv).toContain('当日販売')
    expect(csv).toContain('支払済')
  })

  it('金額は数値列（円やカンマ付き文字列ではない）で表計算で合計できる（R6・O-4）', () => {
    const r = createReservation(emptyData(), {
      seats: [
        { seatId: '1F-5-6', typeId: 'adult' },
        { seatId: '1F-5-7', typeId: 'child' },
      ],
      name: '山田花子',
      phone: '09000000000',
      note: '',
      source: 'online',
    })
    const csv = reservationsToCsv([r.reservation])
    const lines = csv.slice(1).split('\r\n').filter(Boolean)
    const amountCol = lines[0].split(',').indexOf('金額')
    const row = lines[1].split(',')
    // 大人2,000 + 子供1,000 = 3000 がそのまま数値として入る
    expect(row[amountCol]).toBe('3000')
    expect(csv).not.toContain('円')
  })

  it('販売者列に販売者が入り、Web予約では空になる（R6・O-4）', () => {
    const web = createReservation(emptyData(), {
      seats: [{ seatId: '1F-5-6', typeId: 'adult' }],
      name: '山田花子',
      phone: '09000000000',
      note: '',
      source: 'online',
    })
    const door = createReservation(web.data, {
      seats: [{ seatId: '1F-5-7', typeId: 'adult' }],
      name: '当日',
      phone: '',
      note: '',
      source: 'door',
      seller: '田中',
    })
    const csv = reservationsToCsv([web.reservation, door.reservation])
    const lines = csv.slice(1).split('\r\n').filter(Boolean)
    const sellerCol = lines[0].split(',').indexOf('販売者')
    expect(sellerCol).toBeGreaterThan(0)
    const doorRow = lines.find((l) => l.includes(door.reservation.id))!.split(',')
    const webRow = lines.find((l) => l.includes(web.reservation.id))!.split(',')
    expect(doorRow[sellerCol]).toBe('田中')
    expect(webRow[sellerCol]).toBe('')
  })

  it('カンマを含む名前はクォートでエスケープされる', () => {
    const csv = reservationsToCsv(sampleReservations())
    expect(csv).toContain('"山田,花子"')
  })

  it('キャンセル済みの予約は含めない', () => {
    const [a] = sampleReservations()
    const csv = reservationsToCsv([{ ...a, cancelled: true }])
    expect(csv).not.toContain('SK-0001')
  })
})
