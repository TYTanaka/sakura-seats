import { describe, expect, it } from 'vitest'
import type { Performance, Reservation } from './logic'
import {
  buildLineSharePageUrl,
  buildLineShareReservationUrl,
  SITE_URL,
} from './share'

const perf: Performance = {
  name: 'サンプル公演',
  date: '2026-12-19',
  time: '13:00',
  doorsOpen: '12:30',
  ticketTypes: [{ id: 'adult', name: '大人', price: 2000 }],
  priceNote: '',
  note: '',
}

const reservation: Reservation = {
  id: 'SK-0001',
  seatIds: ['1F-5-10'],
  items: [{ seatId: '1F-5-10', typeId: 'adult', typeName: '大人', price: 2000 }],
  name: '山田 花子',
  phone: '090-0000-0000',
  note: '',
  amount: 2000,
  paid: false,
  checkedIn: false,
  cancelled: false,
  source: 'online',
  createdAt: '2026-11-01T00:00:00.000Z',
}

describe('LINE共有URL', () => {
  it('予約ページ共有は lineit/share で本番URLを指す', () => {
    const url = buildLineSharePageUrl()
    expect(url.startsWith('https://social-plugins.line.me/lineit/share?url=')).toBe(true)
    expect(decodeURIComponent(url)).toContain(SITE_URL)
  })

  it('予約内容共有は line.me/R/msg/text で公演名・座席・予約番号を含む', () => {
    const url = buildLineShareReservationUrl(perf, reservation)
    expect(url.startsWith('https://line.me/R/msg/text/?')).toBe(true)
    const text = decodeURIComponent(url)
    expect(text).toContain('サンプル公演')
    expect(text).toContain('SK-0001')
    expect(text).toContain('大人')
  })
})
