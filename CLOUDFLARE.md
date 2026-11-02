# Cloudflare Pages へのデプロイ設定

さくら席を GitHub Pages から Cloudflare Pages へ移す際の設定メモ。
コード側は配信先に依存しない作りになっており、違いは **ビルド時の環境変数だけ**。

## Cloudflare Pages プロジェクト設定

| 項目 | 値 |
| --- | --- |
| プロジェクトの接続先 | GitHub リポジトリ `TYTanaka/sakura-seats` |
| Production branch | `main` |
| Root directory（Build settings の "Root directory"） | `app` |
| Build command | `npm run build` |
| Build output directory | `dist` |
| Node.js バージョン | 22（環境変数 `NODE_VERSION=22` を推奨） |

## 環境変数（Production / Preview 共通）

| 名前 | 値 | 備考 |
| --- | --- | --- |
| `VITE_BASE` | `/` | Cloudflare はルート配信。GitHub Pages では未設定（既定 `/sakura-seats/`） |
| `VITE_SUPABASE_URL` | `https://nsjcjvchqjahdnxoqdvl.supabase.co` | GitHub Actions の vars と同じ値 |
| `VITE_SUPABASE_ANON_KEY` | （GitHub リポジトリ Variables と同じ anon key） | 公開してよいキー（RLS + RPC で保護） |
| `NODE_VERSION` | `22` | 任意 |

## 同梱物

- `public/_headers` — セキュリティヘッダ（CSP 等）。Cloudflare Pages が自動で読み込む。
  GitHub Pages では無視されるので、移行前から置いて問題ない。
- ルータを使わない単一ページ構成のため、SPA フォールバック設定（`_redirects`）は不要。

## 移行後にやること

1. Cloudflare の URL（`*.pages.dev` または独自ドメイン）で表示・予約・スタッフ画面を確認。
2. **Supabase 側の許可リストに Cloudflare の URL を追加**する:
   Supabase ダッシュボード → Authentication → URL Configuration → Redirect URLs に
   Cloudflare の URL（末尾 `/` まで）を追加。Google ログインの戻り先として必須。
   あわせて Authentication → Providers → Google を有効化（Client ID / Secret は
   Google Cloud 側で発行した Web クライアントのもの。Google Cloud 側の
   「承認済みのリダイレクト URI」は `https://nsjcjvchqjahdnxoqdvl.supabase.co/auth/v1/callback`）。
3. 問題なければ `REDIRECT_PLAN.md` の手順で GitHub Pages 側を誘導ページに切り替える。
