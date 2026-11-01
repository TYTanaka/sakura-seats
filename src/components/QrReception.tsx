import { useCallback, useEffect, useRef, useState } from 'react'
import { seatById } from '../data/seats'
import {
  formatYen,
  reservationDisplayName,
  reservationTotal,
  reservationTypeSummary,
  type Reservation,
} from '../lib/logic'
import type { BarcodeDetectorLike } from '../lib/qr'
import { useStore } from '../lib/store'
import { useToast } from '../lib/toast'

type CamStatus = 'starting' | 'scanning' | 'manual'

/**
 * QRで受付モード:
 * カメラで予約番号QRを読み取り、読み込んであるスタッフ用データから該当予約を表示する。
 * - 読み取りは BarcodeDetector（あれば）→ jsQR（動的 import）の順で試す
 * - カメラが使えない/許可されない場合は、手入力フォームにフォールバックする（ dead end にしない）
 * - 新しい RPC は足さず、スタッフ入室時に読み込んだ予約データから検索する
 */
export default function QrReception({ onClose }: { onClose: () => void }) {
  const { data, cancel, setCheckedIn, setPaid, completeReception } = useStore()
  const { showToast } = useToast()
  const [status, setStatus] = useState<CamStatus>('starting')
  const [camError, setCamError] = useState('')
  const [manual, setManual] = useState('')
  const [foundId, setFoundId] = useState<string | null>(null)
  const [notFoundCode, setNotFoundCode] = useState('')
  const [confirmingCancel, setConfirmingCancel] = useState(false)

  const videoRef = useRef<HTMLVideoElement | null>(null)
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const detectorRef = useRef<BarcodeDetectorLike | null>(null)
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

  const handleCode = useCallback(
    (raw: string) => {
      const code = raw.trim().toUpperCase()
      if (!code) return
      stopCamera()
      setStatus('manual')
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
  const handleCodeRef = useRef(handleCode)
  handleCodeRef.current = handleCode

  const startCamera = useCallback(async () => {
    if (startingRef.current) return
    startingRef.current = true
    stoppedRef.current = false
    setStatus('starting')
    setCamError('')
    try {
      if (!navigator.mediaDevices?.getUserMedia) {
        setStatus('manual')
        setCamError(
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
      } catch {
        if (!stoppedRef.current) {
          setStatus('manual')
          setCamError(
            'カメラを使えませんでした（許可されていないか、他のアプリが使用中です）。下の欄に予約番号を入力してください。',
          )
        }
        return
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
              const results = await detector.detect(v)
              code = results?.[0]?.rawValue ?? null
            } else {
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
              handleCodeRef.current(code)
              return
            }
          } catch {
            /* 読み取り失敗は無視して次のフレームで再試行する */
          } finally {
            busyRef.current = false
          }
        }
        if (!stoppedRef.current) {
          timerRef.current = window.setTimeout(() => void tick(), 150)
        }
      }
      timerRef.current = window.setTimeout(() => void tick(), 150)
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
    void fn().catch(() =>
      showToast('操作に失敗しました。接続を確認してもう一度お試しください'),
    )
  }

  const scanNext = () => {
    setFoundId(null)
    setNotFoundCode('')
    setConfirmingCancel(false)
    void startCamera()
  }

  return (
    <div className="qr-reception" data-qr-reception>
      <div className="btn-row qr-reception-head">
        <h4 className="qr-reception-title">QRで受付</h4>
        <button type="button" className="btn btn-ghost btn-small" onClick={onClose}>
          ← 受付一覧に戻る
        </button>
      </div>
      <p className="muted small">
        お客様の予約完了画面・予約確認画面にあるQRコードをカメラに映すと、その予約が表示されます。
      </p>

      {!res && !notFoundCode && (
        <>
          <div className="qr-video-wrap">
            <video
              ref={videoRef}
              className="qr-video"
              data-qr-video
              playsInline
              muted
            />
            {status !== 'scanning' && (
              <div className="qr-video-overlay">
                {status === 'starting' ? 'カメラを起動しています…' : 'カメラは使えません'}
              </div>
            )}
          </div>
          <canvas ref={canvasRef} hidden />
          {status === 'scanning' && (
            <p className="qr-scan-note">QRコードをカメラに映してください…</p>
          )}
          {camError && (
            <p className="error-text" data-qr-error>
              {camError}
            </p>
          )}
        </>
      )}

      <form
        className="qr-manual"
        onSubmit={(e) => {
          e.preventDefault()
          handleCode(manual)
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
            <div className="reservation-main">
              <p className="reservation-title">
                <span className="reservation-code-small" data-qr-result-code>
                  {res.id}
                </span>
                <span className="reservation-name">{reservationDisplayName(res)}</span>
                <span className={`source-badge source-${res.source}`}>
                  {res.source === 'door' ? '当日販売' : '予約'}
                </span>
                {res.cancelled && (
                  <span className="source-badge source-cancelled">キャンセル済</span>
                )}
              </p>
              <p className="muted small">
                {res.seatIds.map((id) => seatById(id).label).join('、')}
              </p>
              <p className="muted small">
                <span data-type-breakdown>{reservationTypeSummary(res)}</span>
                {' ／ '}電話：{res.phone || '（未入力）'} ／ 合計{' '}
                {formatYen(reservationTotal(res))}
                {res.note && <> ／ 備考：{res.note}</>}
              </p>
            </div>
            {!res.cancelled && (
              <div className="reservation-actions">
                {!(res.paid && res.checkedIn) && (
                  <button
                    type="button"
                    data-action="complete"
                    className="toggle-btn complete-btn"
                    onClick={() => runAction(() => completeReception(res.id))}
                  >
                    受付完了（支払い＋来場）
                  </button>
                )}
                <button
                  type="button"
                  data-action="checkin"
                  aria-pressed={res.checkedIn}
                  className={`toggle-btn${res.checkedIn ? ' on' : ''}`}
                  onClick={() => runAction(() => setCheckedIn(res.id, !res.checkedIn))}
                >
                  {res.checkedIn ? '✓ 来場済み' : '来場チェックイン'}
                </button>
                <button
                  type="button"
                  data-action="pay"
                  aria-pressed={res.paid}
                  className={`toggle-btn${res.paid ? ' on' : ''}`}
                  onClick={() => runAction(() => setPaid(res.id, !res.paid))}
                >
                  {res.paid ? '✓ 支払い済み' : '支払い済みにする'}
                </button>
                {confirmingCancel ? (
                  <span className="cancel-confirm">
                    キャンセルしますか？
                    <button
                      type="button"
                      className="btn btn-danger btn-small"
                      onClick={() => {
                        runAction(() => cancel(res.id))
                        setConfirmingCancel(false)
                      }}
                    >
                      キャンセルする
                    </button>
                    <button
                      type="button"
                      className="btn btn-ghost btn-small"
                      onClick={() => setConfirmingCancel(false)}
                    >
                      やめる
                    </button>
                  </span>
                ) : (
                  <button
                    type="button"
                    className="btn btn-ghost btn-small"
                    onClick={() => setConfirmingCancel(true)}
                  >
                    予約キャンセル
                  </button>
                )}
              </div>
            )}
          </div>
          <button type="button" className="btn btn-primary btn-block" onClick={scanNext}>
            次のQRを読み取る
          </button>
        </div>
      )}
    </div>
  )
}
