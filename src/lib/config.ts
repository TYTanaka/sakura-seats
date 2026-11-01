/**
 * クラウド（Supabase）接続の設定だけを切り出した軽量モジュール。
 * クライアント本体（重い @supabase/supabase-js）とは別にし、
 * クラウド用ストアを動的 import するときだけ読み込む。
 */
const url = import.meta.env.VITE_SUPABASE_URL as string | undefined
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined

export const SUPABASE_URL = url
export const SUPABASE_ANON_KEY = anonKey
export const cloudEnabled: boolean = Boolean(url && anonKey)
