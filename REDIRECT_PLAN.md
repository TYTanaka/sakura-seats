# GitHub Pages → Cloudflare 誘導計画（カットオーバー手順）

Cloudflare Pages 側の動作確認が取れた後に実施する、旧 URL からの誘導手順。
**まだ実施しない**（このファイルは計画のみ）。

## 前提

- Cloudflare Pages で本番相当の動作確認が済んでいること:
  お客様画面の表示・予約フロー、スタッフ画面（パスコード / Google ログイン）、
  QR 受付、Realtime 同期。
- Supabase の Redirect URLs に Cloudflare の URL が登録済みであること
  （`CLOUDFLARE.md` の「移行後にやること」参照）。
- 共有済みリンク（LINE・ポスター等）は旧 URL `https://tytanaka.github.io/sakura-seats/`
  を指しているため、旧 URL は即時削除せず誘導ページとして残す。

## 手順

1. GitHub Pages のデプロイを止める:
   - `.github/workflows/deploy.yml` の自動デプロイを無効化するか、
     リポジトリ設定（Settings → Pages）で公開元を切り替える。
2. GitHub Pages の公開内容を、以下だけを含むスタブ `index.html` に差し替える
   （`gh-pages` ブランチへ直接 push するか、専用の静的ブランチから公開）:

   ```html
   <!doctype html>
   <html lang="ja">
     <head>
       <meta charset="utf-8" />
       <meta http-equiv="refresh" content="0; url=https://<CloudflareのURL>/" />
       <link rel="canonical" href="https://<CloudflareのURL>/" />
       <title>さくらプラザ・ホール 指定席予約（移転しました）</title>
     </head>
     <body>
       <p>
         予約ページは移転しました。自動で移動しない場合は
         <a href="https://<CloudflareのURL>/">こちら</a>をタップしてください。
       </p>
     </body>
   </html>
   ```

   - `<CloudflareのURL>` は確定した本番 URL（`*.pages.dev` または独自ドメイン）に置換する。
   - パスを引き継ぐ必要がある場合（将来ルーティングを足した場合）は、
     meta refresh では不十分なので、その時点で再検討する。現行は単一ページで
     ハッシュも使っていないため、単純な誘導で問題ない。
3. 旧 URL を開いて Cloudflare 側へ即時遷移することを確認する。
4. 共有文面・ポスター等のリンクを順次 Cloudflare の URL に差し替える
   （コード側の共有 URL は実行時導出なので、アプリ側の変更は不要）。

## 切り戻し

問題が出たら、GitHub Pages の公開を元のビルドに戻す
（`deploy.yml` を再度有効化して main を push すれば従来どおり配信される）。
Supabase 側のデータは配信先に依存しないため、切り戻しでデータは失われない。
