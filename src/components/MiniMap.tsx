import { useMemo } from 'react'
import {
  PARENT_ROOM_SEATS,
  ROW_LAYOUT_1F,
  ROW_LAYOUT_2F,
  SIDE_L_SEATS,
  SIDE_R_SEATS,
  WHEELCHAIR_SEATS,
  type Floor,
} from '../data/seats'
import { seatStatus, type AppData } from '../lib/logic'

/**
 * 候補カード用の読み取り専用ミニ座席表（模式図）。
 * その階の全席を小さく描き、候補の席だけを目立たせる。タップ操作は一切できない。
 * 満席・販売終了の席は沈ませて表示し、「ホールのどの辺か」が一目で分かるようにする。
 */
export default function MiniMap({
  floor,
  highlight,
  data,
}: {
  floor: Floor
  highlight: string[]
  data: AppData
}) {
  const highlightSet = useMemo(() => new Set(highlight), [highlight])
  const cellClass = (seatId: string): string => {
    if (highlightSet.has(seatId)) return 'mini-seat is-highlight'
    const status = seatStatus(data, seatId)
    return `mini-seat ${status === 'available' ? 'is-free' : 'is-taken'}`
  }
  const layout = floor === 1 ? ROW_LAYOUT_1F : ROW_LAYOUT_2F
  return (
    <div className="mini-map" data-mini-map={floor} aria-hidden="true">
      <div className="mini-stage">舞台</div>
      {layout.map((row) => (
        <div className="mini-row" key={row.row}>
          <span className="mini-row-label">{row.row}</span>
          {row.blocks.map((block) => (
            <div
              className="mini-block"
              key={block.block}
              style={{ flexGrow: block.seats.length }}
            >
              {block.seats.map((seat) => (
                <span key={seat.id} className={cellClass(seat.id)} />
              ))}
            </div>
          ))}
        </div>
      ))}
      {floor === 1 && (
        <>
          <div className="mini-row mini-row-special">
            <span className="mini-row-label">♿</span>
            <div className="mini-block" style={{ flexGrow: 1 }}>
              {WHEELCHAIR_SEATS.map((seat) => (
                <span key={seat.id} className={cellClass(seat.id)} />
              ))}
            </div>
          </div>
          <div className="mini-row mini-row-special">
            <span className="mini-row-label">親</span>
            <div className="mini-block" style={{ flexGrow: 1 }}>
              {PARENT_ROOM_SEATS.map((seat) => (
                <span key={seat.id} className={cellClass(seat.id)} />
              ))}
            </div>
          </div>
        </>
      )}
      {floor === 2 && (
        <div className="mini-row mini-row-special">
          <span className="mini-row-label">サ</span>
          <div className="mini-block" style={{ flexGrow: SIDE_L_SEATS.length }}>
            {SIDE_L_SEATS.map((seat) => (
              <span key={seat.id} className={cellClass(seat.id)} />
            ))}
          </div>
          <div className="mini-block" style={{ flexGrow: SIDE_R_SEATS.length }}>
            {SIDE_R_SEATS.map((seat) => (
              <span key={seat.id} className={cellClass(seat.id)} />
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
