import { seatById } from '../data/seats'
import {
  formatPerformanceWhen,
  formatYen,
  type Performance,
  type Reservation,
} from './logic'
import { SEATS_UNDECIDED_NOTICE, zoneLabel } from './zones'
import type { LastReservationSnapshot } from './lastReservation'

/**
 * 予約完了後の「自分の控え」用リンク生成。
 * - Gmailで自分に送る: Gmail の作成画面URL（件名・本文をプリフィル。宛先はお客様自身で入力）
 * - カレンダーに追加: Google カレンダーのイベント作成テンプレートURL
 *   （公演の所要時間は仮に2時間として登録する）
 */

function seatLines(reservation: Reservation): string {
  // R12: ゾーン予約で席が未確定の間は、席番号ではなくゾーンと案内を出す
  // R21: 確定タイミングの文言は SEATS_UNDECIDED_NOTICE に統一（支払い/受付の早い方）
  if (reservation.zone && reservation.seatIds.length === 0) {
    return `${zoneLabel(reservation.zone)}・${reservation.items.length}名\n${SEATS_UNDECIDED_NOTICE}`
  }
  return reservation.items
    .map((item) => `${seatById(item.seatId).label}（${item.typeName} ${formatYen(item.price)}）`)
    .join('\n')
}

export function buildGmailUrl(perf: Performance, reservation: Reservation): string {
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
    '変更は主催者までご連絡ください。キャンセルは『予約確認』からもできます。',
  ].join('\n')
  return `https://mail.google.com/mail/?view=cm&fs=1&su=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`
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

/**
 * サイトURLの組み立て（純粋関数）: origin + ベースパス（末尾スラッシュ付き）。
 * 配信先（GitHub Pages / Cloudflare Pages）やパスが変わってもコードを
 * 変えなくて済むよう、実行時の location と Vite の BASE_URL から導出する。
 */
export function siteUrlFrom(origin: string, base: string): string {
  const withSlash = base.endsWith('/') ? base : `${base}/`
  const path = withSlash.startsWith('/') ? withSlash : `/${withSlash}`
  return `${origin}${path}`
}

/** 実行中ページのサイトURL（ブラウザ外では従来の本番URLにフォールバック） */
export function currentSiteUrl(): string {
  if (typeof window === 'undefined') return 'https://tytanaka.github.io/sakura-seats/'
  return siteUrlFrom(window.location.origin, import.meta.env.BASE_URL)
}

/** 本番サイトのURL（LINEで送る「予約ページ」のリンク先） */
export const SITE_URL = currentSiteUrl()

/** 予約ページURLを LINE で送る（LINE公式のシェアボタン用URL） */
export function buildLineSharePageUrl(): string {
  return `https://social-plugins.line.me/lineit/share?url=${encodeURIComponent(currentSiteUrl())}`
}

/** 自分の予約内容（公演・日時・座席・予約番号）を LINE で送る */
export function buildLineShareReservationUrl(
  perf: Performance,
  reservation: Reservation,
): string {
  const text = [
    `【予約控え】${perf.name}`,
    `日時: ${formatPerformanceWhen(perf)}`,
    `予約番号: ${reservation.id}`,
    '座席:',
    seatLines(reservation),
    `合計: ${formatYen(reservation.amount)}（当日現金払い）`,
    '当日は受付でお名前と予約番号をお伝えのうえ、現金でお支払いください。',
  ].join('\n')
  return `https://line.me/R/msg/text/?${encodeURIComponent(text)}`
}

/* ================= 控え（端末保存スナップショット）用の共有リンク =================
 * 完了画面と同じ文面を、端末に残した控えから作り直すための生成関数群。
 * 控えには席ごとの券種・料金が無いため、座席はラベルの列挙になる。
 * 日時は整形済みの whenText を使う（Gmail / LINE）。
 * カレンダーだけは実日付が必要なので、perfDate / perfTime を持たない
 * 旧い控えでは null を返し、画面側はボタン自体を出さない。
 */

function snapshotSeatLines(snap: LastReservationSnapshot): string {
  // R12: ゾーン予約の控えは席番号を持たない（確定はお支払い時または当日の受付時・R21）
  if (snap.zoneLabel) {
    return `${snap.zoneLabel}・${snap.partySize ?? ''}名\n${SEATS_UNDECIDED_NOTICE}`
  }
  return snap.seatLabels.join('\n')
}

export function buildSnapshotGmailUrl(snap: LastReservationSnapshot): string {
  const subject = `【予約控え】${snap.performanceName} 予約番号 ${snap.code}`
  const body = [
    `${snap.performanceName} のご予約控えです。`,
    '',
    `公演: ${snap.performanceName}`,
    `日時: ${snap.whenText}`,
    `予約番号: ${snap.code}`,
    '座席:',
    snapshotSeatLines(snap),
    `合計: ${formatYen(snap.amount)}（当日現金払い）`,
    '',
    '当日は受付でお名前と予約番号をお伝えのうえ、現金でお支払いください。',
    '変更は主催者までご連絡ください。キャンセルは『予約確認』からもできます。',
  ].join('\n')
  return `https://mail.google.com/mail/?view=cm&fs=1&su=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`
}

export function buildSnapshotLineUrl(snap: LastReservationSnapshot): string {
  const text = [
    `【予約控え】${snap.performanceName}`,
    `日時: ${snap.whenText}`,
    `予約番号: ${snap.code}`,
    '座席:',
    snapshotSeatLines(snap),
    `合計: ${formatYen(snap.amount)}（当日現金払い）`,
    '当日は受付でお名前と予約番号をお伝えのうえ、現金でお支払いください。',
  ].join('\n')
  return `https://line.me/R/msg/text/?${encodeURIComponent(text)}`
}

/** 控え用のカレンダー登録URL。公演日・開演時刻が無い控えでは null */
export function buildSnapshotCalendarUrl(snap: LastReservationSnapshot): string | null {
  if (!snap.perfDate || !snap.perfTime) return null
  const details = [
    `予約番号: ${snap.code}`,
    '座席:',
    snapshotSeatLines(snap),
    `合計: ${formatYen(snap.amount)}（当日現金払い）`,
    '当日は受付でお名前と予約番号をお伝えください。',
  ].join('\n')
  const params = new URLSearchParams({
    action: 'TEMPLATE',
    text: snap.performanceName,
    dates: `${toCalendarStamp(snap.perfDate, snap.perfTime)}/${toCalendarStamp(snap.perfDate, snap.perfTime, 2)}`,
    details,
    location: '戸塚区民文化センター さくらプラザ・ホール',
  })
  return `https://calendar.google.com/calendar/render?${params.toString()}`
}
