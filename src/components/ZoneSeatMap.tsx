import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import { seatById } from '../data/seats'
import type { AppData } from '../lib/logic'
import {
  ZONE_DEF_BY_ID,
  ZONE_IDS,
  type ZoneAvailability,
  type ZoneId,
} from '../lib/zones'
import { buildZoneMap, zoneAnchors, type ZoneMapCell } from '../lib/zoneMap'

/**
 * ゾーン選択（上から見た座席表）。
 *
 * ホール全体を実際の座席配置どおりに描き、席セルをゾーン色で塗る。
 * お客様は「ここがいいな」と思ったエリアの席（またはバッジ）をタップして
 * ゾーンを選ぶ。席そのものを選ぶのではなく、選ばれるのはゾーンで、
 * 割当は従来どおりゾーン内自動割当（lib/zones.ts）に進む。
 *
 * 表示の約束:
 * - 埋まっている席（予約済み・販売済み・販売しない）は暗く落とし、
 *   残りの空き具合がそのまま見えるようにする。
 * - 満席のゾーンは席セルを黒く塗り、バッジは「満席」。タップしても何も起きない。
 * - 車椅子席・親子室は中立色で描き、タップ対象にしない（備考欄で受付）。
 * - 埋まった席をタップしても、そのゾーンは選べる（セルはエリアの入口）。
 *
 * 拡大はピンチ操作（2本指）で行う。ジェスチャ中は SeatMap と同じ方式で
 * transform を直接書き換え、指を離したときだけ倍率を確定する。
 * 全体表示（等倍）が既定で、そのまま全ゾーンが見渡せる。
 */

/** ピンチで選べるズームの上限 */
const ZOOM_MAX = 2.5
/** この倍率以下まで縮小したら全体表示（等倍）に吸着する */
const FIT_SNAP = 1.03

interface PinchState {
  startDist: number
  startScale: number
  anchorX: number
  anchorY: number
  midClientX: number
  midClientY: number
  layoutX: number
  layoutY: number
  curScale: number
  moved: boolean
  committed: boolean
}

export default function ZoneSeatMap({
  data,
  availability,
  onPick,
  disabled = false,
}: {
  data: AppData
  availability: Record<ZoneId, ZoneAvailability>
  onPick: (zone: ZoneId) => void
  disabled?: boolean
}) {
  const floors = useMemo(() => buildZoneMap(data), [data])
  const anchors = useMemo(() => zoneAnchors(floors), [floors])

  /** タップしたゾーンの一瞬のハイライト（割当できない案内時にも残る） */
  const [flash, setFlash] = useState<ZoneId | null>(null)
  const flashTimerRef = useRef<number | undefined>(undefined)
  const handlePick = (zone: ZoneId) => {
    if (disabled || availability[zone].soldOut) return
    setFlash(zone)
    window.clearTimeout(flashTimerRef.current)
    flashTimerRef.current = window.setTimeout(() => setFlash(null), 550)
    onPick(zone)
  }
  useEffect(() => () => window.clearTimeout(flashTimerRef.current), [])

  /* ---------------- ピンチズーム ---------------- */
  const viewportRef = useRef<HTMLDivElement>(null)
  const contentRef = useRef<HTMLDivElement>(null)
  const [scale, setScale] = useState(1)
  const scaleRef = useRef(scale)
  scaleRef.current = scale
  /** コンテンツの自然サイズ（幅 = ビューポート幅、高さ = 実測） */
  const [view, setView] = useState<{ w: number; h: number } | null>(null)
  const viewRef = useRef(view)
  viewRef.current = view
  const pinchRef = useRef<PinchState | null>(null)
  const pinchEndTimerRef = useRef<number | undefined>(undefined)
  const pendingPinchRef = useRef<{ dist: number; midX: number; midY: number } | null>(null)
  const pinchRafRef = useRef<number | null>(null)
  const suppressClickRef = useRef(false)

  useLayoutEffect(() => {
    const measure = () => {
      const vp = viewportRef.current
      const ct = contentRef.current
      if (!vp || !ct) return
      const w = vp.clientWidth
      if (w <= 0) return
      // offsetHeight は transform の影響を受けない自然サイズ
      const h = ct.offsetHeight
      if (h <= 0) return
      setView((prev) => (prev && prev.w === w && prev.h === h ? prev : { w, h }))
    }
    measure()
    window.addEventListener('resize', measure)
    return () => window.removeEventListener('resize', measure)
  }, [floors])

  const startPinch = (touches: TouchList) => {
    const ct = contentRef.current
    if (!ct || !viewRef.current) return
    const a = touches[0]
    const b = touches[1]
    const dist = Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY)
    if (dist < 10) return
    const startScale = scaleRef.current
    const rect = ct.getBoundingClientRect()
    const midClientX = (a.clientX + b.clientX) / 2
    const midClientY = (a.clientY + b.clientY) / 2
    pinchRef.current = {
      startDist: dist,
      startScale,
      anchorX: (midClientX - rect.left) / startScale,
      anchorY: (midClientY - rect.top) / startScale,
      midClientX,
      midClientY,
      layoutX: rect.left,
      layoutY: rect.top,
      curScale: startScale,
      moved: false,
      committed: false,
    }
    pendingPinchRef.current = { dist, midX: midClientX, midY: midClientY }
    ct.style.willChange = 'transform'
  }

  const applyPinchFrame = () => {
    const p = pinchRef.current
    const pend = pendingPinchRef.current
    const ct = contentRef.current
    if (!p || !pend || !ct) return
    const target = p.startScale * (pend.dist / p.startDist)
    const s = Math.min(ZOOM_MAX, Math.max(1, target))
    p.curScale = s
    p.midClientX = pend.midX
    p.midClientY = pend.midY
    const tx = pend.midX - p.layoutX - s * p.anchorX
    const ty = pend.midY - p.layoutY - s * p.anchorY
    ct.style.transform = `translate(${tx}px, ${ty}px) scale(${s})`
  }

  // ズーム確定の描画直後、ピンチ中心が指の下に留まるようスクロールを補正する
  useLayoutEffect(() => {
    const p = pinchRef.current
    const vp = viewportRef.current
    const ct = contentRef.current
    if (!p || !p.committed || !vp || !ct) return
    const rect = ct.getBoundingClientRect()
    const dx = rect.left + p.anchorX * scale - p.midClientX
    if (dx !== 0) vp.scrollLeft += dx
    const dy = rect.top + p.anchorY * scale - p.midClientY
    if (dy !== 0) window.scrollBy(0, dy)
  }, [scale, view])

  useEffect(() => {
    const vp = viewportRef.current
    if (!vp) return

    const onTouchStart = (e: TouchEvent) => {
      if (e.touches.length === 2) {
        e.preventDefault()
        window.clearTimeout(pinchEndTimerRef.current)
        if (pinchRef.current?.committed) pinchRef.current = null
        if (!pinchRef.current) startPinch(e.touches)
      }
    }
    const onTouchMove = (e: TouchEvent) => {
      if (e.touches.length !== 2) return
      if (!pinchRef.current || pinchRef.current.committed) {
        window.clearTimeout(pinchEndTimerRef.current)
        pinchRef.current = null
        startPinch(e.touches)
        if (!pinchRef.current) return
      }
      e.preventDefault()
      const p = pinchRef.current
      const a = e.touches[0]
      const b = e.touches[1]
      const dist = Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY)
      if (dist < 10) return
      if (Math.abs(dist - p.startDist) > 12) p.moved = true
      pendingPinchRef.current = {
        dist,
        midX: (a.clientX + b.clientX) / 2,
        midY: (a.clientY + b.clientY) / 2,
      }
      if (pinchRafRef.current == null) {
        pinchRafRef.current = requestAnimationFrame(() => {
          pinchRafRef.current = null
          applyPinchFrame()
        })
      }
    }
    const endPinch = (e: TouchEvent) => {
      if (e.touches.length >= 2 || !pinchRef.current) return
      const p = pinchRef.current
      if (p.committed) return
      if (pinchRafRef.current != null) {
        cancelAnimationFrame(pinchRafRef.current)
        pinchRafRef.current = null
      }
      applyPinchFrame()
      pendingPinchRef.current = null
      if (p.moved) suppressClickRef.current = true
      const ct = contentRef.current
      if (ct) ct.style.willChange = ''
      p.committed = true
      const target =
        p.curScale <= FIT_SNAP ? 1 : Math.round(p.curScale * 1000) / 1000
      setScale(target)
      // 確定値が従来と同じで再描画が省略された場合、ジェスチャ用 transform が
      // 残ることがある。少し待って残っていたら確定表示へ手動で戻す
      pinchEndTimerRef.current = window.setTimeout(() => {
        if (pinchRef.current !== p) return
        pinchRef.current = null
        const m = contentRef.current
        const v = viewportRef.current
        if (!m || !v || !m.style.transform.includes('translate(')) return
        const cs = p.curScale <= FIT_SNAP ? 1 : Math.round(p.curScale * 1000) / 1000
        m.style.transform = `scale(${cs})`
        const rect = m.getBoundingClientRect()
        const dx = rect.left + p.anchorX * cs - p.midClientX
        if (dx !== 0) v.scrollLeft += dx
        const dy = rect.top + p.anchorY * cs - p.midClientY
        if (dy !== 0) window.scrollBy(0, dy)
      }, 120)
    }
    const clearSuppress = () => {
      suppressClickRef.current = false
    }
    const onClickCapture = (e: MouseEvent) => {
      if (suppressClickRef.current) {
        suppressClickRef.current = false
        e.preventDefault()
        e.stopPropagation()
      }
    }

    vp.addEventListener('touchstart', onTouchStart, { passive: false })
    vp.addEventListener('touchmove', onTouchMove, { passive: false })
    vp.addEventListener('touchend', endPinch)
    vp.addEventListener('touchcancel', endPinch)
    vp.addEventListener('touchstart', clearSuppress)
    vp.addEventListener('pointerdown', clearSuppress)
    vp.addEventListener('click', onClickCapture, true)
    return () => {
      vp.removeEventListener('touchstart', onTouchStart)
      vp.removeEventListener('touchmove', onTouchMove)
      vp.removeEventListener('touchend', endPinch)
      vp.removeEventListener('touchcancel', endPinch)
      vp.removeEventListener('touchstart', clearSuppress)
      vp.removeEventListener('pointerdown', clearSuppress)
      vp.removeEventListener('click', onClickCapture, true)
    }
  })

  /* ---------------- 描画 ---------------- */

  const renderCell = (c: ZoneMapCell) => {
    if (!c.zone) {
      return (
        <span
          key={c.seatId}
          className="zseat-cell is-neutral"
          data-zone-seat={c.seatId}
          data-zone=""
          data-seat-status={c.status}
        />
      )
    }
    const zone = c.zone
    const a = availability[zone]
    const taken = c.status !== 'available'
    const cls =
      `zseat-cell zc-${zone.toLowerCase()}` +
      (a.soldOut ? ' is-soldout' : taken ? ' is-taken' : ' is-free') +
      (flash === zone ? ' is-flash' : '')
    const seat = seatById(c.seatId)
    return (
      <button
        key={c.seatId}
        type="button"
        className={cls}
        data-zone-seat={c.seatId}
        data-zone={zone}
        data-seat-status={c.status}
        disabled={disabled || a.soldOut}
        onClick={() => handlePick(zone)}
        aria-label={`${seat.label}（ゾーン${zone}${taken ? '・この席は埋まっていますがエリアは選べます' : ''}）`}
      />
    )
  }

  return (
    <div className="zseat" data-zone-map>
      <div className="zseat-toolbar">
        <span className="zseat-hint">2本指で広げると、座席表を拡大できます</span>
        {scale > 1 && (
          <button
            type="button"
            className="zseat-reset"
            data-zseat-reset
            onClick={() => setScale(1)}
          >
            全体表示に戻す
          </button>
        )}
      </div>
      <div
        className={`zseat-viewport${scale > 1 ? ' is-zoomed' : ''}`}
        ref={viewportRef}
      >
        <div
          className="zseat-box"
          style={
            view
              ? {
                  width: Math.ceil(view.w * scale),
                  height: Math.ceil(view.h * scale),
                }
              : undefined
          }
        >
          <div
            className="zseat-content"
            ref={contentRef}
            style={{
              width: view ? view.w : undefined,
              transform: `scale(${scale})`,
              transformOrigin: '0 0',
            }}
          >
            {floors.map((f) => (
              <div className="zseat-floor" key={f.floor} data-zseat-floor={f.floor}>
                <p className="zseat-floor-label">{f.floor}階</p>
                <div className="zseat-grid">
                  <div className="mini-stage">舞台</div>
                  <div className="zseat-rows">
                    {f.rows.map((row, ri) => (
                      <div key={ri}>
                        <div className={`zseat-row is-${row.kind}`}>
                          <span className="zseat-row-label">
                            {row.kind === 'normal'
                              ? row.row
                              : row.kind === 'side'
                                ? 'サ'
                                : '特'}
                          </span>
                          {row.blocks.map((block) => (
                            <div
                              className="zseat-block"
                              key={block.block}
                              style={
                                row.kind === 'side'
                                  ? undefined
                                  : { flexGrow: block.cells.length }
                              }
                            >
                              {block.cells.map(renderCell)}
                            </div>
                          ))}
                        </div>
                        {f.floor === 1 && row.row === 12 && (
                          <div className="zseat-aisle" aria-hidden="true">
                            ― 通路 ―
                          </div>
                        )}
                      </div>
                    ))}
                    {anchors
                      .filter((an) => an.floor === f.floor)
                      .map((an) => {
                        const a = availability[an.zone]
                        const def = ZONE_DEF_BY_ID.get(an.zone)!
                        const state = a.soldOut ? 'soldout' : a.low ? 'low' : 'open'
                        return (
                          <button
                            key={an.zone}
                            type="button"
                            className={
                              `zbadge zc-${an.zone.toLowerCase()} is-${state}` +
                              (flash === an.zone ? ' is-flash' : '')
                            }
                            style={{ left: `${an.xPct}%`, top: `${an.yPct}%` }}
                            data-zone-badge={an.zone}
                            data-zone-state={state}
                            data-zone-remaining={a.available}
                            disabled={disabled || a.soldOut}
                            onClick={() => handlePick(an.zone)}
                            aria-label={`ゾーン${an.zone} ${def.name}（${a.soldOut ? '満席' : `残り${a.available}席`}）`}
                          >
                            <span className="zbadge-letter">{an.zone}</span>
                            <span className="zbadge-count">
                              {a.soldOut ? '満席' : `残り${a.available}席`}
                            </span>
                          </button>
                        )
                      })}
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>

      <ul className="zonelist">
        {ZONE_IDS.map((z) => {
          const def = ZONE_DEF_BY_ID.get(z)!
          const a = availability[z]
          const state = a.soldOut ? 'soldout' : a.low ? 'low' : 'open'
          return (
            <li key={z}>
              <button
                type="button"
                className={
                  `zonelist-item zc-${z.toLowerCase()} is-${state}` +
                  (flash === z ? ' is-flash' : '')
                }
                data-zone-tile={z}
                data-zone-state={state}
                data-zone-remaining={a.available}
                disabled={disabled || a.soldOut}
                onClick={() => handlePick(z)}
              >
                <span className="zonelist-swatch" aria-hidden="true" />
                <span className="zonelist-main">
                  <span className="zonelist-head">
                    <span className="zonelist-letter">{z}</span>
                    <span className="zonelist-name">{def.name}</span>
                  </span>
                  <span className="zonelist-desc">{def.description}</span>
                </span>
                {a.soldOut ? (
                  <span className="zonelist-soldout">満席</span>
                ) : (
                  <span className="zonelist-remain">
                    残り{a.available}席
                    {a.low && <span className="zone-low-badge">残りわずか</span>}
                  </span>
                )}
              </button>
            </li>
          )
        })}
      </ul>
    </div>
  )
}
