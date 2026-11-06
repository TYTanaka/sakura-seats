import { seatById } from '../data/seats'
import {
  accessNeedsSummary,
  refundChecklist,
  reservationTypeSummary,
  type AppData,
  type Reservation,
} from './logic'
import { zoneLabel } from './zones'

/**
 * 予約一覧の CSV を生成する（Excel で文字化けしないよう BOM 付き UTF-8）。
 * キャンセル済みの予約は含めない。
 * R12: ゾーン列を追加。ゾーン予約の席列は、割り当たるまで空欄になる。
 * R38: 希望（車椅子席・親子室）と備考の列を追加。開場前の準備資料で
 * 希望を拾えるようにするため（第3ラウンド評価 H1）。
 */

const HEADERS = [
  '予約番号',
  '名前',
  '電話',
  'ゾーン',
  '席',
  '券種内訳',
  '金額',
  '支払い',
  '来場',
  '種別',
  '販売者',
  '申込日時',
  '希望',
  '備考',
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
        r.zone ? zoneLabel(r.zone) : '',
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
        // R38: 希望と備考は開場前の準備資料で拾えるよう末尾に足す
        accessNeedsSummary(r.accessNeeds),
        r.note,
      ]
        .map(csvCell)
        .join(','),
    )
  return '\uFEFF' + [HEADERS.join(','), ...rows].join('\r\n') + '\r\n'
}

/* ---------------- 返金チェックリスト（R38・公演中止時） ---------------- */

const REFUND_HEADERS = [
  '予約番号',
  '名前',
  '電話',
  '金額',
  '状態',
  '返金',
  '種別',
  '販売者',
] as const

/**
 * 返金チェックリストの CSV（R38）。
 * 対象は refundChecklist（支払済みの全予約。キャンセル済みでも支払済みなら
 * 返金が必要なため含める）。中止時の返金作業を1件ずつ照合できる形にする。
 */
export function refundChecklistToCsv(data: AppData): string {
  const rows = refundChecklist(data).map((r) =>
    [
      r.id,
      r.name,
      r.phone,
      String(r.amount),
      r.cancelled ? 'キャンセル済み' : '有効',
      r.refunded ? '返金済み' : '未返金',
      r.source === 'door' ? '当日販売' : '予約',
      r.seller ?? '',
    ]
      .map(csvCell)
      .join(','),
  )
  return '\uFEFF' + [REFUND_HEADERS.join(','), ...rows].join('\r\n') + '\r\n'
}

/** ブラウザで返金チェックリスト CSV をダウンロードさせる */
export function downloadRefundChecklistCsv(data: AppData): void {
  const csv = refundChecklistToCsv(data)
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = '返金チェックリスト.csv'
  document.body.appendChild(a)
  a.click()
  a.remove()
  URL.revokeObjectURL(url)
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
