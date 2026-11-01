import {
  PARENT_ROOM_SEATS,
  ROW_LAYOUT_1F,
  ROW_LAYOUT_2F,
  SIDE_L_SEATS,
  SIDE_R_SEATS,
  WHEELCHAIR_SEATS,
  type Floor,
  type SeatDef,
} from '../data/seats'

export type SeatVisualState = 'available' | 'reserved' | 'paid' | 'blocked' | 'selected'

export interface SeatMapProps {
  floor: Floor
  /** 1 = 100%, 1.25 = 125%, 1.5 = 150% */
  zoom: number
  stateOf: (seat: SeatDef) => SeatVisualState
  onSeatTap: (seat: SeatDef) => void
}

function SeatButton({
  seat,
  state,
  size,
  onSeatTap,
}: {
  seat: SeatDef
  state: SeatVisualState
  size: number
  onSeatTap: (seat: SeatDef) => void
}) {
  return (
    <button
      type="button"
      data-seat-id={seat.id}
      data-seat-state={state}
      className={`seat seat-${state}${seat.restrictedView ? ' seat-restricted' : ''}`}
      style={{ width: size, height: size, fontSize: Math.max(10, Math.round(11 * (size / 30))) }}
      onClick={() => onSeatTap(seat)}
      aria-label={`${seat.label}（${stateLabel(state)}${seat.restrictedView ? '・見切れ席' : ''}）`}
      title={seat.label}
    >
      {seat.shortLabel}
      {seat.restrictedView && <span className="seat-star">※</span>}
    </button>
  )
}

export function stateLabel(state: SeatVisualState): string {
  switch (state) {
    case 'available':
      return '空席'
    case 'selected':
      return '選択中'
    case 'reserved':
      return '予約済み'
    case 'paid':
      return '販売済み'
    case 'blocked':
      return '販売しない'
  }
}

export function SeatLegend() {
  return (
    <div className="legend" aria-label="座席の凡例">
      <span className="legend-item">
        <span className="legend-swatch seat-available" /> 空席
      </span>
      <span className="legend-item">
        <span className="legend-swatch seat-selected" /> 選択中
      </span>
      <span className="legend-item">
        <span className="legend-swatch seat-reserved" /> 予約済み・販売済み
      </span>
      <span className="legend-item">
        <span className="legend-swatch seat-blocked" /> 販売しない
      </span>
      <span className="legend-item">※印は見切れ席（舞台の一部が見えにくい席）</span>
    </div>
  )
}

export default function SeatMap({ floor, zoom, stateOf, onSeatTap }: SeatMapProps) {
  const size = Math.round(30 * zoom)
  const renderSeat = (seat: SeatDef) => (
    <SeatButton
      key={seat.id}
      seat={seat}
      state={stateOf(seat)}
      size={size}
      onSeatTap={onSeatTap}
    />
  )

  return (
    <div className="seatmap-scroll">
      <div className="seatmap" style={{ minWidth: floor === 1 ? 640 : 700 }}>
        <div className="stage" aria-hidden="true">
          舞台
        </div>
        {floor === 1 ? (
          <div className="floor-rows">
            {ROW_LAYOUT_1F.map((rowLayout) => (
              <div key={rowLayout.row}>
                <div className="seat-row">
                  <span className="row-label">{rowLayout.row}列</span>
                  {rowLayout.blocks.map((blk) => (
                    <span key={blk.block} className={`seat-block block-${blk.block}`}>
                      {blk.seats.map(renderSeat)}
                    </span>
                  ))}
                </div>
                {rowLayout.row === 11 && (
                  <div className="seat-row special-row">
                    <span className="row-label">車椅子</span>
                    <span className="seat-block">{WHEELCHAIR_SEATS.map(renderSeat)}</span>
                    <span className="special-note">車椅子席（11〜12列の位置）</span>
                  </div>
                )}
                {rowLayout.row === 12 && <div className="aisle-note">― 通路 ―</div>}
              </div>
            ))}
            <div className="seat-row special-row">
              <span className="row-label">親子室</span>
              <span className="seat-block">{PARENT_ROOM_SEATS.map(renderSeat)}</span>
              <span className="special-note">親子室（16列の後方・室内）</span>
            </div>
          </div>
        ) : (
          <div className="floor2-wrap">
            <div className="side-column">
              <span className="side-label">L席</span>
              {SIDE_L_SEATS.map(renderSeat)}
            </div>
            <div className="floor-rows floor2-rows">
              {ROW_LAYOUT_2F.map((rowLayout) => (
                <div className="seat-row" key={rowLayout.row}>
                  <span className="row-label">{rowLayout.row}列</span>
                  {rowLayout.blocks.map((blk) => (
                    <span key={blk.block} className={`seat-block block-${blk.block}`}>
                      {blk.seats.map(renderSeat)}
                    </span>
                  ))}
                </div>
              ))}
              <p className="floor2-note">2階席は後方ほど横に広い扇形です。両端の※印は見切れ席です。</p>
            </div>
            <div className="side-column">
              <span className="side-label">R席</span>
              {SIDE_R_SEATS.map(renderSeat)}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
