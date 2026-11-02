-- ============================================================================
-- sakura-seats 追加マイグレーション (R8): スタッフ認証を Google ログインへ
-- Supabase ダッシュボードの SQL Editor でそのまま実行できる冪等なスクリプト。
-- 前提: migration_sakura.sql / _r4 / _r6 / _r7 が適用済みであること。
--
-- 設計:
-- - スタッフ認証の正は Supabase Auth（Google）の JWT とし、メールアドレスの
--   許可リスト（staff_allowlist）で入室可否を決める。
-- - 既存の全スタッフ RPC は sakura_check_passcode(p_passcode) を呼ぶため、
--   このヘルパーを差し替えるだけで全 RPC が新認証に対応する（引数は不変）:
--     (a) 呼び出し元の JWT の email が staff_allowlist にあれば認可
--     (b) それ以外は、app_config.passcode_login_enabled が true の間だけ
--         従来のパスコード照合で認可（移行期間のフォールバック）
--   どちらでもなければ従来どおり UNAUTHORIZED 例外。
-- - パスコードログインの無効化（フラグ変更）は、認証経路そのものを変える
--   操作なので、Google（JWT）で認可されたスタッフのみに制限する
--   （staff_set_passcode_login）。パスコードしか持たない第三者が
--   パスコード経路を勝手に開閉することはできない。
--   トレードオフ: 許可リストの追加・削除は「スタッフ認証済みなら可」とした
--   （パスコード入室でも可）。これは移行期間の運用（オーナーがパスコードで
--   入ってスタッフを登録する）を優先したためで、パスコードログインを
--   無効化した後は実質 Google スタッフのみが変更できる。
-- - staff_allowlist は RLS 有効 + ポリシー無し + 権限剥奪で、RPC 経由以外
--   一切読み書きできない（メールアドレス自体も個人情報として扱う）。
--
-- ダッシュボード側の前提（この SQL の外で必要な設定）:
-- - Authentication → Providers → Google を有効化し、Google Cloud で発行した
--   OAuth クライアント（Web）の Client ID / Secret を登録する。
--   Google Cloud 側の承認済みリダイレクト URI は
--   https://<project-ref>.supabase.co/auth/v1/callback
-- - Authentication → URL Configuration の Redirect URLs に、アプリの URL
--   （GitHub Pages / Cloudflare Pages の双方）を登録する。
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. スタッフ許可リスト
-- ---------------------------------------------------------------------------

create table if not exists public.staff_allowlist (
  email text primary key,
  note text not null default '',
  created_at timestamptz not null default now()
);

alter table public.staff_allowlist enable row level security;
-- ポリシーは作らない（RPC 経由でのみアクセス）。念のため直接権限も剥奪する
revoke all on table public.staff_allowlist from anon, authenticated;

-- オーナーを初期登録（既にあれば何もしない）
insert into public.staff_allowlist (email, note)
values ('yuuki20170731@gmail.com', 'オーナー')
on conflict (email) do nothing;

-- ---------------------------------------------------------------------------
-- 2. パスコードログインの有効フラグ（移行期間のフォールバック制御）
-- ---------------------------------------------------------------------------

alter table public.app_config
  add column if not exists passcode_login_enabled boolean not null default true;

-- ---------------------------------------------------------------------------
-- 3. JWT ヘルパー
-- 未ログイン（anon）の呼び出しでは auth.jwt() に email が無い、または
-- 実行文脈によっては例外になり得るため、例外を握って null を返す。
-- ---------------------------------------------------------------------------

create or replace function public.sakura_jwt_email()
returns text
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_email text;
begin
  begin
    v_email := nullif(lower(coalesce(auth.jwt() ->> 'email', '')), '');
  exception when others then
    v_email := null;
  end;
  return v_email;
end;
$$;

create or replace function public.sakura_is_allowlisted()
returns boolean
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_email text := public.sakura_jwt_email();
begin
  if v_email is null then
    return false;
  end if;
  return exists (select 1 from public.staff_allowlist where email = v_email);
end;
$$;

-- ---------------------------------------------------------------------------
-- 4. 認可ヘルパーの差し替え（全スタッフ RPC が呼ぶ唯一の認可点）
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
-- 5. 許可リストの応答整形（内部用）
-- ---------------------------------------------------------------------------

create or replace function public.sakura_allowlist_payload()
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_enabled boolean;
  v_entries jsonb;
begin
  select passcode_login_enabled into v_enabled from public.app_config where id = 1;
  select coalesce(
           jsonb_agg(
             jsonb_build_object(
               'email', email,
               'note', note,
               'createdAt', created_at
             )
             order by created_at
           ),
           '[]'::jsonb
         )
    into v_entries
    from public.staff_allowlist;
  return jsonb_build_object(
    'passcodeLoginEnabled', coalesce(v_enabled, true),
    'entries', coalesce(v_entries, '[]'::jsonb)
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- 6. 公開 RPC
-- ---------------------------------------------------------------------------

-- ログイン中ユーザーがスタッフかどうか（JWT のみで判定。未ログインでも
-- 例外にせず { ok:false, email:null } を返す。email は呼び出し元自身のもの）
create or replace function public.staff_whoami()
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_email text := public.sakura_jwt_email();
begin
  return jsonb_build_object(
    'ok',
    v_email is not null
      and exists (select 1 from public.staff_allowlist where email = v_email),
    'email', v_email
  );
end;
$$;

-- 許可リスト一覧（要スタッフ認証: Google またはパスコード）
create or replace function public.staff_allowlist_list(p_passcode text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
begin
  perform public.sakura_check_passcode(p_passcode);
  return public.sakura_allowlist_payload();
end;
$$;

-- 許可リストへ追加（既存メールはメモを更新。要スタッフ認証）
create or replace function public.staff_allowlist_add(
  p_passcode text,
  p_email text,
  p_note text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_email text := lower(trim(coalesce(p_email, '')));
  v_lock int;
begin
  perform public.sakura_check_passcode(p_passcode);
  select 1 into v_lock from public.app_config where id = 1 for update;

  if v_email = '' or v_email !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then
    raise exception 'INVALID_EMAIL: メールアドレスの形式が正しくありません';
  end if;

  insert into public.staff_allowlist (email, note)
  values (v_email, coalesce(p_note, ''))
  on conflict (email) do update set note = excluded.note;

  return public.sakura_allowlist_payload();
end;
$$;

-- 許可リストから削除（最後の1人は削除できない。要スタッフ認証）
create or replace function public.staff_allowlist_remove(
  p_passcode text,
  p_email text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_email text := lower(trim(coalesce(p_email, '')));
  v_lock int;
  v_count int;
begin
  perform public.sakura_check_passcode(p_passcode);
  select 1 into v_lock from public.app_config where id = 1 for update;

  select count(*) into v_count from public.staff_allowlist;
  if v_count <= 1 and exists (
    select 1 from public.staff_allowlist where email = v_email
  ) then
    raise exception 'LAST_STAFF: 最後のスタッフは削除できません';
  end if;

  delete from public.staff_allowlist where email = v_email;

  return public.sakura_allowlist_payload();
end;
$$;

-- パスコードログインの有効/無効（Google 許可スタッフのみ。
-- p_passcode は他 RPC との署名統一のために受けるが判定には使わない）
create or replace function public.staff_set_passcode_login(
  p_passcode text,
  p_enabled boolean
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.sakura_is_allowlisted() then
    raise exception 'JWT_REQUIRED: この操作はGoogleログインしたスタッフのみ行えます';
  end if;

  update public.app_config
     set passcode_login_enabled = coalesce(p_enabled, true),
         updated_at = now()
   where id = 1;

  return public.sakura_allowlist_payload();
end;
$$;

-- ---------------------------------------------------------------------------
-- RPC の実行権限（anon = 未ログインの呼び出し口 / authenticated = ログイン済み）
-- 実の認可は各関数内の sakura_check_passcode / JWT 判定で行う。
-- ---------------------------------------------------------------------------

grant execute on function public.staff_whoami() to anon, authenticated;
grant execute on function public.staff_allowlist_list(text) to anon, authenticated;
grant execute on function public.staff_allowlist_add(text, text, text) to anon, authenticated;
grant execute on function public.staff_allowlist_remove(text, text) to anon, authenticated;
grant execute on function public.staff_set_passcode_login(text, boolean) to anon, authenticated;
