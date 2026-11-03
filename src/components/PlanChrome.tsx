import { PLAN_H, PLAN_W, type ZoneMapRowLabel } from '../lib/zoneMap'

/**
 * 公式図プランの「図面そのもの」（席セル以外の静的要素）。
 *
 * ホールの輪郭・舞台・非常用コーナー・横通路・車椅子席/親子室の箱・
 * 2階サイド席の箱・階ラベル・列番号を、lib/zoneMap.ts のプラン座標で描く。
 * R18: お客様用（ZoneSeatMap）とスタッフ用（StaffSeatMap）で図面が
 * 食い違わないよう、描画はここに一本化する。席セルの描き分けは
 * 各コンポーネント側の責務（ゾーン選択／席単位ピックで振る舞いが違うため）。
 */

/** プラン単位 → % 換算 */
const px = (v: number) => `${(v / PLAN_W) * 100}%`
const py = (v: number) => `${(v / PLAN_H) * 100}%`

export default function PlanChrome({
  rowLabels,
}: {
  rowLabels: ZoneMapRowLabel[]
}) {
  return (
    <>
      {/* ホールの輪郭（扇形） */}
      <svg
        className="zplan-outline"
        viewBox={`0 0 ${PLAN_W} ${PLAN_H}`}
        preserveAspectRatio="none"
        aria-hidden="true"
      >
        <polygon points="196,50 804,50 890,622 110,622" />
        <rect x="112" y="712" width="776" height="210" />
        <polygon points="150,940 850,940 928,1048 72,1048" />
      </svg>

      {/* 舞台と非常用コーナー（R0） */}
      <div
        className="zplan-stage"
        style={{ left: px(168), top: py(6), width: px(664), height: py(32) }}
      >
        舞台
      </div>
      <div
        className="zplan-hatch"
        style={{ left: px(842), top: py(6), width: px(52), height: py(54) }}
        aria-hidden="true"
      />
      <span
        className="zplan-r0"
        style={{ left: px(902), top: py(16) }}
        aria-hidden="true"
      >
        R0
      </span>

      {/* 横通路（12列と13列の間） */}
      <div
        className="zplan-aisle"
        style={{ left: px(120), top: py(448), width: px(760), height: py(22) }}
        aria-hidden="true"
      >
        ― 通路 ―
      </div>

      {/* 車椅子席の小箱 */}
      <div
        className="zplan-box"
        style={{ left: px(278), top: py(380), width: px(118), height: py(68) }}
        aria-hidden="true"
      >
        <span className="zplan-box-label is-bottom">車椅子席</span>
      </div>

      {/* 親子室 */}
      <div
        className="zplan-box"
        style={{ left: px(296), top: py(606), width: px(408), height: py(64) }}
        aria-hidden="true"
      >
        <span className="zplan-box-label is-side">親子室</span>
      </div>
      <span
        className="zplan-floor-label"
        style={{ left: px(500), top: py(690) }}
        aria-hidden="true"
      >
        1階
      </span>

      {/* 2階サイド席の縦ボックス */}
      <div
        className="zplan-box"
        style={{ left: px(6), top: py(712), width: px(90), height: py(210) }}
        aria-hidden="true"
      >
        <span className="zplan-box-label">L</span>
      </div>
      <div
        className="zplan-box"
        style={{ left: px(904), top: py(712), width: px(90), height: py(210) }}
        aria-hidden="true"
      >
        <span className="zplan-box-label">R</span>
      </div>
      <span
        className="zplan-floor-label"
        style={{ left: px(500), top: py(1064) }}
        aria-hidden="true"
      >
        2階
      </span>

      {/* 列番号 */}
      {rowLabels.map((l) => (
        <span
          key={l.label}
          className="zplan-row-label"
          style={{ left: px(l.cx), top: py(l.cy) }}
          aria-hidden="true"
        >
          {l.label}
        </span>
      ))}
    </>
  )
}
