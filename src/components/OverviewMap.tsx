import { useMemo } from 'react'
import { buildOverview } from '../lib/overview'
import type { OmakaseCandidate } from '../lib/omakase'

/**
 * 候補えらび画面の「ホール全体での位置」（読み取り専用の全体図）。
 *
 * 全席を中立色の模式図で描き、3候補の席だけを候補ごとの色で示す。
 * 候補カードの色分け凡例と色・順番を一致させる。
 *
 * 予約・販売状態は一切参照しない（lib/overview.ts が候補だけを入力とする）ため
 * 空き／埋まりの情報は出ず、タップ操作もない。模式図自体は装飾として
 * aria-hidden にし、候補の内容はカード側の文章で伝わるようにする。
 */
export default function OverviewMap({ candidates }: { candidates: OmakaseCandidate[] }) {
  const floors = useMemo(() => buildOverview(candidates), [candidates])
  return (
    <div className="overview-map" data-overview-map>
      <ul className="overview-legend">
        {candidates.map((cand, i) => (
          <li className="overview-legend-item" key={cand.seatIds.join(',')} data-overview-legend>
            <span className={`overview-swatch is-cand-${i}`} aria-hidden="true" />
            <span>
              候補{i + 1}：{cand.label}
            </span>
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
