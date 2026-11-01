import {
  createContext,
  useCallback,
  useContext,
  useRef,
  useState,
  type ReactNode,
} from 'react'

/**
 * 軽量トースト（R4-4）。
 * スタッフ操作の失敗を「一覧の上部」ではなく、その場で必ず目に入る位置
 * （画面下部固定）に出すための仕組み。数秒で自動的に消える。
 */

export type ToastKind = 'error' | 'info'

interface ToastItem {
  id: number
  message: string
  kind: ToastKind
}

interface ToastApi {
  showToast: (message: string, kind?: ToastKind) => void
}

const ToastContext = createContext<ToastApi | null>(null)

export function useToast(): ToastApi {
  const api = useContext(ToastContext)
  if (!api) throw new Error('useToast は ToastProvider の中で使ってください')
  return api
}

const TOAST_DURATION_MS = 4500

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<ToastItem[]>([])
  const idRef = useRef(0)
  const timersRef = useRef<Map<number, ReturnType<typeof setTimeout>>>(new Map())

  const dismiss = useCallback((id: number) => {
    setToasts((prev) => prev.filter((t) => t.id !== id))
    const timer = timersRef.current.get(id)
    if (timer) {
      clearTimeout(timer)
      timersRef.current.delete(id)
    }
  }, [])

  const showToast = useCallback(
    (message: string, kind: ToastKind = 'error') => {
      idRef.current += 1
      const id = idRef.current
      setToasts((prev) => [...prev.slice(-2), { id, message, kind }])
      const timer = setTimeout(() => dismiss(id), TOAST_DURATION_MS)
      timersRef.current.set(id, timer)
    },
    [dismiss],
  )

  return (
    <ToastContext.Provider value={{ showToast }}>
      {children}
      <div className="toast-stack" aria-live="polite">
        {toasts.map((t) => (
          <div key={t.id} className={`toast toast-${t.kind}`} data-toast role="status">
            <span className="toast-message">{t.message}</span>
            <button
              type="button"
              className="toast-close"
              aria-label="閉じる"
              onClick={() => dismiss(t.id)}
            >
              ×
            </button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  )
}
