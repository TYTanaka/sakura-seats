import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react'
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
  /**
   * ピンチ中に倍率表示（ZoomControls の読み出しスパン）を再描画なしで書き換えるための ref。
   * ZoomControls の readoutRef と同じオブジェクトを渡す。ジェスチャ中の表示専用で、
   * 確定は従来どおり onZoomChange 経由の state で行う
   */
  previewReadoutRef?: RefObject<HTMLSpanElement | null>
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
  readoutRef,
}: {
  zoom: SeatZoom
  setZoom: (z: SeatZoom) => void
  /** 全体表示の実測倍率（未計測なら null） */
  fitScale: number | null
  /** 倍率読み出しスパンへの ref（ピンチ中のプレビュー表示を SeatMap が直接書き換える） */
  readoutRef?: RefObject<HTMLSpanElement | null>
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
      <span className="zoom-readout" data-zoom-readout ref={readoutRef}>
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

/**
 * 座席の凡例。そのマップで実際に描かれる状態と一致させる。
 * - audience: お客様マップ。支払済席も予約済席と同じ見た目で描くため1スウォッチに統合し、
 *   おすすめ席の金ティントも案内する
 * - staff: スタッフマップ。予約済み（淡）と支払済・販売済み（濃）を分けて示す
 */
export function SeatLegend({ variant = 'audience' }: { variant?: 'audience' | 'staff' }) {
  return (
    <div className="legend" aria-label="座席の凡例">
      <span className="legend-item">
        <span className="legend-swatch seat-available" /> 空席
      </span>
      <span className="legend-item">
        <span className="legend-swatch seat-selected" /> 選択中
      </span>
      {variant === 'staff' ? (
        <>
          <span className="legend-item">
            <span className="legend-swatch seat-reserved" /> 予約済み
          </span>
          <span className="legend-item">
            <span className="legend-swatch seat-paid" /> 支払済・販売済み
          </span>
        </>
      ) : (
        <span className="legend-item">
          <span className="legend-swatch seat-reserved" /> 予約済み・販売済み
        </span>
      )}
      <span className="legend-item">
        <span className="legend-swatch seat-blocked" /> 販売しない
      </span>
      <span className="legend-item">※印は見切れ席（舞台の一部が見えにくい席）</span>
      {variant === 'audience' && (
        <span className="legend-item">
          <span className="legend-swatch seat-recommended-swatch" /> ★おすすめ席（1階中央 5〜10列）
        </span>
      )}
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
  /**
   * ジェスチャ開始時点でのマップ原点（自然座標 0,0）の画面座標。
   * ジェスチャ中はスクロールが起きないため不変で、translate+scale の基準に使う
   */
  layoutX: number
  layoutY: number
  /** 直近に transform へ適用した倍率（指を離すときの確定値の元） */
  curScale: number
  /** 実際に倍率が動いたか（クリック抑止の判定に使う） */
  moved: boolean
  /** 指が離れて確定済みか（確定後のスクロール補正エフェクトはこのときだけ働く） */
  committed: boolean
}

export default function SeatMap({
  floor,
  zoom,
  stateOf,
  onSeatTap,
  showRecommended,
  onFitScale,
  onZoomChange,
  previewReadoutRef,
}: SeatMapProps) {
  const isFit = zoom === 'fit'
  // レイアウトは常に等倍（席30px）で組み、表示倍率は transform の scale で適用する。
  // ズームが変わっても DOM 構造が変わらないため、ピンチ中のタッチ対象が消えず
  // ジェスチャが途中で打ち切られない（fit ⇔ 数値ズームで描画分岐を切り替える
  // 旧方式は、座席ボタンの作り直しで touch がキャンセルされる問題があった）。
  const size = 30
  const scrollRef = useRef<HTMLDivElement>(null)
  const mapRef = useRef<HTMLDivElement>(null)
  /** 見かけサイズを確保するラッパー（ピンチ中だけ overflow を開くために使う） */
  const wrapRef = useRef<HTMLDivElement>(null)
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
  /** ピンチ中の最新タッチ値（rAF でまとめて1フレームに1回だけ適用する） */
  const pendingPinchRef = useRef<{ dist: number; midX: number; midY: number } | null>(null)
  /** 予約済み rAF の ID（未予約なら null） */
  const pinchRafRef = useRef<number | null>(null)
  const previewReadoutRefRef = useRef(previewReadoutRef)
  previewReadoutRefRef.current = previewReadoutRef

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
   *
   * 滑らかさの要: ジェスチャ中は React の state を一切更新しない（旧方式は
   * touchmove ごとに onZoomChange → 親の setState → 全席ボタンの再描画＋
   * 計測レイアウトエフェクト＋スクロール書き込みが走り、フレームに収まらず
   * カクついていた）。代わりに touchmove は最新値を ref に貯めるだけにし、
   * requestAnimationFrame で1フレームに1回、マップ要素の transform
   * （translate+scale）を直接書き換える。transform はコンポジタ側で処理
   * されるため再描画なしに指へ追従する。倍率表示も ref 経由で span の
   * textContent を書き換えて追従させる。指が離れた瞬間にだけ onZoomChange
   * で確定し（1回だけ）、確定レイアウトへのスクロール補正は下のレイアウト
   * エフェクトが描画前に行うため、離した瞬間の見た目もジャンプしない。
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
    if (!onZoomChangeRef.current) return // ピンチ無効時は何もしない（従来どおり）
    const fitScale = measureFitScale()
    if (fitScale == null) return
    const a = touches[0]
    const b = touches[1]
    const dist = Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY)
    if (dist < 10) return
    const startScale = effectiveScale()
    // 確定表示は「原点左上・scaleのみ」なので、rect の左上がそのまま自然座標の原点。
    // ジェスチャ中はスクロールしないため、この原点の画面座標は最後まで不変
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
      layoutX: rect.left,
      layoutY: rect.top,
      curScale: startScale,
      moved: false,
      committed: false,
    }
    pendingPinchRef.current = { dist, midX: midClientX, midY: midClientY }
    // ジェスチャ中はコンポジタレイヤーへ昇格させ、ラッパーの overflow で
    // 見かけが確保箱からはみ出す分が切り取られないようにする（確定時に戻す）
    map.style.willChange = 'transform'
    if (wrapRef.current) wrapRef.current.style.overflow = 'visible'
  }

  /** pending の最新タッチ値を transform と倍率表示へ反映する（rAF から1フレーム1回呼ばれる） */
  const applyPinchFrame = () => {
    const p = pinchRef.current
    const pend = pendingPinchRef.current
    const map = mapRef.current
    if (!p || !pend || !map) return
    const target = p.startScale * (pend.dist / p.startDist)
    const s = Math.min(ZOOM_MAX_SCALE, Math.max(p.fitScale, target))
    p.curScale = s
    p.midClientX = pend.midX
    p.midClientY = pend.midY
    // アンカー（指の下のコンテンツ）がピンチ中心に留まるよう、平行移動も transform に含める。
    // スクロロール書き込みなしでアンカーが合うため、フレームごとのレイアウト計算が要らない
    const tx = pend.midX - p.layoutX - s * p.anchorX
    const ty = pend.midY - p.layoutY - s * p.anchorY
    map.style.transform = `translate(${tx}px, ${ty}px) scale(${s})`
    // 倍率表示は再描画なしで追従させる（確定時の表示と書式を揃える）
    const ro = previewReadoutRefRef.current?.current
    if (ro) {
      ro.textContent =
        s <= p.fitScale * FIT_SNAP_RATIO
          ? `約${Math.round(p.fitScale * 100)}%`
          : `${Math.round(s * 100)}%`
    }
  }

  // ズーム確定の描画直後、ピンチ中心のアンカーが指の下に留まるようスクロールを補正する。
  // ジェスチャ中（committed になる前）は働かない
  useLayoutEffect(() => {
    const p = pinchRef.current
    const scroll = scrollRef.current
    const map = mapRef.current
    if (!p || !p.committed || !scroll || !map) return
    const newEff = zoom === 'fit' ? p.fitScale : zoom
    const rect = map.getBoundingClientRect()
    const dx = rect.left + p.anchorX * newEff - p.midClientX
    if (dx !== 0) scroll.scrollLeft += dx
    const dy = rect.top + p.anchorY * newEff - p.midClientY
    if (dy !== 0) window.scrollBy(0, dy)
  }, [zoom, box])

  useEffect(() => {
    const scroll = scrollRef.current
    if (!scroll) return

    const onTouchStart = (e: TouchEvent) => {
      if (e.touches.length === 2) {
        e.preventDefault()
        window.clearTimeout(pinchEndTimerRef.current)
        // 前ジェスチャの確定済み状態が残っていたら破棄して新しいピンチを始める
        if (pinchRef.current?.committed) pinchRef.current = null
        if (!pinchRef.current) startPinch(e.touches)
      }
    }

    const onTouchMove = (e: TouchEvent) => {
      if (e.touches.length !== 2) return
      if (!pinchRef.current || pinchRef.current.committed) {
        // 2本目の touchstart がコンテナの外で始まっていた場合の保険
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
      // 最新値だけを貯め、反映は rAF に任せる（複数イベントが来ても1フレーム1回）
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
      if (p.committed) return // 残りの指の touchend で二重に確定しない
      // 予約済み rAF を止め、最後の値を同期で反映してから確定する
      if (pinchRafRef.current != null) {
        cancelAnimationFrame(pinchRafRef.current)
        pinchRafRef.current = null
      }
      applyPinchFrame()
      pendingPinchRef.current = null
      if (p.moved) {
        // ピンチ直後に残った指のタップがクリック化して席を誤操作しないための保険。
        // 次のタッチ開始で解除されるので、正規のタップは妨げない。
        suppressClickRef.current = true
      }
      // ジェスチャ用に変えた表示プロパティを戻す
      // （transform は確定描画が上書きする。書き換わらなかった場合は下の復旧で戻す）
      const map = mapRef.current
      if (map) map.style.willChange = ''
      if (wrapRef.current) wrapRef.current.style.overflow = ''
      // 確定はここで1回だけ（吸着範囲内なら全体表示へ）
      p.committed = true
      const cb = onZoomChangeRef.current
      if (cb) {
        if (p.curScale <= p.fitScale * FIT_SNAP_RATIO) cb('fit')
        else cb(Math.round(p.curScale * 1000) / 1000)
      }
      // 確定値が従来と同じで React が再描画を省略した場合、transform がジェスチャ用
      // （translate 付き）のまま残る。少し待って残っていたら、確定表示（scale のみ＋
      // スクロール補正）へ手動で戻す。確定描画が走った場合は何もしない
      pinchEndTimerRef.current = window.setTimeout(() => {
        if (pinchRef.current !== p) return
        pinchRef.current = null
        const m = mapRef.current
        const scroll = scrollRef.current
        if (!m || !scroll || !m.style.transform.includes('translate(')) return
        const cs =
          p.curScale <= p.fitScale * FIT_SNAP_RATIO
            ? p.fitScale
            : Math.round(p.curScale * 1000) / 1000
        m.style.transform = `scale(${cs})`
        const rect = m.getBoundingClientRect()
        const dx = rect.left + p.anchorX * cs - p.midClientX
        if (dx !== 0) scroll.scrollLeft += dx
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
        ref={wrapRef}
        style={box ? { width: box.width, height: box.height } : undefined}
      >
        {mapContent}
      </div>
    </div>
  )
}
