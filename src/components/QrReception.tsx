import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { Reservation } from '../lib/logic'
import type { BarcodeDetectorLike } from '../lib/qr'
import { parseQrPayload } from '../lib/qrToken'
import { useStore, type CheckInOutcome } from '../lib/store'
import { useToast } from '../lib/toast'
import { allZoneAvailability, reservationSeatDisplay } from '../lib/zones'
import ReservationCard, { formatCheckedInAt } from './ReservationCard'
import ZoneSeatMap from './ZoneSeatMap'

/**
 * R17: 受付結果に添える座席表。「お席はここです」と指せるよう、
 * 割り当てられた席だけを公式図形の座席表の上で光らせる（表示専用）。
 * 席が無い結果（失敗・未割当）では何も出さない。
 */
function AssignedSeatMap({ reservation }: { reservation: Reservation | null }) {
  const { data } = useStore()
  const availability = useMemo(() => allZoneAvailability(data), [data])
  if (!reservation || reservation.seatIds.length === 0) return null
  return (
    <div className="qr-outcome-map" data-qr-seat-map>
      <p className="qr-outcome-map-label">お席の場所（光っている席です）</p>
      <ZoneSeatMap
        data={data}
        availability={availability}
        onPick={() => {}}
        disabled
        mini
        highlightSeats={reservation.seatIds}
      />
    </div>
  )
}

/**
 * カメラの状態。行き止まりを作らないため、使えない理由ごとに分ける（R7）。
 * - requesting: 起動中
 * - scanning: 読み取り中
 * - denied: 許可されなかった（再試行ボタン＋許可の仕方を案内）
 * - unavailable: カメラ自体が無い・掴めない（再試行ボタン＋手入力案内）
 */
type CamStatus = 'requesting' | 'scanning' | 'denied' | 'unavailable'

/** 読み取り方式。BarcodeDetector が壊れていたら jsQR に切り替える */
type Decoder = 'barcode-detector' | 'jsqr'

/** スキャン結果の表示分類 */
type ScanOutcome =
  | { kind: 'checked-in'; outcome: CheckInOutcome }
  | { kind: 'already'; outcome: CheckInOutcome }
  | { kind: 'cancelled'; outcome: CheckInOutcome }
  | { kind: 'wrong-performance'; outcome: CheckInOutcome }
  | { kind: 'not-found' }
  | { kind: 'server-pending' }
  | { kind: 'legacy'; code: string }
  | { kind: 'invalid' }
  | { kind: 'error'; message?: string }



/**
 * QRで受付モード（R7でサーバ検証式に刷新）:
 * QR の中身は予約ごとのトークンだけ。読み取ったらストア経由で検証する
 * （クラウド: staff_check_in RPC がサーバ検証 / ローカル: 端末内検証）。
 * 連番の予約番号を信頼する旧方式は廃止し、偽造・改ざんは「無効なQR」になる。
 * 旧形式（番号そのまま）の QR は、案内を出したうえで番号照合に回す。
 *
 * カメラ読み取りの頑健化（実機で BarcodeDetector が使えない事象への対処）:
 * - BarcodeDetector があっても detect() が連続で失敗したら jsQR に切り替える
 *   （API の有無だけで判断しない。サンドボックス検証は jsQR 経路のみだった）
 * - 許可拒否・カメラ無し・起動中を状態として分け、再試行できるようにする
 * - 手入力フォームは常時表示する
 */
export default function QrReception({ onClose }: { onClose: () => void }) {
  const {
    data,
    cancel,
    setCheckedIn,
    setPaid,
    completeReception,
    checkInByToken,
    assignSeats,
  } = useStore()
  const { showToast } = useToast()
  const [status, setStatus] = useState<CamStatus>('requesting')
  const [camMessage, setCamMessage] = useState('')
  const [decoder, setDecoder] = useState<Decoder>('jsqr')
  const [manual, setManual] = useState('')
  const [foundId, setFoundId] = useState<string | null>(null)
  const [notFoundCode, setNotFoundCode] = useState('')
  const [outcome, setOutcome] = useState<ScanOutcome | null>(null)
  const [verifying, setVerifying] = useState(false)

  const videoRef = useRef<HTMLVideoElement | null>(null)
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const detectorRef = useRef<BarcodeDetectorLike | null>(null)
  const detectorFailuresRef = useRef(0)
  const timerRef = useRef<number | undefined>(undefined)
  const busyRef = useRef(false)
  const stoppedRef = useRef(true)
  const startingRef = useRef(false)

  const dataRef = useRef(data)
  dataRef.current = data

  const stopCamera = useCallback(() => {
    stoppedRef.current = true
    if (timerRef.current !== undefined) {
      window.clearTimeout(timerRef.current)
      timerRef.current = undefined
    }
    streamRef.current?.getTracks().forEach((t) => t.stop())
    streamRef.current = null
    if (videoRef.current) videoRef.current.srcObject = null
  }, [])

  /** 予約番号での表示（手入力・旧形式QRのフォールバック共通） */
  const showByCode = useCallback(
    (rawCode: string) => {
      const code = rawCode.trim().toUpperCase()
      if (!code) return
      stopCamera()
      setManual('')
      const res =
        dataRef.current.reservations.find((r) => r.id.toUpperCase() === code) ?? null
      if (res) {
        setFoundId(res.id)
        setNotFoundCode('')
      } else {
        setFoundId(null)
        setNotFoundCode(code)
      }
    },
    [stopCamera],
  )

  /** 読み取った文字列の振り分け: トークン検証 / 旧形式案内 / 無効 */
  const handleScanned = useCallback(
    async (raw: string) => {
      const parsed = parseQrPayload(raw)
      if (parsed.kind === 'legacy') {
        stopCamera()
        setOutcome({ kind: 'legacy', code: parsed.code })
        setManual(parsed.code)
        // 案内を出したうえで、番号照合で予約を表示する
        const code = parsed.code
        const res =
          dataRef.current.reservations.find((r) => r.id.toUpperCase() === code) ?? null
        if (res) {
          setFoundId(res.id)
          setNotFoundCode('')
        } else {
          setFoundId(null)
          setNotFoundCode(code)
        }
        return
      }
      if (parsed.kind === 'invalid') {
        stopCamera()
        setOutcome({ kind: 'invalid' })
        return
      }
      stopCamera()
      setVerifying(true)
      try {
        const result = await checkInByToken(parsed.token)
        switch (result.result) {
          case 'OK':
            setOutcome({ kind: 'checked-in', outcome: result })
            if (result.reservation) {
              setFoundId(result.reservation.id)
              showToast(`${result.reservation.id} を受付にしました`, 'info')
            }
            break
          case 'ALREADY_CHECKED_IN':
            setOutcome({ kind: 'already', outcome: result })
            if (result.reservation) setFoundId(result.reservation.id)
            break
          case 'CANCELLED':
            setOutcome({ kind: 'cancelled', outcome: result })
            if (result.reservation) setFoundId(result.reservation.id)
            break
          case 'WRONG_PERFORMANCE':
            setOutcome({ kind: 'wrong-performance', outcome: result })
            break
          case 'SERVER_PENDING':
            setOutcome({ kind: 'server-pending' })
            break
          default:
            setOutcome({ kind: 'not-found' })
            break
        }
      } catch (e) {
        // R17: 席を自動で割り当てられなかった場合は、理由をそのまま見せる
        // （汎用の「照合に失敗しました」ではスタッフが次に何をすべきか分からない）
        const message =
          e instanceof Error && e.message.includes('割り当て')
            ? e.message
            : undefined
        setOutcome({ kind: 'error', message })
      } finally {
        setVerifying(false)
      }
    },
    [checkInByToken, showToast, stopCamera],
  )
  const handleScannedRef = useRef(handleScanned)
  handleScannedRef.current = handleScanned

  const startCamera = useCallback(async () => {
    if (startingRef.current) return
    startingRef.current = true
    stoppedRef.current = false
    setStatus('requesting')
    setCamMessage('')
    try {
      if (!navigator.mediaDevices?.getUserMedia) {
        setStatus('unavailable')
        setCamMessage(
          'この端末・ブラウザではカメラを利用できません。下の欄に予約番号を入力してください。',
        )
        return
      }
      let stream: MediaStream
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: { ideal: 'environment' } },
          audio: false,
        })
      } catch (firstError) {
        // 背面カメラ指定で掴めない端末向けに、指定なしでもう一度試す
        const firstName =
          firstError instanceof DOMException ? firstError.name : ''
        if (firstName === 'OverconstrainedError' || firstName === 'NotFoundError') {
          try {
            stream = await navigator.mediaDevices.getUserMedia({
              video: true,
              audio: false,
            })
          } catch (secondError) {
            if (!stoppedRef.current) {
              const name =
                secondError instanceof DOMException ? secondError.name : ''
              if (name === 'NotAllowedError' || name === 'SecurityError') {
                setStatus('denied')
                setCamMessage(
                  'カメラの使用が許可されていません。ブラウザのアドレスバー左のアイコン（サイトの設定）からカメラを「許可」に変えてから、もう一度お試しください。',
                )
              } else {
                setStatus('unavailable')
                setCamMessage(
                  'カメラを起動できませんでした（カメラが見つからないか、他のアプリが使用中です）。下の欄に予約番号を入力してください。',
                )
              }
            }
            return
          }
        } else if (!stoppedRef.current) {
          if (firstName === 'NotAllowedError' || firstName === 'SecurityError') {
            setStatus('denied')
            setCamMessage(
              'カメラの使用が許可されていません。ブラウザのアドレスバー左のアイコン（サイトの設定）からカメラを「許可」に変えてから、もう一度お試しください。',
            )
          } else {
            setStatus('unavailable')
            setCamMessage(
              'カメラを起動できませんでした（他のアプリが使用中かもしれません）。下の欄に予約番号を入力してください。',
            )
          }
          return
        } else {
          return
        }
      }
      if (stoppedRef.current) {
        stream.getTracks().forEach((t) => t.stop())
        return
      }
      streamRef.current = stream
      const { createBarcodeDetector } = await import('../lib/qr')
      if (stoppedRef.current) {
        stream.getTracks().forEach((t) => t.stop())
        streamRef.current = null
        return
      }
      detectorRef.current = createBarcodeDetector()
      detectorFailuresRef.current = 0
      setDecoder(detectorRef.current ? 'barcode-detector' : 'jsqr')
      const video = videoRef.current
      if (video) {
        video.srcObject = stream
        try {
          await video.play()
        } catch {
          /* 自動再生に失敗してもプレビュー自体は継続を試みる */
        }
      }
      if (stoppedRef.current) return
      setStatus('scanning')

      const tick = async () => {
        if (stoppedRef.current) return
        const v = videoRef.current
        if (v && v.readyState >= 2 && v.videoWidth > 0 && !busyRef.current) {
          busyRef.current = true
          try {
            let code: string | null = null
            const detector = detectorRef.current
            if (detector) {
              try {
                const results = await detector.detect(v)
                detectorFailuresRef.current = 0
                code = results?.[0]?.rawValue ?? null
              } catch {
                // BarcodeDetector があるのに読み取り自体が壊れている端末では、
                // 連続失敗を数えて jsQR に切り替える（無言で詰まらせない）
                detectorFailuresRef.current += 1
                if (detectorFailuresRef.current >= 3) {
                  detectorRef.current = null
                  setDecoder('jsqr')
                }
              }
            }
            if (!code && !detectorRef.current) {
              const canvas = canvasRef.current
              if (canvas) {
                const scale = Math.min(1, 640 / v.videoWidth)
                canvas.width = Math.max(1, Math.round(v.videoWidth * scale))
                canvas.height = Math.max(1, Math.round(v.videoHeight * scale))
                const ctx = canvas.getContext('2d', { willReadFrequently: true })
                if (ctx) {
                  ctx.drawImage(v, 0, 0, canvas.width, canvas.height)
                  const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height)
                  const { decodeQrWithJsQr } = await import('../lib/qr')
                  code = await decodeQrWithJsQr(imageData)
                }
              }
            }
            if (code && !stoppedRef.current) {
              void handleScannedRef.current(code)
              return
            }
          } catch {
            /* 読み取り失敗は無視して次のフレームで再試行する */
          } finally {
            busyRef.current = false
          }
        }
        if (!stoppedRef.current) {
          timerRef.current = window.setTimeout(() => void tick(), 200)
        }
      }
      timerRef.current = window.setTimeout(() => void tick(), 200)
    } finally {
      startingRef.current = false
    }
  }, [])

  useEffect(() => {
    void startCamera()
    return () => stopCamera()
  }, [startCamera, stopCamera])

  const res: Reservation | null = foundId
    ? (data.reservations.find((r) => r.id === foundId) ?? null)
    : null

  const runAction = (fn: () => Promise<void>) => {
    void fn().catch((e: unknown) =>
      showToast(
        e instanceof Error && e.message
          ? e.message
          : '操作に失敗しました。接続を確認してもう一度お試しください',
      ),
    )
  }

  /**
   * 支払いトグル（R21・ラウンド8 S-2、受付一覧と同じ）: 来場済みの
   * ゾーン予約を未払いに戻しても席は保持されるため、その旨を知らせる。
   */
  const handleTogglePaid = (target: Reservation) => {
    void (async () => {
      try {
        await setPaid(target.id, !target.paid)
        if (target.paid && target.checkedIn && target.zone && target.seatIds.length > 0) {
          showToast('来場済みのため、席はそのまま保持しました', 'info')
        }
      } catch (e) {
        showToast(
          e instanceof Error && e.message
            ? e.message
            : '操作に失敗しました。接続を確認してもう一度お試しください',
        )
      }
    })()
  }

  /**
   * 席の手動指定（R25・ラウンド10 S-1、受付一覧と同じ）:
   * 失敗は理由をトーストで出し、カード側のパネルを開いたままにするため
   * 例外をそのまま投げ直す。
   */
  const handleAssignSeats = async (target: Reservation, seatIds: string[]) => {
    try {
      await assignSeats(target.id, seatIds)
      showToast(`${target.id} の席を指定しました`, 'info')
    } catch (e) {
      showToast(
        e instanceof Error && e.message
          ? e.message
          : '席の指定に失敗しました。接続を確認してもう一度お試しください',
      )
      throw e
    }
  }

  /** 受付完了の成功トースト（R6・O-2、受付一覧と同じ文面に揃える） */
  const handleComplete = (target: Reservation) => {
    void completeReception(target.id)
      .then(() => showToast(`${target.id} を受付完了にしました`, 'info'))
      .catch((e: unknown) =>
        showToast(
          e instanceof Error && e.message
            ? e.message
            : '操作に失敗しました。接続を確認してもう一度お試しください',
        ),
      )
  }

  const scanNext = () => {
    setFoundId(null)
    setNotFoundCode('')
    setOutcome(null)
    void startCamera()
  }

  const showCamera = !res && !notFoundCode && !outcome && !verifying

  return (
    <div className="qr-reception" data-qr-reception data-qr-decoder={decoder}>
      <div className="btn-row qr-reception-head">
        <h3 className="qr-reception-title sub-h">QRで受付</h3>
        <button type="button" className="btn btn-ghost btn-small" onClick={onClose}>
          ← 受付一覧に戻る
        </button>
      </div>
      <p className="muted small">
        お客様の予約完了画面・予約確認画面にあるQRコードをカメラに映してください。サーバで照合してから受付します。
      </p>

      {showCamera && (
        <>
          {(status === 'requesting' || status === 'scanning') && (
            <div className="qr-video-wrap">
              <video
                ref={videoRef}
                className="qr-video"
                data-qr-video
                playsInline
                muted
                autoPlay
              />
              {status === 'requesting' && (
                <div className="qr-video-overlay">カメラを起動しています…</div>
              )}
            </div>
          )}
          {status === 'scanning' && (
            <p className="qr-scan-note">QRコードをカメラに映してください…</p>
          )}
          {(status === 'denied' || status === 'unavailable') && (
            <div className="qr-cam-panel" data-qr-cam-state={status}>
              <p className="error-text" data-qr-error>
                {camMessage}
              </p>
              <button
                type="button"
                className="btn btn-ghost btn-block"
                data-qr-cam-retry
                onClick={() => void startCamera()}
              >
                カメラをもう一度試す
              </button>
            </div>
          )}
          <canvas ref={canvasRef} hidden />
        </>
      )}

      {verifying && (
        <p className="qr-scan-note" data-qr-verifying>
          QRコードを照合しています…
        </p>
      )}

      {outcome && (
        <div
          className={`qr-outcome qr-outcome-${outcome.kind}`}
          data-qr-outcome={outcome.kind}
        >
          {outcome.kind === 'checked-in' && (
            <>
              <p className="qr-outcome-title">✓ 受付が完了しました</p>
              {outcome.outcome.reservation &&
                outcome.outcome.reservation.seatIds.length > 0 && (
                  <p className="qr-outcome-seats" data-qr-assigned-seats>
                    お席：{reservationSeatDisplay(outcome.outcome.reservation).text}
                  </p>
                )}
              <AssignedSeatMap reservation={outcome.outcome.reservation} />
            </>
          )}
          {outcome.kind === 'already' && (
            <>
              <p className="qr-outcome-title">このQRは使用済みです</p>
              <p className="small">
                {formatCheckedInAt(outcome.outcome.checkedInAt)
                  ? `${formatCheckedInAt(outcome.outcome.checkedInAt)} に受付済みです。二重受付はされません。`
                  : 'すでに受付済みです。二重受付はされません。'}
              </p>
              {outcome.outcome.reservation &&
                outcome.outcome.reservation.seatIds.length > 0 && (
                  <p className="qr-outcome-seats" data-qr-assigned-seats>
                    お席：{reservationSeatDisplay(outcome.outcome.reservation).text}
                  </p>
                )}
              <AssignedSeatMap reservation={outcome.outcome.reservation} />
            </>
          )}
          {outcome.kind === 'cancelled' && (
            <>
              <p className="qr-outcome-title">この予約はキャンセル済みです</p>
              <p className="small">受付はできません。お客様には主催者への連絡をご案内ください。</p>
            </>
          )}
          {outcome.kind === 'wrong-performance' && (
            <>
              <p className="qr-outcome-title">別の公演のQRコードです</p>
              <p className="small">
                {outcome.outcome.reservation
                  ? `この予約は「${outcome.outcome.reservation.perfName ?? ''}（${outcome.outcome.reservation.perfDate ?? ''}）」のものです。現在の公演設定と一致しないため受付できません。`
                  : '現在の公演設定と一致しないため受付できません。'}
              </p>
            </>
          )}
          {outcome.kind === 'not-found' && (
            <>
              <p className="qr-outcome-title">無効なQRコードです</p>
              <p className="small">
                予約が見つかりませんでした。お客様の予約番号を確認して、下の欄から受付してください。
              </p>
            </>
          )}
          {outcome.kind === 'invalid' && (
            <>
              <p className="qr-outcome-title">無効なQRコードです</p>
              <p className="small">
                このアプリの受付用QRではないようです。お客様の予約番号を確認して、下の欄から受付してください。
              </p>
            </>
          )}
          {outcome.kind === 'server-pending' && (
            <>
              <p className="qr-outcome-title">QR受付はサーバ更新の準備中です</p>
              <p className="small">
                サーバ更新の準備が終わるまで QR
                受付は使えません。当面は下の欄に予約番号を入力して受付してください。
              </p>
            </>
          )}
          {outcome.kind === 'legacy' && (
            <>
              <p className="qr-outcome-title">旧形式のQRコードです</p>
              <p className="small">
                予約番号「{outcome.code}」で照合しました。以後の受付は新しいQRコード（予約確認画面で再表示できます）をご案内ください。
              </p>
            </>
          )}
          {outcome.kind === 'error' && (
            <>
              <p className="qr-outcome-title">
                {outcome.message ? '席を用意できませんでした' : '照合に失敗しました'}
              </p>
              <p className="small">
                {outcome.message ??
                  '接続を確認してもう一度お試しいただくか、下の欄に予約番号を入力してください。'}
              </p>
            </>
          )}
        </div>
      )}

      <form
        className="qr-manual"
        onSubmit={(e) => {
          e.preventDefault()
          setOutcome(null)
          showByCode(manual)
        }}
      >
        <label className="field">
          <span>予約番号を手入力（カメラが使えないとき）</span>
          <input
            type="text"
            data-qr-manual-input
            value={manual}
            onChange={(e) => setManual(e.target.value)}
            placeholder="例：SK-0001"
            autoComplete="off"
          />
        </label>
        <button
          type="submit"
          className="btn btn-primary btn-block"
          data-qr-manual-submit
          disabled={!manual.trim()}
        >
          この予約番号で表示する
        </button>
      </form>

      {notFoundCode && (
        <div className="qr-result" data-qr-notfound>
          <p className="error-text">
            予約番号「{notFoundCode}」の予約が見つかりませんでした。番号をご確認ください。
          </p>
          <button type="button" className="btn btn-ghost btn-block" onClick={scanNext}>
            もう一度読み取る
          </button>
        </div>
      )}

      {res && (
        <div className="qr-result" data-qr-result>
          <p className="success-text">予約が見つかりました</p>
          <div className="reservation-item">
            <ReservationCard
              res={res}
              onComplete={handleComplete}
              onToggleCheckIn={(r) => runAction(() => setCheckedIn(r.id, !r.checkedIn))}
              onTogglePaid={handleTogglePaid}
              onCancel={(r) => runAction(() => cancel(r.id))}
              onAssignSeats={handleAssignSeats}
            />
          </div>
          {/* R36（中8）: カード側の受付が未完了の間は「次のQR」を主ボタンに
              しない。先に押すと未完了のまま次へ進む事故の形になるため、
              完了（支払済＋来場済）までは ghost に落とし、完了後に主へ戻す */}
          <button
            type="button"
            className={`btn btn-block ${res.paid && res.checkedIn ? 'btn-primary' : 'btn-ghost'}`}
            onClick={scanNext}
          >
            次のQRを読み取る
          </button>
        </div>
      )}

      {!res && outcome && outcome.kind !== 'legacy' && (
        <button type="button" className="btn btn-primary btn-block" onClick={scanNext}>
          次のQRを読み取る
        </button>
      )}
    </div>
  )
}
