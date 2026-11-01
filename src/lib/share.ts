import { seatById } from '../data/seats'
import {
  formatPerformanceWhen,
  formatYen,
  type Performance,
  type Reservation,
} from './logic'

/**
 * 予約完了後の「自分の控え」用リンク生成。
 * - Gmailで自分に送る: mailto リンク（宛先は空。お客様自身のアドレスを入れて送る）
 * - カレンダーに追加: Google カレンダーのイベント作成テンプレートURL
 *   （公演の所要時間は仮に2時間として登録する）
 */

function seatLines(reservation: Reservation): string {
  return reservation.items
    .map((item) => `${seatById(item.seatId).label}（${item.typeName} ${formatYen(item.price)}）`)
    .join('\n')
}

export function buildMailtoUrl(perf: Performance, reservation: Reservation): string {
  const subject = `【予約控え】${perf.name} 予約番号 ${reservation.id}`
  const body = [
    `${perf.name} のご予約控えです。`,
    '',
    `公演: ${perf.name}`,
    `日時: ${formatPerformanceWhen(perf)}`,
    `予約番号: ${reservation.id}`,
    `お名前: ${reservation.name} 様`,
    '座席:',
    seatLines(reservation),
    `合計: ${formatYen(reservation.amount)}（当日現金払い）`,
    '',
    '当日は受付でお名前と予約番号をお伝えのうえ、現金でお支払いください。',
    '変更・キャンセルは主催者までご連絡ください。',
  ].join('\n')
  return `mailto:?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`
}

/** 'YYYY-MM-DD' + 'HH:mm' から Google カレンダー形式 (YYYYMMDDTHHmmss) を作る */
function toCalendarStamp(date: string, time: string, addHours = 0): string {
  const d = new Date(`${date}T${time}:00`)
  if (addHours) d.setHours(d.getHours() + addHours)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}T${pad(d.getHours())}${pad(d.getMinutes())}00`
}

export function buildCalendarUrl(perf: Performance, reservation: Reservation): string {
  const details = [
    `予約番号: ${reservation.id}`,
    '座席:',
    seatLines(reservation),
    `合計: ${formatYen(reservation.amount)}（当日現金払い）`,
    '当日は受付でお名前と予約番号をお伝えください。',
  ].join('\n')
  const params = new URLSearchParams({
    action: 'TEMPLATE',
    text: perf.name,
    dates: `${toCalendarStamp(perf.date, perf.time)}/${toCalendarStamp(perf.date, perf.time, 2)}`,
    details,
    location: '戸塚区民文化センター さくらプラザ・ホール',
  })
  return `https://calendar.google.com/calendar/render?${params.toString()}`
}
