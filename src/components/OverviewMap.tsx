import { useMemo } from 'react'
import { buildOverview } from '../lib/overview'

export interface OverviewGroup {
  seatIds: string[]
  label: string
}

/**
 * ホール全体の模式図（読み取り専用）。
 *
 * 全席を中立色で描き、渡されたグループの席だけをグループごとの色で示す。
 * 割当結果の確認では「あなたの席」1グループを金色で示す。
 *
 * 予約・販売状態は一切参照しない（lib/overview.ts が席IDだけを入力とする）ため
 * 空き／埋まりの情報は出ず、タップ操作もない。模式図自体は装飾として
 * aria-hidden にし、内容は凡例と本文の文章で伝わるようにする。
 */
export default function OverviewMap({ groups }: { groups: OverviewGroup[] }) {
  const floors = useMemo(() => buildOverview(groups), [groups])
  return (
    <div className="overview-map" data-overview-map>
      <ul className="overview-legend">
        {groups.map((g, i) => (
          <li className="overview-legend-item" key={g.seatIds.join(',')} data-overview-legend>
            <span className={`overview-swatch is-cand-${i}`} aria-hidden="true" />
            <span>{g.label}</span>
          </li>
        ))}
      </ul>
      {floors.map((f) => (
        <div className="overview-floor" key={f.floor} data-overview-floor={f.floor}>
          <p className="overview-floor-label">{f.floor}階</p>
          <div className="overview-grid" aria-hidden="true">
            <div className="mini-stage">舞台</div>
            {f.rows.map((row, ri) => (
              <div className="overview-row" key={ri}>
                <span className="overview-row-label">
                  {row.kind === 'normal' ? row.row : row.kind === 'side' ? 'サ' : '特'}
                </span>
                {row.blocks.map((block) => (
                  <div
                    className="overview-block"
                    key={block.block}
                    style={{ flexGrow: block.cells.length }}
                  >
                    {block.cells.map((c) => (
                      <span
                        key={c.seatId}
                        className={`overview-seat${
                          c.candidateIndex !== null ? ` is-cand-${c.candidateIndex}` : ''
                        }`}
                        data-overview-seat={c.seatId}
                        {...(c.candidateIndex !== null
                          ? { 'data-overview-cand': c.candidateIndex }
                          : {})}
                      />
                    ))}
                  </div>
                ))}
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  )
}
