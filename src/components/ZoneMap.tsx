import {
  ZONE_DEF_BY_ID,
  type ZoneAvailability,
  type ZoneId,
} from '../lib/zones'

/**
 * ゾーン選択の模式図（ライブ会場方式）。
 *
 * 舞台を上にして、ホールの形に合わせた9つのゾーンタイルを並べる。
 * タイル自体がボタンで、そのまま「カード」も兼ねる（412pxでも読みやすい
 * 大きさの文字で、ゾーン名・残り席数をタイル内に収める）。
 *
 * 状態表示:
 * - 満席のゾーンは黒く塗り、タップ不可（disabled）にする
 * - 残りわずかのゾーンにはバッジを出す
 * 残り席数は seat_state から都度計算した値をそのまま表示する。
 */
export default function ZoneMap({
  availability,
  onPick,
  disabled = false,
}: {
  availability: Record<ZoneId, ZoneAvailability>
  onPick: (zone: ZoneId) => void
  disabled?: boolean
}) {
  const tile = (zone: ZoneId, area: string) => {
    const def = ZONE_DEF_BY_ID.get(zone)!
    const a = availability[zone]
    const state = a.soldOut ? 'soldout' : a.low ? 'low' : 'open'
    return (
      <button
        type="button"
        className={`zone-tile is-${state}`}
        style={{ gridArea: area }}
        data-zone-tile={zone}
        data-zone-state={state}
        data-zone-remaining={a.available}
        disabled={disabled || a.soldOut}
        onClick={() => onPick(zone)}
      >
        <span className="zone-tile-head">
          <span className="zone-letter">{zone}</span>
          <span className="zone-name">{def.name}</span>
        </span>
        <span className="zone-desc">{def.description}</span>
        {a.soldOut ? (
          <span className="zone-soldout-label">満席</span>
        ) : (
          <span className="zone-remain">
            残り{a.available}席
            {a.low && <span className="zone-low-badge">残りわずか</span>}
          </span>
        )}
      </button>
    )
  }

  return (
    <div className="zone-map" data-zone-map>
      <div className="mini-stage">舞台</div>
      <div className="zone-grid zone-grid-1f" role="group" aria-label="1階のゾーン">
        {tile('D', 'd')}
        {tile('A', 'a')}
        {tile('F', 'f')}
        {tile('B', 'b')}
        {tile('C', 'c')}
        {tile('E', 'e')}
        {tile('G', 'g')}
      </div>
      <p className="zone-floor-label">2階</p>
      <div className="zone-grid zone-grid-2f" role="group" aria-label="2階のゾーン">
        {tile('H', 'h')}
        {tile('I', 'i')}
      </div>
    </div>
  )
}
