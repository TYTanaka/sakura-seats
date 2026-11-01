import { useLayoutEffect, useRef, useState } from 'react'
import {
  PARENT_ROOM_SEATS,
  ROW_LAYOUT_1F,
  ROW_LAYOUT_2F,
  SIDE_L_SEATS,
  SIDE_R_SEATS,
  WHEELCHAIR_SEATS,
  isRecommendedSeat,
  type Floor,
  type SeatDef,
} from '../data/seats'

export type SeatVisualState = 'available' | 'reserved' | 'paid' | 'blocked' | 'selected'

/** 数値は倍率（1 = 100%）。'fit' はホール全体が横幅に収まる全体表示 */
export type SeatZoom = number | 'fit'

export interface SeatMapProps {
  floor: Floor
  /** 1 = 100%, 1.25 = 125%, 1.5 = 150%, 'fit' = 全体表示 */
  zoom: SeatZoom
  stateOf: (seat: SeatDef) => SeatVisualState
  onSeatTap: (seat: SeatDef) => void
  /** おすすめ席の金色ティントを表示するか（お客様用マップのみ） */
  showRecommended?: boolean
}

function SeatButton({
  seat,
  state,
  size,
  onSeatTap,
  recommended,
}: {
  seat: SeatDef
  state: SeatVisualState
  size: number
  onSeatTap: (seat: SeatDef) => void
  recommended?: boolean
}) {
  return (
    <button
      type="button"
      data-seat-id={seat.id}
      data-seat-state={state}
      data-recommended={recommended || undefined}
      className={`seat seat-${state}${seat.restrictedView ? ' seat-restricted' : ''}${recommended ? ' seat-recommended' : ''}`}
      style={{ width: size, height: size, fontSize: Math.max(10, Math.round(11 * (size / 30))) }}
      onClick={() => onSeatTap(seat)}
      aria-label={`${seat.label}（${stateLabel(state)}${seat.restrictedView ? '・見切れ席' : ''}${recommended ? '・おすすめ' : ''}）`}
      title={seat.label}
    >
      {seat.shortLabel}
      {seat.restrictedView && <span className="seat-star">※</span>}
      {recommended && !seat.restrictedView && <span className="seat-star seat-star-rec">★</span>}
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
      <span className="legend-item">
        <span className="legend-swatch seat-recommended-swatch" /> ★おすすめ席（1階中央 5〜10列）
      </span>
    </div>
  )
}

export default function SeatMap({ floor, zoom, stateOf, onSeatTap, showRecommended }: SeatMapProps) {
  const isFit = zoom === 'fit'
  // 全体表示では等倍レイアウトを実測して縮小する（階ごとに自然幅が違うため割合は固定しない）
  const size = Math.round(30 * (isFit ? 1 : zoom))
  const scrollRef = useRef<HTMLDivElement>(null)
  const mapRef = useRef<HTMLDivElement>(null)
  const [fit, setFit] = useState<{ scale: number; width: number; height: number } | null>(null)

  useLayoutEffect(() => {
    if (!isFit) {
      setFit(null)
      return
    }
    const measure = () => {
      const scroll = scrollRef.current
      const map = mapRef.current
      if (!scroll || !map) return
      // .seatmap-scroll の左右パディング（2px × 2）を除いた表示可能幅
      const avail = scroll.clientWidth - 4
      // offsetWidth/Height は transform の影響を受けないレイアウト上の自然サイズ
      const naturalWidth = map.offsetWidth
      const naturalHeight = map.offsetHeight
      if (avail <= 0 || naturalWidth <= 0 || naturalHeight <= 0) return
      const scale = Math.min(1, avail / naturalWidth)
      setFit({ scale, width: avail, height: Math.ceil(naturalHeight * scale) })
    }
    measure()
    window.addEventListener('resize', measure)
    return () => window.removeEventListener('resize', measure)
  }, [isFit, floor])

  const renderSeat = (seat: SeatDef) => {
    const state = stateOf(seat)
    return (
      <SeatButton
        key={seat.id}
        seat={seat}
        state={state}
        size={size}
        onSeatTap={onSeatTap}
        recommended={Boolean(showRecommended && state === 'available' && isRecommendedSeat(seat.id))}
      />
    )
  }

  const mapContent = (
    <div
      className="seatmap"
      ref={mapRef}
      style={{
        minWidth: floor === 1 ? 640 : 700,
        ...(isFit
          ? {
              margin: 0,
              transform: fit ? `scale(${fit.scale})` : undefined,
              transformOrigin: 'top left' as const,
            }
          : {}),
      }}
    >
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
  )

  if (isFit) {
    return (
      <div className="seatmap-scroll seatmap-scroll-fit" ref={scrollRef}>
        <div
          className="seatmap-fit"
          style={fit ? { width: fit.width, height: fit.height } : undefined}
        >
          {mapContent}
        </div>
      </div>
    )
  }

  return (
    <div className="seatmap-scroll" ref={scrollRef}>
      {mapContent}
    </div>
  )
}
