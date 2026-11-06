import { useEffect, useState } from 'react'

/**
 * 受付担当者（R38）: スタッフ画面で「今この端末を操作している人」を選び、
 * チェックイン・支払い確定の処理者として予約に記録するための仕組み。
 * 名前の候補は公演設定の販売者名リストを流用する（SellerTotals と同じ母集団）。
 * 端末ごとに覚える（localStorage）ため、受付端末が複数あっても
 * それぞれの担当者を保てる。ストア層（local/cloud 両方）は操作のたびに
 * getCurrentOperator() を読み、純粋関数・RPC へ渡す。
 */

const OPERATOR_KEY = 'sakura-seats-operator'

export function getCurrentOperator(): string {
  try {
    return localStorage.getItem(OPERATOR_KEY) ?? ''
  } catch {
    return ''
  }
}

export function setCurrentOperator(name: string): void {
  try {
    if (name) localStorage.setItem(OPERATOR_KEY, name)
    else localStorage.removeItem(OPERATOR_KEY)
  } catch {
    // 保存できなくても今回のセッションでは state 側で保持する
  }
}

/** 担当者の React state（他タブ・他コンポーネントの変更にも追随する） */
export function useCurrentOperator(): [string, (name: string) => void] {
  const [operator, setOperatorState] = useState<string>(getCurrentOperator)

  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.key === OPERATOR_KEY) setOperatorState(getCurrentOperator())
    }
    window.addEventListener('storage', onStorage)
    return () => window.removeEventListener('storage', onStorage)
  }, [])

  const setOperator = (name: string) => {
    setCurrentOperator(name)
    setOperatorState(name)
  }
  return [operator, setOperator]
}
