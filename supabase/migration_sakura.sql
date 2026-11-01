-- ============================================================================
-- sakura-seats Phase 2: クラウド同期マイグレーション
-- Supabase ダッシュボードの SQL Editor でそのまま実行できる冪等なスクリプト。
-- 何度実行しても安全（create if not exists / on conflict do nothing 等）。
--
-- 設計:
--   - 個人情報を含むテーブルは RLS 有効 + anon ポリシー無し（RPC 経由でのみアクセス）
--   - seat_state は座席の占有状態のみ（個人情報なし）→ anon SELECT 可 + Realtime 配信
--   - 全ての書き込みは SECURITY DEFINER の RPC 経由。料金はサーバ側で再計算する。
--   - スタッフ操作はパスコード（sha256 ハッシュで照合）で認証する。
-- ============================================================================

create extension if not exists pgcrypto;

-- ---------------------------------------------------------------------------
-- テーブル
-- ---------------------------------------------------------------------------

create table if not exists public.app_config (
  id int primary key check (id = 1),
  performance jsonb not null,
  blocked_seats jsonb not null default '[]'::jsonb,
  booking_deadline timestamptz null,
  updated_at timestamptz not null default now()
);

create table if not exists public.reservations (
  id uuid primary key default gen_random_uuid(),
  code text unique not null,
  name text not null,
  phone text not null,
  note text not null default '',
  items jsonb not null,
  amount int not null,
  kind text not null check (kind in ('online', 'door')),
  paid boolean not null default false,
  checked_in boolean not null default false,
  status text not null default 'active' check (status in ('active', 'cancelled')),
  created_at timestamptz not null default now()
);

create table if not exists public.seat_state (
  seat_id text primary key,
  state text not null check (state in ('reserved', 'sold')),
  updated_at timestamptz not null default now()
);

create table if not exists public.staff_auth (
  id int primary key check (id = 1),
  passcode_hash text not null
);

-- ---------------------------------------------------------------------------
-- 初期データ（既にあれば何もしない）
-- performance はクライアントの defaultPerformance() と同じ内容。
-- ---------------------------------------------------------------------------

insert into public.app_config (id, performance, blocked_seats)
values (
  1,
  '{
    "name": "サンプル公演",
    "date": "2026-12-19",
    "time": "13:00",
    "ticketTypes": [
      {"id": "adult", "name": "大人", "price": 2000},
      {"id": "child", "name": "子供", "price": 1000}
    ],
    "priceNote": "子供料金は小学生以下が対象です。",
    "note": "試作用のサンプル公演です。スタッフ用画面の「公演設定」から公演名・日時・券種・料金を変更できます。"
  }'::jsonb,
  '[]'::jsonb
)
on conflict (id) do nothing;

-- スタッフパスコード初期値 '1234' の sha256
insert into public.staff_auth (id, passcode_hash)
values (1, encode(digest('1234', 'sha256'), 'hex'))
on conflict (id) do nothing;

-- ---------------------------------------------------------------------------
-- RLS
-- ---------------------------------------------------------------------------

alter table public.app_config enable row level security;
alter table public.reservations enable row level security;
alter table public.seat_state enable row level security;
alter table public.staff_auth enable row level security;

-- seat_state のみ anon の SELECT を許可（占有状態だけ・個人情報なし）
drop policy if exists seat_state_anon_select on public.seat_state;
create policy seat_state_anon_select on public.seat_state
  for select to anon using (true);

grant select on public.seat_state to anon;

-- Realtime: seat_state を publication に追加（冪等）
do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'seat_state'
  ) then
    alter publication supabase_realtime add table public.seat_state;
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- 内部ヘルパー
-- ---------------------------------------------------------------------------

-- パスコード照合。スタッフでなければ例外。
create or replace function public.sakura_check_passcode(p_passcode text)
returns void
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_hash text;
begin
  select passcode_hash into v_hash from public.staff_auth where id = 1;
  if v_hash is null or v_hash <> encode(digest(coalesce(p_passcode, ''), 'sha256'), 'hex') then
    raise exception 'UNAUTHORIZED: パスコードが違います';
  end if;
end;
$$;

-- 予約番号 SK-XXXX の新規採番（呼び出し側が app_config 行をロック済みの前提）
create or replace function public.sakura_next_code()
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_n int;
begin
  select coalesce(max((substring(code from 4))::int), 0) + 1
    into v_n
    from public.reservations
   where code ~ '^SK-[0-9]+$';
  return 'SK-' || lpad(v_n::text, 4, '0');
end;
$$;

-- items（[{seatId, typeId}]）を検証し、公演設定の券種で料金を再計算した
-- スナップショット明細と合計金額を返す。問題があれば例外を投げる。
-- p_check_deadline: オンライン予約のときだけ締切をチェックする。
create or replace function public.sakura_price_items(
  p_items jsonb,
  p_check_deadline boolean
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_perf jsonb;
  v_blocked jsonb;
  v_deadline timestamptz;
  v_item jsonb;
  v_type jsonb;
  v_seat text;
  v_state text;
  v_out jsonb := '[]'::jsonb;
  v_total int := 0;
  v_seen text[] := '{}';
begin
  select performance, blocked_seats, booking_deadline
    into v_perf, v_blocked, v_deadline
    from public.app_config where id = 1;
  if v_perf is null then
    raise exception 'NOT_CONFIGURED: 公演設定がありません';
  end if;

  if p_check_deadline and v_deadline is not null and now() > v_deadline then
    raise exception 'BOOKING_CLOSED: 予約受付は終了しました';
  end if;

  if p_items is null or jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) = 0 then
    raise exception 'NO_SEATS: 座席が選択されていません';
  end if;

  for v_item in select * from jsonb_array_elements(p_items) loop
    v_seat := v_item ->> 'seatId';
    if v_seat is null or v_seat = '' then
      raise exception 'INVALID_ITEM: 座席指定が不正です';
    end if;
    if v_seat = any (v_seen) then
      raise exception 'DUPLICATE_SEAT: 同じ座席が重複しています';
    end if;
    v_seen := v_seen || v_seat;

    if v_blocked @> to_jsonb(v_seat) then
      raise exception 'SEAT_BLOCKED: 販売していない席が含まれています';
    end if;

    select state into v_state from public.seat_state where seat_id = v_seat;
    if v_state is not null then
      raise exception 'SEAT_TAKEN: 選択された座席の一部がすでに予約・販売済みです';
    end if;

    select t into v_type
      from jsonb_array_elements(v_perf -> 'ticketTypes') as t
     where t ->> 'id' = (v_item ->> 'typeId');
    if v_type is null then
      raise exception 'INVALID_TYPE: 券種が見つかりません';
    end if;

    v_out := v_out || jsonb_build_object(
      'seatId', v_seat,
      'typeId', v_type ->> 'id',
      'typeName', v_type ->> 'name',
      'price', (v_type ->> 'price')::int
    );
    v_total := v_total + (v_type ->> 'price')::int;
  end loop;

  return jsonb_build_object('items', v_out, 'amount', v_total);
end;
$$;

-- ---------------------------------------------------------------------------
-- 公開 RPC（お客様向け）
-- ---------------------------------------------------------------------------

-- お客様画面の初期表示・購読リフレッシュ用。個人情報は含まない。
create or replace function public.get_public_state()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_perf jsonb;
  v_blocked jsonb;
  v_deadline timestamptz;
  v_seats jsonb;
begin
  select performance, blocked_seats, booking_deadline
    into v_perf, v_blocked, v_deadline
    from public.app_config where id = 1;

  select coalesce(jsonb_agg(jsonb_build_object('seatId', seat_id, 'state', state)), '[]'::jsonb)
    into v_seats
    from public.seat_state;

  return jsonb_build_object(
    'performance', v_perf,
    'blockedSeats', coalesce(v_blocked, '[]'::jsonb),
    'bookingDeadline', v_deadline,
    'seats', v_seats
  );
end;
$$;

-- オンライン予約。app_config 行の FOR UPDATE ロックで二重予約レースを防ぐ。
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
  v_item jsonb;
  v_attempt int := 0;
  v_lock int;
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

  v_priced := public.sakura_price_items(p_items, true);

  -- 予約番号の採番（ユニーク衝突時はリトライ）
  loop
    v_attempt := v_attempt + 1;
    v_code := public.sakura_next_code();
    begin
      insert into public.reservations (code, name, phone, note, items, amount, kind, paid)
      values (
        v_code,
        trim(p_name),
        trim(p_phone),
        coalesce(p_note, ''),
        v_priced -> 'items',
        (v_priced ->> 'amount')::int,
        'online',
        false
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

  return jsonb_build_object('code', v_code, 'amount', (v_priced ->> 'amount')::int);
end;
$$;

-- 予約確認。予約番号と電話番号が完全一致したときだけ本人の予約を返す。
create or replace function public.lookup_reservation(p_code text, p_phone text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row public.reservations%rowtype;
  v_perf jsonb;
begin
  select * into v_row
    from public.reservations
   where code = p_code and phone = p_phone
   limit 1;
  if not found then
    return null;
  end if;

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
    'performance', v_perf
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- スタッフ RPC（パスコード必須）
-- ---------------------------------------------------------------------------

-- スタッフログイン兼・全データ取得。
create or replace function public.staff_get_all(p_passcode text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_perf jsonb;
  v_blocked jsonb;
  v_deadline timestamptz;
  v_res jsonb;
begin
  perform public.sakura_check_passcode(p_passcode);

  select performance, blocked_seats, booking_deadline
    into v_perf, v_blocked, v_deadline
    from public.app_config where id = 1;

  select coalesce(jsonb_agg(s.row order by s.created_at), '[]'::jsonb)
    into v_res
    from (
      select jsonb_build_object(
        'id', id,
        'code', code,
        'name', name,
        'phone', phone,
        'note', note,
        'items', items,
        'amount', amount,
        'kind', kind,
        'paid', paid,
        'checkedIn', checked_in,
        'status', status,
        'createdAt', created_at
      ) as row, created_at
      from public.reservations
    ) s;

  return jsonb_build_object(
    'config', jsonb_build_object(
      'performance', v_perf,
      'blockedSeats', coalesce(v_blocked, '[]'::jsonb),
      'bookingDeadline', v_deadline
    ),
    'reservations', v_res
  );
end;
$$;

-- 当日販売。締切の影響を受けない。支払済・販売済として記録する。
create or replace function public.staff_sell(
  p_passcode text,
  p_name text,
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
  v_item jsonb;
  v_attempt int := 0;
  v_lock int;
begin
  perform public.sakura_check_passcode(p_passcode);
  select 1 into v_lock from public.app_config where id = 1 for update;

  v_priced := public.sakura_price_items(p_items, false);

  loop
    v_attempt := v_attempt + 1;
    v_code := public.sakura_next_code();
    begin
      insert into public.reservations (code, name, phone, note, items, amount, kind, paid)
      values (
        v_code,
        coalesce(nullif(trim(p_name), ''), '当日'),
        '',
        '',
        v_priced -> 'items',
        (v_priced ->> 'amount')::int,
        'door',
        true
      );
      exit;
    exception when unique_violation then
      if v_attempt >= 5 then raise; end if;
    end;
  end loop;

  for v_item in select * from jsonb_array_elements(v_priced -> 'items') loop
    insert into public.seat_state (seat_id, state)
    values (v_item ->> 'seatId', 'sold');
  end loop;

  return jsonb_build_object('code', v_code, 'amount', (v_priced ->> 'amount')::int);
end;
$$;

-- 予約の支払い・来場・ステータス変更。キャンセル時は席を解放する。
create or replace function public.staff_update_reservation(
  p_passcode text,
  p_id uuid,
  p_paid boolean,
  p_checked_in boolean,
  p_status text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_items jsonb;
  v_item jsonb;
begin
  perform public.sakura_check_passcode(p_passcode);

  if p_status not in ('active', 'cancelled') then
    raise exception 'INVALID_STATUS: ステータスが不正です';
  end if;

  select items into v_items from public.reservations where id = p_id;
  if not found then
    raise exception 'NOT_FOUND: 予約が見つかりません';
  end if;

  update public.reservations
     set paid = p_paid,
         checked_in = p_checked_in,
         status = p_status
   where id = p_id;

  if p_status = 'cancelled' then
    for v_item in select * from jsonb_array_elements(v_items) loop
      delete from public.seat_state where seat_id = (v_item ->> 'seatId');
    end loop;
  end if;

  return jsonb_build_object('ok', true);
end;
$$;

-- 公演設定・販売しない席・予約締切の保存。
-- 既に予約・販売されている席を「販売しない」に含めることはできない。
create or replace function public.staff_save_config(
  p_passcode text,
  p_performance jsonb,
  p_blocked_seats jsonb,
  p_booking_deadline timestamptz
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_conflict text;
  v_lock int;
begin
  perform public.sakura_check_passcode(p_passcode);
  select 1 into v_lock from public.app_config where id = 1 for update;

  select seat_id into v_conflict
    from public.seat_state
   where to_jsonb(seat_id) <@ coalesce(p_blocked_seats, '[]'::jsonb)
   limit 1;
  if v_conflict is not null then
    raise exception 'BLOCKED_CONFLICT: 予約・販売済みの席は販売しない設定にできません';
  end if;

  update public.app_config
     set performance = p_performance,
         blocked_seats = coalesce(p_blocked_seats, '[]'::jsonb),
         booking_deadline = p_booking_deadline,
         updated_at = now()
   where id = 1;

  return jsonb_build_object('ok', true);
end;
$$;

-- パスコード変更。
create or replace function public.staff_change_passcode(
  p_passcode text,
  p_new_passcode text
)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
begin
  perform public.sakura_check_passcode(p_passcode);
  if coalesce(trim(p_new_passcode), '') = '' then
    raise exception 'INVALID_PASSCODE: 新しいパスコードを入力してください';
  end if;
  update public.staff_auth
     set passcode_hash = encode(digest(p_new_passcode, 'sha256'), 'hex')
   where id = 1;
  return jsonb_build_object('ok', true);
end;
$$;

-- ---------------------------------------------------------------------------
-- RPC の実行権限（anon）
-- ---------------------------------------------------------------------------

grant execute on function public.get_public_state() to anon;
grant execute on function public.book_seats(text, text, text, jsonb) to anon;
grant execute on function public.lookup_reservation(text, text) to anon;
grant execute on function public.staff_get_all(text) to anon;
grant execute on function public.staff_sell(text, text, jsonb) to anon;
grant execute on function public.staff_update_reservation(text, uuid, boolean, boolean, text) to anon;
grant execute on function public.staff_save_config(text, jsonb, jsonb, timestamptz) to anon;
grant execute on function public.staff_change_passcode(text, text) to anon;
