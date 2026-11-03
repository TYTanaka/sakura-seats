import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from 'react'
import { seatById, type SeatDef } from '../data/seats'
import type { AppData, SeatStatus } from '../lib/logic'
import {
  buildZoneMapLayout,
  PLAN_H,
  PLAN_W,
  type ZoneMapLayoutCell,
} from '../lib/zoneMap'
import PlanChrome from './PlanChrome'

/**
 * スタッフ用の席単位ピッカー（R18）。
 *
 * お客様側のゾーン座席表（R13）と「同じ公式図面」の上に、席1つずつを
 * タップで選べるようにしたもの。当日販売と販売設定で使う。
 * 旧スタッフ座席表（SeatMap: 階ごとに分かれた旧レイアウト）の置き換えで、
 * 図形は lib/zoneMap.ts の buildZoneMapLayout、図面の静的要素は
 * PlanChrome をお客様側と共有する（二重管理で図が食い違わないように）。
 *
 * 状態の見分け（凡例 StaffSeatLegend と一致させる）:
 * - available: ゾーン色（車椅子・親子室は中立色）
 * - reserved: 淡い灰紫（予約済み）
 * - paid: 深い紺紫＋内側の輪（支払済・販売済み）
 * - blocked: 斜線ハッチ（販売しない）
 * - selected: 金色に光る（選択中。R17 の「お客様の席」表示と同じ金）
 *
 * 拡大はお客様側と同じピンチ操作（2本指）。席単位の作業に使うため
 * 上限はお客様側（2.5倍）より大きい4倍。倍率が上がると席番号と
 * 見切れ席の※印をセル内に出す（全体表示では小さすぎて読めないため）。
 * タップの可否・選択の意味づけは呼び出し側（Staff）の onSeatTap が決める
 * （旧 SeatMap と同じく、埋まった席のタップもそのまま通知する）。
 */

export type StaffSeatState = SeatStatus | 'selected'

/** ピンチで選べるズームの上限（席単位の作業向けにお客様側より大きく取る） */
const ZOOM_MAX = 4
/** この倍率以下まで縮小したら全体表示（等倍）に吸着する */
const FIT_SNAP = 1.03
/** 座番・※印をセル内に出す最小倍率 */
const LABEL_MIN_SCALE = 1.8

/**
 * エリアへのクイックジャンプ（R21・評価ラウンド8 S-1）。
 * 統合プラン（R18）では特定の1席を狙うのに全体表示からのピンチ拡大が
 * 前提になり、旧マップの階タブより手順が増えた。チップを押すと対象
 * エリアが指で狙える倍率まで拡大し、そのエリアの中央席へスクロールする。
 * 倍率は当日販売の初期倍率（2.5倍・席が約20px）と同じ考え方。
 */
const JUMP_SCALE = 2.5

interface JumpTarget {
  key: string
  label: string
  /** アンカー席の条件（エリア中央付近の通常席に一致させる） */
  match: (seat: SeatDef) => boolean
}

const JUMP_TARGETS: JumpTarget[] = [
  {
    key: 'f1-front',
    label: '1階前方',
    match: (s) => s.floor === 1 && s.kind === 'normal' && s.row === 6 && s.block === 'center',
  },
  {
    key: 'f1-back',
    label: '1階後方',
    match: (s) => s.floor === 1 && s.kind === 'normal' && s.row === 14 && s.block === 'center',
  },
  {
    key: 'f2',
    label: '2階',
    match: (s) => s.floor === 2 && s.kind === 'normal' && s.row === 22 && s.block === 'center',
  },
]

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

/** プラン単位 → % 換算 */
const px = (v: number) => `${(v / PLAN_W) * 100}%`
const py = (v: number) => `${(v / PLAN_H) * 100}%`

function stateLabel(state: StaffSeatState): string {
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

/** スタッフ座席表の凡例（セルの色と一致させる） */
export function StaffSeatLegend() {
  return (
    <div className="legend" aria-label="座席の凡例">
      <span className="legend-item">
        <span className="legend-swatch sseat-swatch is-available" /> 空席
      </span>
      <span className="legend-item">
        <span className="legend-swatch sseat-swatch is-selected" /> 選択中
      </span>
      <span className="legend-item">
        <span className="legend-swatch sseat-swatch is-reserved" /> 予約済み
      </span>
      <span className="legend-item">
        <span className="legend-swatch sseat-swatch is-paid" /> 支払済・販売済み
      </span>
      <span className="legend-item">
        <span className="legend-swatch sseat-swatch is-blocked" /> 販売しない
      </span>
      <span className="legend-item">※印は見切れ席（舞台の一部が見えにくい席）</span>
    </div>
  )
}

export default function StaffSeatMap({
  data,
  stateOf,
  onSeatTap,
  initialScale = 1,
  seatEnabled,
}: {
  data: AppData
  /** 席ごとの見た目の状態（選択中は呼び出し側が 'selected' を返す） */
  stateOf: (seatId: string) => StaffSeatState
  /** 席タップの通知（可否の判断は呼び出し側） */
  onSeatTap: (seatId: string) => void
  /** 開いた直後の倍率（1 = 全体表示。当日販売は席を狙いやすいよう拡大で開く） */
  initialScale?: number
  /**
   * 選択対象外の席を薄くして押せなくする（R25: 席の手動指定で
   * 「このゾーンの空席だけ」を対象にするとき用）。未指定なら全席が対象。
   */
  seatEnabled?: (seatId: string) => boolean
}) {
  const layout = useMemo(() => buildZoneMapLayout(data), [data])

  /* ---------------- ピンチズーム（ZoneSeatMap と同じ方式） ---------------- */
  const viewportRef = useRef<HTMLDivElement>(null)
  const contentRef = useRef<HTMLDivElement>(null)
  const [scale, setScale] = useState(initialScale)
  const scaleRef = useRef(scale)
  scaleRef.current = scale
  /** コンテンツの自然サイズ（幅 = ビューポート幅、高さ = 実測） */
  const [view, setView] = useState<{ w: number; h: number } | null>(null)
  const viewRef = useRef(view)
  viewRef.current = view
  /* ---------------- クイックジャンプ（R21・S-1） ---------------- */
  const jumpKeyRef = useRef<string | null>(null)
  const [jumpNonce, setJumpNonce] = useState(0)

  const handleJump = (key: string) => {
    jumpKeyRef.current = key
    setScale(JUMP_SCALE)
    setJumpNonce((n) => n + 1)
  }

  // 倍率の確定後に、アンカー席が画面中央へ来るようスクロールする
  // （お客様側 R14 のバッジスクロールと同じ scrollIntoView 方式）
  useLayoutEffect(() => {
    const key = jumpKeyRef.current
    if (!key) return
    jumpKeyRef.current = null
    const target = JUMP_TARGETS.find((t) => t.key === key)
    const ct = contentRef.current
    if (!target || !ct) return
    const anchors = layout.cells.filter((c) => target.match(seatById(c.seatId)))
    const anchor = anchors[Math.floor(anchors.length / 2)]
    if (!anchor) return
    const el = ct.querySelector<HTMLElement>(`[data-seat-id="${anchor.seatId}"]`)
    el?.scrollIntoView({ behavior: 'smooth', block: 'center', inline: 'center' })
  }, [jumpNonce, layout])

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
  }, [layout])

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

  const cellStyle = (c: ZoneMapLayoutCell): CSSProperties => ({
    left: px(c.cx - c.w / 2),
    top: py(c.cy - c.h / 2),
    width: px(c.w),
    height: py(c.h),
    transform: c.rotate !== 0 ? `rotate(${c.rotate}deg)` : undefined,
  })

  const showLabels = scale >= LABEL_MIN_SCALE

  const renderCell = (c: ZoneMapLayoutCell) => {
    const seat = seatById(c.seatId)
    const state = stateOf(c.seatId)
    const enabled = seatEnabled ? seatEnabled(c.seatId) : true
    const cls =
      `sseat-cell zplan-cell` +
      (c.zone ? ` zc-${c.zone.toLowerCase()}` : ' is-neutral') +
      ` is-${state}` +
      (c.shape === 'diamond' ? ' is-diamond' : '') +
      (enabled ? '' : ' is-outofscope')
    return (
      <button
        key={c.seatId}
        type="button"
        className={cls}
        style={cellStyle(c)}
        data-seat-id={c.seatId}
        data-seat-state={state}
        disabled={!enabled}
        onClick={() => onSeatTap(c.seatId)}
        aria-label={`${seat.label}（${stateLabel(state)}${seat.restrictedView ? '・見切れ席' : ''}）`}
      >
        {showLabels && (
          <>
            {seat.shortLabel}
            {seat.restrictedView && (
              <span className="sseat-star" aria-hidden="true">
                ※
              </span>
            )}
          </>
        )}
      </button>
    )
  }

  return (
    <div className="zseat" data-staff-seatmap>
      <div className="zseat-toolbar">
        <span className="zseat-hint">2本指で広げると、座席表を拡大できます</span>
        {scale > 1 && (
          <button
            type="button"
            className="zseat-reset"
            data-sseat-reset
            onClick={() => setScale(1)}
          >
            全体表示に戻す
          </button>
        )}
      </div>
      {/* R21・S-1: エリアへのクイックジャンプ（拡大＋スクロールを1タップで） */}
      <div className="sseat-jumps" role="group" aria-label="エリアへ移動">
        <span className="sseat-jumps-label">エリア</span>
        {JUMP_TARGETS.map((t) => (
          <button
            key={t.key}
            type="button"
            className="sseat-jump"
            data-sseat-jump={t.key}
            onClick={() => handleJump(t.key)}
          >
            {t.label}
          </button>
        ))}
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
            <div className="zseat-grid">
              <div
                className="zplan"
                data-zplan
                style={{ aspectRatio: `${PLAN_W} / ${PLAN_H}` }}
              >
                {/* 図面（輪郭・舞台・通路・箱・列番号）: お客様用と共通 */}
                <PlanChrome rowLabels={layout.rowLabels} />

                {/* 全席セル（席単位でタップできる） */}
                {layout.cells.map(renderCell)}
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
