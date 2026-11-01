import { useEffect, useState } from 'react'

/**
 * 一定間隔で「現在時刻」を再評価するフック（R4-1）。
 * 予約締切のように、ページを開いたまま時刻が進むことで状態が変わる判定に使う。
 * タブが再び表示された瞬間にも即座に更新する。
 */
export function useNow(intervalMs = 10000): number {
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    const update = () => setNow(Date.now())
    const id = setInterval(update, intervalMs)
    const onVisibility = () => {
      if (document.visibilityState === 'visible') update()
    }
    document.addEventListener('visibilitychange', onVisibility)
    return () => {
      clearInterval(id)
      document.removeEventListener('visibilitychange', onVisibility)
    }
  }, [intervalMs])

  return now
}
