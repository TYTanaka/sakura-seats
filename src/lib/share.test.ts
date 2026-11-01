import { describe, expect, it } from 'vitest'
import type { LastReservationSnapshot } from './lastReservation'
import type { Performance, Reservation } from './logic'
import {
  buildLineSharePageUrl,
  buildLineShareReservationUrl,
  buildSnapshotCalendarUrl,
  buildSnapshotGmailUrl,
  buildSnapshotLineUrl,
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
  sellerNames: [],
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

describe('控え（スナップショット）の共有URL', () => {
  const snap: LastReservationSnapshot = {
    code: 'SK-0007',
    performanceName: 'サンプル公演',
    whenText: '12月19日（土）13:00開演',
    seatLabels: ['1階 5列 10番', '1階 5列 11番'],
    amount: 4000,
    savedAt: '2026-11-01T00:00:00.000Z',
    perfDate: '2026-12-19',
    perfTime: '13:00',
  }

  it('Gmail はその控えの番号・公演・座席・金額を含む', () => {
    const url = buildSnapshotGmailUrl(snap)
    expect(url.startsWith('https://mail.google.com/mail/?view=cm&fs=1')).toBe(true)
    const decoded = decodeURIComponent(url)
    expect(decoded).toContain('SK-0007')
    expect(decoded).toContain('サンプル公演')
    expect(decoded).toContain('12月19日（土）13:00開演')
    expect(decoded).toContain('1階 5列 10番')
    expect(decoded).toContain('4,000円')
  })

  it('LINE はその控えの番号・座席を含む', () => {
    const url = buildSnapshotLineUrl(snap)
    expect(url.startsWith('https://line.me/R/msg/text/?')).toBe(true)
    const text = decodeURIComponent(url)
    expect(text).toContain('SK-0007')
    expect(text).toContain('1階 5列 11番')
  })

  it('カレンダーは公演日・開演時刻から日時を作り、控えの番号を含む', () => {
    const url = buildSnapshotCalendarUrl(snap)
    expect(url).not.toBeNull()
    expect(url!.startsWith('https://calendar.google.com/calendar/render?')).toBe(true)
    expect(url).toContain('20261219T130000')
    expect(decodeURIComponent(url!)).toContain('SK-0007')
  })

  it('公演日・開演時刻が無い旧い控えではカレンダーは null（ボタン自体を出さない）', () => {
    const { perfDate: _d, perfTime: _t, ...old } = snap
    expect(buildSnapshotCalendarUrl(old)).toBeNull()
    // Gmail / LINE は整形済み日時で賄えるので作れる
    expect(buildSnapshotGmailUrl(old)).toContain('SK-0007')
    expect(buildSnapshotLineUrl(old)).toContain('SK-0007')
  })
})
