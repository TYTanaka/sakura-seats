import { seatById } from '../data/seats'
import { defaultTicketType, formatYen, type Performance } from '../lib/logic'

/**
 * 席ごとの券種セレクタ（お客様の申込フォームとスタッフ当日販売で共用）。
 * 各席の行に券種のセグメントボタンを並べ、選択中の券種を typeBySeat で管理する。
 * 未指定の席はデフォルト券種（リスト先頭）として扱う。
 */
export default function TicketTypePicker({
  perf,
  seatIds,
  typeBySeat,
  onChange,
}: {
  perf: Performance
  seatIds: string[]
  typeBySeat: Record<string, string>
  onChange: (seatId: string, typeId: string) => void
}) {
  const fallbackId = defaultTicketType(perf).id
  return (
    <div className="seat-type-list">
      {seatIds.map((seatId) => {
        const seat = seatById(seatId)
        const current = typeBySeat[seatId] ?? fallbackId
        return (
          <div key={seatId} className="seat-type-row" data-seat-type-row={seatId}>
            <span className="seat-type-label">{seat.label}</span>
            <div className="seg-group" role="group" aria-label={`${seat.label}の券種`}>
              {perf.ticketTypes.map((type) => (
                <button
                  key={type.id}
                  type="button"
                  data-seat-type={`${seatId}:${type.id}`}
                  aria-pressed={current === type.id}
                  className={`seg-btn${current === type.id ? ' active' : ''}`}
                  onClick={() => onChange(seatId, type.id)}
                >
                  {type.name} {formatYen(type.price)}
                </button>
              ))}
            </div>
          </div>
        )
      })}
    </div>
  )
}

/** typeBySeat と券種設定から、席の料金を引く（未指定はデフォルト券種） */
export function priceOfSeat(
  perf: Performance,
  typeBySeat: Record<string, string>,
  seatId: string,
): number {
  const typeId = typeBySeat[seatId] ?? defaultTicketType(perf).id
  return perf.ticketTypes.find((t) => t.id === typeId)?.price ?? 0
}
