import { seatById } from '../data/seats'
import { reservationTypeSummary, type Reservation } from './logic'

/**
 * 予約一覧の CSV を生成する（Excel で文字化けしないよう BOM 付き UTF-8）。
 * キャンセル済みの予約は含めない。
 */

const HEADERS = [
  '予約番号',
  '名前',
  '電話',
  '席',
  '券種内訳',
  '金額',
  '支払い',
  '来場',
  '種別',
  '販売者',
  '申込日時',
] as const

function csvCell(value: string): string {
  if (/[",\n\r]/.test(value)) return `"${value.replace(/"/g, '""')}"`
  return value
}

function formatDateTime(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}/${pad(d.getMonth() + 1)}/${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

export function reservationsToCsv(reservations: Reservation[]): string {
  const rows = reservations
    .filter((r) => !r.cancelled)
    .map((r) =>
      [
        r.id,
        r.name,
        r.phone,
        r.seatIds.map((id) => seatById(id).label).join('、'),
        reservationTypeSummary(r),
        // 金額は「3,000円」のような文字列ではなく数値そのものにする。
        // 表計算ソフトでそのまま合計できるようにするため（R6・O-4）
        String(r.amount),
        r.paid ? '支払済' : '未払い',
        r.checkedIn ? '来場済' : '',
        r.source === 'door' ? '当日販売' : '予約',
        // 販売者別内訳と突き合わせできるよう販売者列を出す（R6・O-4）
        r.seller ?? '',
        formatDateTime(r.createdAt),
      ]
        .map(csvCell)
        .join(','),
    )
  return '\uFEFF' + [HEADERS.join(','), ...rows].join('\r\n') + '\r\n'
}

/** ブラウザで CSV ファイルとしてダウンロードさせる */
export function downloadReservationsCsv(reservations: Reservation[]): void {
  const csv = reservationsToCsv(reservations)
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = '予約一覧.csv'
  document.body.appendChild(a)
  a.click()
  a.remove()
  URL.revokeObjectURL(url)
}
