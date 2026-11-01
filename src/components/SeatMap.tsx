import { useEffect, useLayoutEffect, useRef, useState } from 'react'
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
  /** 全体表示の実測倍率（0.38 など）を親へ通知する。倍率表示（約○○%）に使う */
  onFitScale?: (scale: number) => void
  /** ピンチ操作でズームが変わったときに親へ通知する（未指定ならピンチは無効） */
  onZoomChange?: (z: SeatZoom) => void
}

/** プリセットのズーム倍率 */
const PRESET_ZOOMS = [1, 1.25, 1.5]
/** ピンチで選べるズームの上限（倍率 = 200%） */
const ZOOM_MAX_SCALE = 2
/** ピンチで縮小したとき、この範囲内（fit 実測倍率の +2% 以内）なら全体表示に吸着する */
const FIT_SNAP_RATIO = 1.02

/**
 * ズーム操作UI（プリセットチップ＋現在の倍率表示）。お客様画面とスタッフ画面で共用する。
 * 任意の倍率はチップではなく、座席表そのものへのピンチ操作で変える（SeatMap 側で処理）。
 */
export function ZoomControls({
  zoom,
  setZoom,
  fitScale,
}: {
  zoom: SeatZoom
  setZoom: (z: SeatZoom) => void
  /** 全体表示の実測倍率（未計測なら null） */
  fitScale: number | null
}) {
  const isFit = zoom === 'fit'
  const fitPercent = fitScale != null ? fitScale * 100 : 38
  return (
    <div className="zoom-controls" aria-label="座席表の拡大縮小">
      <button
        type="button"
        data-zoom="fit"
        className={`zoom-btn${isFit ? ' active' : ''}`}
        onClick={() => setZoom('fit')}
      >
        全体
      </button>
      {PRESET_ZOOMS.map((z) => (
        <button
          key={z}
          type="button"
          data-zoom={z}
          className={`zoom-btn${zoom === z ? ' active' : ''}`}
          onClick={() => setZoom(z)}
        >
          {Math.round(z * 100)}%
        </button>
      ))}
      <span className="zoom-readout" data-zoom-readout>
        {isFit ? `約${Math.round(fitPercent)}%` : `${Math.round(zoom * 100)}%`}
      </span>
    </div>
  )
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

/** ピンチ操作の進行状態（ピンチ中心のアンカーはマップ左上を原点とする自然座標で保持） */
interface PinchState {
  /** ピンチ開始時の2本指の距離 */
  startDist: number
  /** ピンチ開始時の実効倍率 */
  startScale: number
  /** この階の全体表示の実測倍率（ピンチの下限＆吸着先） */
  fitScale: number
  /** ピンチ中心が指していたコンテンツ位置（倍率1換算・近似値） */
  anchorX: number
  anchorY: number
  /** 直近のピンチ中心（画面座標） */
  midClientX: number
  midClientY: number
  /** 前回スクロール補正を適用した実効倍率 */
  prevEff: number
  /** 実際に倍率が動いたか（クリック抑止の判定に使う） */
  moved: boolean
}

export default function SeatMap({
  floor,
  zoom,
  stateOf,
  onSeatTap,
  showRecommended,
  onFitScale,
  onZoomChange,
}: SeatMapProps) {
  const isFit = zoom === 'fit'
  // レイアウトは常に等倍（席30px）で組み、表示倍率は transform の scale で適用する。
  // ズームが変わっても DOM 構造が変わらないため、ピンチ中のタッチ対象が消えず
  // ジェスチャが途中で打ち切られない（fit ⇔ 数値ズームで描画分岐を切り替える
  // 旧方式は、座席ボタンの作り直しで touch がキャンセルされる問題があった）。
  const size = 30
  const scrollRef = useRef<HTMLDivElement>(null)
  const mapRef = useRef<HTMLDivElement>(null)
  /** 適用中の倍率と、ラッパーが確保すべき見かけサイズ */
  const [box, setBox] = useState<{ scale: number; width: number; height: number } | null>(null)
  const onFitScaleRef = useRef(onFitScale)
  onFitScaleRef.current = onFitScale
  const zoomRef = useRef(zoom)
  zoomRef.current = zoom
  const boxRef = useRef(box)
  boxRef.current = box
  const onZoomChangeRef = useRef(onZoomChange)
  onZoomChangeRef.current = onZoomChange
  const pinchRef = useRef<PinchState | null>(null)
  const pinchEndTimerRef = useRef<number | undefined>(undefined)
  /** ピンチ直後の残留クリックを1回だけ抑止するフラグ（次のタッチ開始で解除） */
  const suppressClickRef = useRef(false)

  useLayoutEffect(() => {
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
      const fitScale = Math.min(1, avail / naturalWidth)
      onFitScaleRef.current?.(fitScale)
      const scale = isFit ? fitScale : zoom
      setBox({
        scale,
        width: Math.ceil(naturalWidth * scale),
        height: Math.ceil(naturalHeight * scale),
      })
    }
    measure()
    window.addEventListener('resize', measure)
    return () => window.removeEventListener('resize', measure)
  }, [isFit, floor, zoom])

  /* ---------------- ピンチズーム ----------------
   * 2本指ピンチで「全体表示の実測倍率 〜 200%」の範囲を連続的に変える。
   * 1本指の操作（ネイティブスクロール・席タップ）は一切横取りしない。
   * 2本目が触れた瞬間に touchstart を preventDefault して、そのシーケンスの
   * スクロール開始とクリック生成を止めてからピンチを処理するのが肝。
   */

  /** この階の全体表示の実測倍率（レイアウトは常時等倍なので offsetWidth がそのまま自然幅） */
  const measureFitScale = (): number | null => {
    const scroll = scrollRef.current
    const map = mapRef.current
    if (!scroll || !map) return null
    // .seatmap-scroll の左右パディング（2px × 2）を除いた表示可能幅
    const avail = scroll.clientWidth - 4
    if (avail <= 0 || map.offsetWidth <= 0) return null
    return Math.min(1, avail / map.offsetWidth)
  }

  /** 現在の実効倍率（全体表示中は実測の縮小率、数値ズーム中はその値） */
  const effectiveScale = (): number => {
    const z = zoomRef.current
    if (z !== 'fit') return z
    return boxRef.current?.scale ?? measureFitScale() ?? 1
  }

  const startPinch = (touches: TouchList) => {
    const map = mapRef.current
    if (!map) return
    const fitScale = measureFitScale()
    if (fitScale == null) return
    const a = touches[0]
    const b = touches[1]
    const dist = Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY)
    if (dist < 10) return
    const startScale = effectiveScale()
    // マップの見かけの左上を原点として、ピンチ中心の自然座標をアンカーに取る
    const rect = map.getBoundingClientRect()
    const midClientX = (a.clientX + b.clientX) / 2
    const midClientY = (a.clientY + b.clientY) / 2
    pinchRef.current = {
      startDist: dist,
      startScale,
      fitScale,
      anchorX: (midClientX - rect.left) / startScale,
      anchorY: (midClientY - rect.top) / startScale,
      midClientX,
      midClientY,
      prevEff: startScale,
      moved: false,
    }
  }

  // ズーム変更の描画直後、ピンチ中心のアンカーが指の下に留まるようスクロールを補正する
  useLayoutEffect(() => {
    const p = pinchRef.current
    const scroll = scrollRef.current
    const map = mapRef.current
    if (!p || !scroll || !map) return
    const newEff = zoom === 'fit' ? p.fitScale : zoom
    const rect = map.getBoundingClientRect()
    const dx = rect.left + p.anchorX * newEff - p.midClientX
    if (dx !== 0) scroll.scrollLeft += dx
    const dy = rect.top + p.anchorY * newEff - p.midClientY
    if (dy !== 0) window.scrollBy(0, dy)
    p.prevEff = newEff
  }, [zoom, box])

  useEffect(() => {
    const scroll = scrollRef.current
    if (!scroll) return

    const onTouchStart = (e: TouchEvent) => {
      if (e.touches.length === 2) {
        e.preventDefault()
        window.clearTimeout(pinchEndTimerRef.current)
        if (!pinchRef.current) startPinch(e.touches)
      }
    }

    const onTouchMove = (e: TouchEvent) => {
      if (e.touches.length !== 2) return
      if (!pinchRef.current) {
        // 2本目の touchstart がコンテナの外で始まっていた場合の保険
        window.clearTimeout(pinchEndTimerRef.current)
        startPinch(e.touches)
        if (!pinchRef.current) return
      }
      e.preventDefault()
      const p = pinchRef.current
      const a = e.touches[0]
      const b = e.touches[1]
      const dist = Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY)
      if (dist < 10) return
      p.midClientX = (a.clientX + b.clientX) / 2
      p.midClientY = (a.clientY + b.clientY) / 2
      const target = p.startScale * (dist / p.startDist)
      const clamped = Math.min(ZOOM_MAX_SCALE, Math.max(p.fitScale, target))
      if (Math.abs(dist - p.startDist) > 12) p.moved = true
      const cb = onZoomChangeRef.current
      if (!cb) return
      if (clamped <= p.fitScale * FIT_SNAP_RATIO) cb('fit')
      else cb(Math.round(clamped * 1000) / 1000)
    }

    const endPinch = (e: TouchEvent) => {
      if (e.touches.length >= 2 || !pinchRef.current) return
      if (pinchRef.current.moved) {
        // ピンチ直後に残った指のタップがクリック化して席を誤操作しないための保険。
        // 次のタッチ開始で解除されるので、正規のタップは妨げない。
        suppressClickRef.current = true
      }
      // 最後の倍率変更へのスクロール補正（レイアウトエフェクト）が走る余地を残して破棄する
      const p = pinchRef.current
      pinchEndTimerRef.current = window.setTimeout(() => {
        if (pinchRef.current === p) pinchRef.current = null
      }, 80)
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

    scroll.addEventListener('touchstart', onTouchStart, { passive: false })
    scroll.addEventListener('touchmove', onTouchMove, { passive: false })
    scroll.addEventListener('touchend', endPinch)
    scroll.addEventListener('touchcancel', endPinch)
    scroll.addEventListener('touchstart', clearSuppress)
    scroll.addEventListener('pointerdown', clearSuppress)
    scroll.addEventListener('click', onClickCapture, true)
    return () => {
      scroll.removeEventListener('touchstart', onTouchStart)
      scroll.removeEventListener('touchmove', onTouchMove)
      scroll.removeEventListener('touchend', endPinch)
      scroll.removeEventListener('touchcancel', endPinch)
      scroll.removeEventListener('touchstart', clearSuppress)
      scroll.removeEventListener('pointerdown', clearSuppress)
      scroll.removeEventListener('click', onClickCapture, true)
    }
  })

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
        margin: 0,
        transform: box ? `scale(${box.scale})` : undefined,
        transformOrigin: 'top left' as const,
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

  // ズーム方式によらず常に「スクロール容器 > 見かけサイズを確保するラッパー > マップ」の
  // 同一構造で描く（ズーム変更で座席ボタンの DOM が作り直されないための要）。
  // 全体表示のときだけ横スクロールを禁止する（seatmap-scroll-fit）。
  return (
    <div
      className={`seatmap-scroll${isFit ? ' seatmap-scroll-fit' : ''}`}
      ref={scrollRef}
    >
      <div
        className="seatmap-fit"
        style={box ? { width: box.width, height: box.height } : undefined}
      >
        {mapContent}
      </div>
    </div>
  )
}
