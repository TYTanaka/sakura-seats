import { useMemo } from 'react'
import {
  ROW_LAYOUT_1F,
  ROW_LAYOUT_2F,
  SIDE_L_SEATS,
  SIDE_R_SEATS,
  seatById,
  type Floor,
} from '../data/seats'
import { seatStatus, type AppData } from '../lib/logic'

/**
 * 候補カード用の読み取り専用ミニ座席表（模式図）。
 * 候補の席だけを目立たせ、「ホールのどの辺か」が一目で分かるようにする。
 * タップ操作は一切できない。
 *
 * R6・C-3: 全列を描くと縦に長く、3候補の見比べにスクロールが往復する。
 * そのため候補席の列の前後2列だけに切り取って描く（全体の中での位置は
 * 候補カード側の「全16列中の7列め」のような言葉で補う）。
 * R6・D-3: 車椅子席・親子室の行は候補にならない席で、小さなグリフでは
 * 判読もできないため描かない。2階サイド席の行も、候補がサイド席の
 * ときだけ描く。
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
  // 候補席（通常席）の列。前後2列までを描く範囲とする
  const highlightRows = useMemo(() => {
    const rows = new Set<number>()
    for (const id of highlight) {
      const seat = seatById(id)
      if (seat && seat.kind === 'normal' && seat.row !== null) rows.add(seat.row)
    }
    return rows
  }, [highlight])
  const visibleRows =
    highlightRows.size === 0
      ? layout
      : layout.filter((row) =>
          [...highlightRows].some((r) => Math.abs(row.row - r) <= 2),
        )
  const showSideRow =
    floor === 2 && highlight.some((id) => seatById(id)?.kind === 'side')
  return (
    <div className="mini-map" data-mini-map={floor} aria-hidden="true">
      <div className="mini-stage">舞台</div>
      {visibleRows.map((row) => (
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
      {showSideRow && (
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
