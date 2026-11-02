-- ============================================================================
-- sakura-seats 追加マイグレーション (R9): サーバ側の不正対策（スロットリング
-- ＋予約フラッド防止）
-- Supabase ダッシュボードの SQL Editor でそのまま実行できる冪等なスクリプト。
-- 前提: migration_sakura.sql / _r4 / _r6 / _r7 / _r8 が適用済みであること。
--
-- 目的（2026-11-02 のオーナー指示: 攻撃されても落ちない・個人情報を抜かれない）:
-- - パスコード総当たり: ログイン専用 RPC staff_login が失敗をクライアント
--   IP単位で数え、上限を超えたら一定時間その送信元からのパスコード認証を
--   全面拒否する（sakura_check_passcode 側のロックゲートで全スタッフ RPC に
--   効かせる）。
--   なぜログイン専用 RPC で数えるのか: PostgREST の RPC は1トランザクション
--   で、例外を投げて終わる呼び出しは書き込みごとロールバックされる。
--   つまり「失敗したら例外」の関数の中では失敗回数を数えられない
--   （書いても消える）。staff_login は例外を投げず {ok:false} を返すので、
--   失敗記録がコミットされて残る。lookup_reservation も元々 null を返す
--   設計なので同じ理由でそのまま数えられる。
--   既知の限界: アプリの入室フロー（入室・セッション復帰・再確認は全部
--   staffUnlock → staff_login を通る）以外の経路、つまり staff_get_all 等の
--   データ RPC を直接叩く総当たりは、この層では数えられない。ただし
--   ロックが発動すれば全 RPC がその送信元を拒否する。本質的な対策は
--   (1) 推測しにくいパスコードへの変更、(2) Google ログイン確認後に
--   R8 のトグルでパスコードログイン自体を無効化すること（そうすれば
--   パスコード経路は完全に閉じる）。
-- - 予約照会（番号+電話）の列挙: lookup_reservation の「見つからない」も
--   同じ仕組みで数え、上限超過中は常に「見つからない」を返す（失敗と
--   スロットル中を見分けられない形を維持する）。
-- - 予約フラッド: book_seats に「同一電話番号の有効予約 上限」と
--   「全体の作成レート上限」を入れる。どちらも通常の予約エラーと同じ
--   例外コード付きで返し、クライアントは専用の日本語文案を表示する
--   （SEAT_TAKEN の再提案フロー等、成功パスには一切影響しない）。
--
-- 既存 RPC の引数・成功時の応答形は一切変えない。変えるのは
-- sakura_check_passcode / lookup_reservation / book_seats の内部だけ。
-- R8 の認可モデル（JWT 許可リスト OR パスコード）と R7 の QR 受付には
-- 触れない。seat_state の公開範囲も変えない。
--
-- しきい値は sakura_r9_limits() の1か所に集約した（下記参照）。
--
-- クライアント識別（バケット）:
--   PostgREST が渡す request.headers から、cf-connecting-ip →
--   x-forwarded-for の先頭 → 取れなければ 'unknown' の順で決める。
--   取れない環境では全員が 'unknown' バケットを共有する（＝全体制限として
--   働く）。Supabase 本番では x-forwarded-for が届く前提。
--   トレードオフ: NAT 配下では同じ施設・家庭の利用者が1バケットを共有する
--   ため、正規スタッフが攻撃者と同じ IP だと巻き添えで一時的に弾かれる。
--   その場合は Google ログイン（JWT 経路はスロットル対象外）で入れる。
--   逆に分散攻撃（IP を変える）にはバケット単位制限は効きにくいが、
--   book_seats の全体レート上限が最終防衛線になる。
--
-- ロックの仕様（パスコード / 照会 共通）:
--   - 失敗を「窓（15分）」の中で数え、上限（パスコード8回 / 照会10回）に
--     達した時点で、その瞬間から15分間ロックする。
--   - ロック中の試行は失敗として数え直さない（ロックは延長されない）。
--   - 成功したらそのバケットの記録は消える。
--   - 記録は staff_login / lookup_reservation のトランザクション内で行い
--     （どちらも例外で終わらないのでコミットされる）、古い記録は失敗
--     記録時に間引く（cron 不要）。
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 0. R9 のしきい値（ここが唯一の調整点）
-- ---------------------------------------------------------------------------

create or replace function public.sakura_r9_limits()
returns jsonb
language sql
immutable
as $$
  select jsonb_build_object(
    -- パスコード: 15分の窓で8回失敗 → 15分ロック
    'passcode_max_failures', 8,
    -- 予約照会: 15分の窓で10回失敗（見つからない）→ 15分ロック
    'lookup_max_failures', 10,
    -- 失敗を数える窓（分）
    'throttle_window_minutes', 15,
    -- 上限到達後のロック時間（分）
    'throttle_lock_minutes', 15,
    -- 同一電話番号（正規化後）が持てる有効（未キャンセル）な Web 予約の上限
    'phone_max_active_reservations', 3,
    -- 全体: 直近10分に作成された予約がこの数を超えたら新規 Web 予約を拒否
    'global_max_created_per_10min', 30
  );
$$;

-- しきい値は内部専用（RPC として外部から読ませない）
revoke execute on function public.sakura_r9_limits() from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 1. スロットル記録テーブル
-- RLS 有効 + ポリシー無し + 権限剥奪。読み書きは SECURITY DEFINER の
-- 内部ヘルパー経由のみ。個人情報は含まない（IP 文字列とカウンタだけ）。
-- ---------------------------------------------------------------------------

create table if not exists public.auth_throttle (
  scope text not null,
  bucket text not null,
  fail_count int not null default 0,
  window_start timestamptz not null default now(),
  locked_until timestamptz null,
  primary key (scope, bucket)
);

alter table public.auth_throttle enable row level security;
revoke all on table public.auth_throttle from anon, authenticated;

-- ---------------------------------------------------------------------------
-- 2. クライアントバケット（送信元 IP）の取得
-- request.headers GUC の読み取りは防御的に行い、取れなければ 'unknown'。
-- ---------------------------------------------------------------------------

create or replace function public.sakura_client_bucket()
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_headers json;
  v_ip text;
begin
  begin
    v_headers := current_setting('request.headers', true)::json;
  exception when others then
    v_headers := null;
  end;

  if v_headers is not null then
    v_ip := nullif(trim(coalesce(v_headers ->> 'cf-connecting-ip', '')), '');
    if v_ip is null then
      v_ip := nullif(
        trim(split_part(coalesce(v_headers ->> 'x-forwarded-for', ''), ',', 1)),
        ''
      );
    end if;
  end if;

  return coalesce(v_ip, 'unknown');
end;
$$;

revoke execute on function public.sakura_client_bucket() from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 3. スロットル判定・記録（内部ヘルパー。外部からは呼べないよう権限剥奪）
-- ---------------------------------------------------------------------------

-- その scope+bucket がロック中か
create or replace function public.sakura_throttle_locked(p_scope text)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_locked_until timestamptz;
begin
  select locked_until into v_locked_until
    from public.auth_throttle
   where scope = p_scope
     and bucket = public.sakura_client_bucket();
  return v_locked_until is not null and v_locked_until > now();
end;
$$;

revoke execute on function public.sakura_throttle_locked(text) from public, anon, authenticated;

-- 失敗を1回記録する。上限到達でロックを開始する。ロック中は数えない
-- （＝ロックは延長されない）。窓を過ぎた記録はここで間引く。
create or replace function public.sakura_throttle_record_failure(
  p_scope text,
  p_threshold int
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_bucket text := public.sakura_client_bucket();
  v_limits jsonb := public.sakura_r9_limits();
  v_window interval := ((v_limits ->> 'throttle_window_minutes')::int || ' minutes')::interval;
  v_lock_for interval := ((v_limits ->> 'throttle_lock_minutes')::int || ' minutes')::interval;
  v_row public.auth_throttle%rowtype;
begin
  -- 古い記録の間引き（窓を1日過ぎてロックも切れた行は消す。cron 不要）
  delete from public.auth_throttle
   where window_start < now() - interval '1 day'
     and (locked_until is null or locked_until < now());

  insert into public.auth_throttle (scope, bucket, fail_count, window_start, locked_until)
  values (p_scope, v_bucket, 0, now(), null)
  on conflict (scope, bucket) do nothing;

  select * into v_row
    from public.auth_throttle
   where scope = p_scope and bucket = v_bucket
   for update;

  -- ロック中は数えない（ロック延長なし）
  if v_row.locked_until is not null and v_row.locked_until > now() then
    return;
  end if;

  -- 窓を過ぎた、またはロックが切れた記録は数え直す
  if v_row.window_start < now() - v_window
     or (v_row.locked_until is not null and v_row.locked_until <= now()) then
    update public.auth_throttle
       set fail_count = 1,
           window_start = now(),
           locked_until = null
     where scope = p_scope and bucket = v_bucket;
    return;
  end if;

  update public.auth_throttle
     set fail_count = v_row.fail_count + 1,
         locked_until = case
           when v_row.fail_count + 1 >= p_threshold then now() + v_lock_for
           else locked_until
         end
   where scope = p_scope and bucket = v_bucket;
end;
$$;

revoke execute on function public.sakura_throttle_record_failure(text, int)
  from public, anon, authenticated;

-- 成功したらそのバケットの記録を消す
create or replace function public.sakura_throttle_record_success(p_scope text)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  delete from public.auth_throttle
   where scope = p_scope
     and bucket = public.sakura_client_bucket();
end;
$$;

revoke execute on function public.sakura_throttle_record_success(text)
  from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 4. staff_login: パスコードログイン専用 RPC（R9 で新設。失敗を数える場所）
-- - 認証の成否を例外ではなく { ok: true/false } で返す（だから失敗記録が
--   コミットされて残る。ヘッダーの「なぜログイン専用 RPC で数えるのか」参照）
-- - 失敗の形は常に { ok:false } で、パスコード間違いとロック中を
--   見分けられない
-- - JWT 許可リスト経路は成功扱い（スロットル対象外）
-- - クライアントは入室時にまずこれを呼び、ok のときだけ従来どおり
--   staff_get_all 等を使う。R9 未適用の DB ではこの RPC 自体が無いため、
--   クライアントは呼び出し失敗時に従来フローへフォールバックする
-- ---------------------------------------------------------------------------

create or replace function public.staff_login(p_passcode text)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_hash text;
  v_pass_enabled boolean;
  v_limits jsonb := public.sakura_r9_limits();
begin
  -- (a) Googleログイン: JWT の email が許可リストにあれば成功
  if public.sakura_is_allowlisted() then
    perform public.sakura_throttle_record_success('passcode');
    return jsonb_build_object('ok', true);
  end if;

  -- (b) パスコードログインが無効化されていたら失敗（数えない）
  select passcode_login_enabled into v_pass_enabled
    from public.app_config where id = 1;
  if not coalesce(v_pass_enabled, true) then
    return jsonb_build_object('ok', false);
  end if;

  -- ロック中は正しいパスコードでも失敗（通常の失敗と同じ {ok:false}）
  if public.sakura_throttle_locked('passcode') then
    return jsonb_build_object('ok', false);
  end if;

  select passcode_hash into v_hash from public.staff_auth where id = 1;
  if v_hash is not null
     and v_hash = encode(digest(coalesce(p_passcode, ''), 'sha256'), 'hex') then
    perform public.sakura_throttle_record_success('passcode');
    return jsonb_build_object('ok', true);
  end if;

  perform public.sakura_throttle_record_failure(
    'passcode',
    (v_limits ->> 'passcode_max_failures')::int
  );
  return jsonb_build_object('ok', false);
end;
$$;

grant execute on function public.staff_login(text) to anon, authenticated;

-- ---------------------------------------------------------------------------
-- 4b. sakura_check_passcode: R8 の認可にロックゲートだけを追加
-- - staff_login が記録したロックを、ここで全スタッフ RPC に効かせる
--   （読み取りだけなので、例外で終わる呼び出しでも問題ない）
-- - ここでは失敗を数えない（数えるのは staff_login と lookup_reservation。
--   理由はヘッダー参照）
-- - JWT 許可リスト経路は従来どおりスロットル対象外
-- ---------------------------------------------------------------------------

create or replace function public.sakura_check_passcode(p_passcode text)
returns void
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_hash text;
  v_pass_enabled boolean;
begin
  -- (a) Googleログイン: JWT の email が許可リストにあれば認可
  if public.sakura_is_allowlisted() then
    return;
  end if;

  -- (b) パスコード: 有効な間だけ従来照合（移行期間のフォールバック）
  select passcode_login_enabled into v_pass_enabled
    from public.app_config where id = 1;
  if coalesce(v_pass_enabled, true) then
    -- R9: ロック中は照合自体をせず、通常の失敗と同じ形で拒否する
    if public.sakura_throttle_locked('passcode') then
      raise exception 'UNAUTHORIZED: パスコードが違います';
    end if;

    select passcode_hash into v_hash from public.staff_auth where id = 1;
    if v_hash is not null
       and v_hash = encode(digest(coalesce(p_passcode, ''), 'sha256'), 'hex') then
      return;
    end if;
  end if;

  raise exception 'UNAUTHORIZED: パスコードが違います';
end;
$$;

-- ---------------------------------------------------------------------------
-- 5. lookup_reservation: R7 の本体に照会スロットルを追加
-- - ロック中は常に null（＝見つからない）を返す。通常の失敗と見分け不能
-- - 見つからなかった場合だけ失敗として数える。見つかれば記録を消す
-- - 照合方法（code と phone の完全一致）は従来どおり変えない
-- ---------------------------------------------------------------------------

create or replace function public.lookup_reservation(p_code text, p_phone text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row public.reservations%rowtype;
  v_perf jsonb;
  v_limits jsonb := public.sakura_r9_limits();
begin
  -- R9: ロック中は照会自体を行わず「見つからない」を返す
  if public.sakura_throttle_locked('lookup') then
    return null;
  end if;

  select * into v_row
    from public.reservations
   where code = p_code and phone = p_phone
   limit 1;
  if not found then
    perform public.sakura_throttle_record_failure(
      'lookup',
      (v_limits ->> 'lookup_max_failures')::int
    );
    return null;
  end if;

  perform public.sakura_throttle_record_success('lookup');

  select performance into v_perf from public.app_config where id = 1;

  return jsonb_build_object(
    'id', v_row.id,
    'code', v_row.code,
    'name', v_row.name,
    'phone', v_row.phone,
    'note', v_row.note,
    'items', v_row.items,
    'amount', v_row.amount,
    'kind', v_row.kind,
    'paid', v_row.paid,
    'checkedIn', v_row.checked_in,
    'status', v_row.status,
    'createdAt', v_row.created_at,
    'qrToken', v_row.qr_token,
    'checkedInAt', v_row.checked_in_at,
    'perfDate', v_row.perf_date,
    'perfName', v_row.perf_name,
    'performance', v_perf
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- 6. book_seats: R7 の本体に予約フラッド防止を追加
-- 追加するのは検証2点のみ（料金再計算・行ロック・採番・トークン発行・
-- 公演スナップショットは R7 と同一）:
--   (1) 全体レート: 直近10分の作成数が上限超 → TOO_BUSY
--   (2) 電話上限: 同一電話（正規化後）の有効な Web 予約が上限 → PHONE_LIMIT
--   どちらも app_config 行ロック取得後・料金計算前に判定する
--   （埋まった席への申込で上限に触れる前に弾く。SEAT_TAKEN の再提案に
--   進むのは「上限に触れていない通常の競合」のときだけになる）。
-- 当日販売（staff_sell）はスタッフ認証済み操作なので対象にしない。
-- カウント側（全体レート）は staff_sell の作成分も含める
-- （作成行為そのものの流量を見るため）。
-- ---------------------------------------------------------------------------

create or replace function public.book_seats(
  p_name text,
  p_phone text,
  p_note text,
  p_items jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_priced jsonb;
  v_code text;
  v_token text;
  v_perf jsonb;
  v_item jsonb;
  v_attempt int := 0;
  v_lock int;
  v_limits jsonb := public.sakura_r9_limits();
  v_recent_count int;
  v_phone_count int;
  v_phone_norm text;
begin
  select 1 into v_lock from public.app_config where id = 1 for update;

  if coalesce(trim(p_name), '') = '' then
    raise exception 'NAME_REQUIRED: お名前を入力してください';
  end if;
  if coalesce(trim(p_phone), '') = '' then
    raise exception 'PHONE_REQUIRED: 電話番号を入力してください';
  end if;
  if jsonb_typeof(p_items) = 'array' and jsonb_array_length(p_items) > 8 then
    raise exception 'TOO_MANY_SEATS: 一度に申し込めるのは8席までです';
  end if;

  -- 公演スナップショットは R9 の電話上限の照合にも使うため先に取る
  -- （従来は料金計算の後で取っていた。値は同じ行・同じトランザクション）
  select performance into v_perf from public.app_config where id = 1;

  -- R9 (1): 全体レート上限（直近10分の作成数）
  select count(*) into v_recent_count
    from public.reservations
   where created_at > now() - interval '10 minutes';
  if v_recent_count > (v_limits ->> 'global_max_created_per_10min')::int then
    raise exception 'TOO_BUSY: ただいま混み合っています。少し時間をおいてお試しください';
  end if;

  -- R9 (2): 同一電話番号の有効予約上限（電話は正規化して照合する。
  -- 数字に直らない入力は対象外。当日販売（phone 空）は数えない）
  v_phone_norm := public.sakura_normalize_phone(p_phone);
  if v_phone_norm <> '' then
    select count(*) into v_phone_count
      from public.reservations
     where kind = 'online'
       and status = 'active'
       and public.sakura_normalize_phone(phone) = v_phone_norm
       and (
         perf_date is null
         or (
           perf_date is not distinct from (v_perf ->> 'date')
           and perf_name is not distinct from (v_perf ->> 'name')
         )
       );
    if v_phone_count >= (v_limits ->> 'phone_max_active_reservations')::int then
      raise exception 'PHONE_LIMIT: この電話番号でのご予約が上限に達しています';
    end if;
  end if;

  v_priced := public.sakura_price_items(p_items, true);

  loop
    v_attempt := v_attempt + 1;
    v_code := public.sakura_next_code();
    v_token := public.sakura_new_qr_token();
    begin
      insert into public.reservations
        (code, name, phone, note, items, amount, kind, paid, qr_token, perf_date, perf_name)
      values (
        v_code,
        trim(p_name),
        trim(p_phone),
        coalesce(p_note, ''),
        v_priced -> 'items',
        (v_priced ->> 'amount')::int,
        'online',
        false,
        v_token,
        v_perf ->> 'date',
        v_perf ->> 'name'
      );
      exit;
    exception when unique_violation then
      if v_attempt >= 5 then raise; end if;
    end;
  end loop;

  for v_item in select * from jsonb_array_elements(v_priced -> 'items') loop
    insert into public.seat_state (seat_id, state)
    values (v_item ->> 'seatId', 'reserved');
  end loop;

  return jsonb_build_object(
    'code', v_code,
    'amount', (v_priced ->> 'amount')::int,
    'token', v_token
  );
end;
$$;

-- 実行権限は従来どおり（公開 RPC のみ anon / authenticated に開く）
grant execute on function public.lookup_reservation(text, text) to anon, authenticated;
grant execute on function public.book_seats(text, text, text, jsonb) to anon, authenticated;
