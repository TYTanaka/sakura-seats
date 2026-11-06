-- ============================================================================
-- sakura-seats 追加マイグレーション (R38): 第3ラウンド評価の修正＋追加機能
-- Supabase ダッシュボードの SQL Editor でそのまま実行できる冪等なスクリプト。
-- 前提: migration_sakura.sql / _r4 / _r6 / _r7 / _r8 / _r9 / _r12 / _r15 /
--       _r17 / _r21 / _r25 が適用済み。
--
-- 目的（第3ラウンド評価 2026-11-06 の指摘）:
-- H1: 車椅子席・親子室は申込時に「希望」として受け付け、受付時の割当で
--     専用席を割り当てられるようにする（従来は備考欄の自由記述のみで、
--     割当の仕組みと結びついていなかった）。
-- M1: キャンセル取り消し（復活）で、未割当ゾーン予約のホールドがゾーンの
--     定員を超える場合は 'ZONE_FULL' を返して拒否する（オーバーセル防止）。
-- M3: 返金済みを予約ごとに記録する（公演中止時の返金チェックリスト用）。
-- 追加: キャンセル待ち登録（add_waitlist / staff_remove_waitlist）。
-- 追加: 受付・支払い確定の担当者記録（checked_in_by / paid_by）。
--
-- 変更内容:
-- 1. reservations に access_needs（希望）/ refunded / refunded_at /
--    checked_in_by / paid_by 列を追加（既存行は既定値＝希望なし・未返金）。
-- 2. seat_special テーブル（専用席→種別）と検証ヘルパ sakura_seat_allowed。
--    席の割当検証（staff_check_in / staff_assign_and_pay / staff_assign_seats）
--    は「ゾーン内の席」または「希望した種別の専用席」を許可するようになる。
-- 3. book_zone に p_access_needs を追加（旧5引数は drop して作り直し）。
-- 4. waitlist テーブル＋ add_waitlist / staff_remove_waitlist。
-- 5. staff_get_all / lookup_reservation に新フィールドを含める。
-- 6. staff_check_in / staff_assign_and_pay に p_operator（担当者）を追加
--    （旧シグネチャは drop して作り直し。クライアントは旧 DB では
--    従来引数へ自動で落とす）。
-- 7. staff_update_reservation に p_refunded / p_operator を追加。
-- 8. staff_uncancel_reservation に ZONE_FULL 判定を追加。
--
-- 既存データへの影響: 列追加と関数の作り直しのみ。既存予約の値は変えない。
-- ============================================================================

-- ------------------------------------------------------------
-- 1. reservations の列追加（希望・返金・担当者）
-- ------------------------------------------------------------
alter table public.reservations
  add column if not exists access_needs text[] not null default '{}';
alter table public.reservations
  add column if not exists refunded boolean not null default false;
alter table public.reservations
  add column if not exists refunded_at timestamptz;
alter table public.reservations
  add column if not exists checked_in_by text;
alter table public.reservations
  add column if not exists paid_by text;

-- ------------------------------------------------------------
-- 2. seat_special: 専用席（車椅子席・親子室）→種別の静的対応表
--    アプリ側 src/data/seats.ts / src/lib/zones.ts と同一内容。
--    seat_zone と同じ扱い: RLS 有効・直接権限なし（DEFINER 関数経由のみ）。
-- ------------------------------------------------------------
create table if not exists public.seat_special (
  seat_id text primary key,
  kind text not null
);

alter table public.seat_special enable row level security;
revoke all on table public.seat_special from anon, authenticated;

insert into public.seat_special (seat_id, kind) values
  ('WC-L', 'wheelchair'),
  ('WC-R', 'wheelchair'),
  ('OYAKO-1', 'parentRoom'),
  ('OYAKO-2', 'parentRoom'),
  ('OYAKO-3', 'parentRoom'),
  ('OYAKO-4', 'parentRoom'),
  ('OYAKO-5', 'parentRoom'),
  ('OYAKO-6', 'parentRoom')
on conflict (seat_id) do nothing;

-- 席がその予約に割り当て可能か: ゾーン内の席、または希望した種別の専用席
create or replace function public.sakura_seat_allowed(
  p_seat_id text,
  p_zone text,
  p_access_needs text[]
)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select
    exists (
      select 1 from public.seat_zone sz
       where sz.seat_id = p_seat_id and sz.zone = p_zone
    )
    or exists (
      select 1 from public.seat_special sp
       where sp.seat_id = p_seat_id
         and sp.kind = any (coalesce(p_access_needs, '{}'::text[]))
    );
$$;

revoke execute on function public.sakura_seat_allowed(text, text, text[])
  from public, anon, authenticated;

-- ------------------------------------------------------------
-- 3. book_zone（R38）: 希望（p_access_needs）を受け付けて保存する。
--    それ以外は R12 版と同一（締切・料金再計算・R9 スロットル・
--    カウントホールド）。旧5引数シグネチャは drop して作り直す。
-- ------------------------------------------------------------
drop function if exists public.book_zone(text, text, text, text, jsonb);

create or replace function public.book_zone(
  p_name text,
  p_phone text,
  p_note text,
  p_zone text,
  p_type_ids jsonb,
  p_access_needs text[] default '{}'
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
  v_attempt int := 0;
  v_lock int;
  v_limits jsonb := public.sakura_r9_limits();
  v_recent_count int;
  v_phone_count int;
  v_phone_norm text;
  v_party int;
  v_physical int;
  v_blocked int;
  v_taken int;
  v_holds int;
  v_blocked_arr jsonb;
  v_needs text[];
begin
  select 1 into v_lock from public.app_config where id = 1 for update;

  if coalesce(trim(p_name), '') = '' then
    raise exception 'NAME_REQUIRED: お名前を入力してください';
  end if;
  if coalesce(trim(p_phone), '') = '' then
    raise exception 'PHONE_REQUIRED: 電話番号を入力してください';
  end if;
  if jsonb_typeof(p_type_ids) = 'array' and jsonb_array_length(p_type_ids) > 8 then
    raise exception 'TOO_MANY_SEATS: 一度に申し込めるのは8席までです';
  end if;
  if p_zone is null or not exists (
    select 1 from public.seat_zone sz where sz.zone = p_zone
  ) then
    raise exception 'INVALID_ZONE: ゾーンが指定されていません';
  end if;

  -- R38: 希望は既知の種別だけを重複なしで受け付ける
  select coalesce(array_agg(distinct n), '{}'::text[])
    into v_needs
    from unnest(coalesce(p_access_needs, '{}'::text[])) as n
   where n in ('wheelchair', 'parentRoom');

  -- 公演スナップショット（電話上限の照合にも使う。book_seats と同じ取り方）
  select performance, blocked_seats into v_perf, v_blocked_arr
    from public.app_config where id = 1;

  -- R9 (1): 全体レート上限（直近10分の作成数。book_seats と同一条件）
  select count(*) into v_recent_count
    from public.reservations
   where created_at > now() - interval '10 minutes';
  if v_recent_count > (v_limits ->> 'global_max_created_per_10min')::int then
    raise exception 'TOO_BUSY: ただいま混み合っています。少し時間をおいてお試しください';
  end if;

  -- R9 (2): 同一電話番号の有効予約上限（book_seats と同一条件）
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

  -- 券種明細を作成し、金額をサーバ側で再計算する（締切チェックもここ）
  v_priced := public.sakura_price_zone_items(p_type_ids, true);
  v_party := jsonb_array_length(v_priced -> 'items');

  -- 収容判定（カウントホールド）。app_config の行ロック下なので原子的
  select count(*) into v_physical
    from public.seat_zone sz where sz.zone = p_zone;
  select count(*) into v_blocked
    from public.seat_zone sz
   where sz.zone = p_zone
     and to_jsonb(sz.seat_id) <@ coalesce(v_blocked_arr, '[]'::jsonb);
  select count(*) into v_taken
    from public.seat_state ss
    join public.seat_zone sz on sz.seat_id = ss.seat_id
   where sz.zone = p_zone;
  select coalesce(sum(jsonb_array_length(r.items)), 0) into v_holds
    from public.reservations r
   where r.zone = p_zone
     and r.status = 'active'
     and (
       r.perf_date is null
       or (
         r.perf_date is not distinct from (v_perf ->> 'date')
         and r.perf_name is not distinct from (v_perf ->> 'name')
       )
     )
     and not exists (
       select 1 from jsonb_array_elements(r.items) ie
        where coalesce(ie ->> 'seatId', '') <> ''
     );
  if v_physical - v_blocked - v_taken - v_holds < v_party then
    raise exception 'ZONE_FULL: このゾーンは満席です';
  end if;

  loop
    v_attempt := v_attempt + 1;
    v_code := public.sakura_next_code();
    v_token := public.sakura_new_qr_token();
    begin
      insert into public.reservations
        (code, name, phone, note, items, amount, kind, paid, qr_token,
         perf_date, perf_name, zone, access_needs)
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
        v_perf ->> 'name',
        p_zone,
        v_needs
      );
      exit;
    exception when unique_violation then
      if v_attempt >= 5 then raise; end if;
    end;
  end loop;

  -- seat_state には何も書かない（特定の席は押さえていない）

  return jsonb_build_object(
    'code', v_code,
    'amount', (v_priced ->> 'amount')::int,
    'token', v_token
  );
end;
$$;

grant execute on function public.book_zone(text, text, text, text, jsonb, text[])
  to anon, authenticated;

-- ------------------------------------------------------------
-- 4. キャンセル待ち（R38）: 完売時に観客が登録し、スタッフが一覧から
--    電話連絡するための仕組み。通知送信は行わない。
--    テーブルは RLS 有効・直接権限なし（DEFINER 関数経由のみ）。
-- ------------------------------------------------------------
create table if not exists public.waitlist (
  id uuid primary key default gen_random_uuid(),
  code text not null unique,
  zone text,
  party_size int not null,
  name text not null,
  phone text not null,
  status text not null default 'waiting',
  created_at timestamptz not null default now()
);

alter table public.waitlist enable row level security;
revoke all on table public.waitlist from anon, authenticated;

-- 採番カウンタ（WL-0001 形式。app_config 行ロック下で進める）
alter table public.app_config
  add column if not exists waitlist_seq int not null default 0;

create or replace function public.add_waitlist(
  p_name text,
  p_phone text,
  p_zone text,
  p_party_size int
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_lock int;
  v_limits jsonb := public.sakura_r9_limits();
  v_recent_count int;
  v_phone_count int;
  v_phone_norm text;
  v_seq int;
  v_code text;
begin
  select 1 into v_lock from public.app_config where id = 1 for update;

  if coalesce(trim(p_name), '') = '' then
    raise exception 'NAME_REQUIRED: お名前を入力してください';
  end if;
  if coalesce(trim(p_phone), '') = '' then
    raise exception 'PHONE_REQUIRED: 電話番号を入力してください';
  end if;
  if not public.sakura_valid_phone(p_phone) then
    raise exception 'PHONE_INVALID: 電話番号の形式が正しくありません';
  end if;
  if p_party_size is null or p_party_size < 1 or p_party_size > 8 then
    raise exception 'TOO_MANY_SEATS: 人数は1〜8名で指定してください';
  end if;
  if p_zone is not null and not exists (
    select 1 from public.seat_zone sz where sz.zone = p_zone
  ) then
    raise exception 'INVALID_ZONE: ゾーンが指定されていません';
  end if;

  -- フラッド防止（R9 と同じ考え方）: 全体レート＋同一電話の登録上限
  select count(*) into v_recent_count
    from public.waitlist
   where created_at > now() - interval '10 minutes';
  if v_recent_count > (v_limits ->> 'global_max_created_per_10min')::int then
    raise exception 'TOO_BUSY: ただいま混み合っています。少し時間をおいてお試しください';
  end if;
  v_phone_norm := public.sakura_normalize_phone(p_phone);
  select count(*) into v_phone_count
    from public.waitlist
   where status = 'waiting'
     and public.sakura_normalize_phone(phone) = v_phone_norm;
  if v_phone_count >= 3 then
    raise exception 'PHONE_LIMIT: この電話番号でのキャンセル待ち登録が上限に達しています';
  end if;

  update public.app_config
     set waitlist_seq = waitlist_seq + 1
   where id = 1
  returning waitlist_seq into v_seq;
  v_code := 'WL-' || lpad(v_seq::text, 4, '0');

  insert into public.waitlist (code, zone, party_size, name, phone)
  values (v_code, p_zone, p_party_size, trim(p_name), v_phone_norm);

  return jsonb_build_object('code', v_code);
end;
$$;

grant execute on function public.add_waitlist(text, text, text, int)
  to anon, authenticated;

-- キャンセル待ちの取り下げ（スタッフ操作。物理削除せず status で残す）
create or replace function public.staff_remove_waitlist(
  p_passcode text,
  p_code text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
begin
  perform public.sakura_check_passcode(p_passcode);

  update public.waitlist
     set status = 'removed'
   where code = p_code and status = 'waiting';
  if not found then
    raise exception 'NOT_FOUND: キャンセル待ちが見つかりません';
  end if;

  return jsonb_build_object('ok', true);
end;
$$;

grant execute on function public.staff_remove_waitlist(text, text)
  to anon, authenticated;

-- ------------------------------------------------------------
-- 5. staff_get_all（R38）: 予約に希望・返金・担当者を含め、
--    キャンセル待ち（waiting のみ）も返す。それ以外は R12 版と同一。
-- ------------------------------------------------------------
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
  v_wait jsonb;
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
        'seller', seller,
        'zone', zone,
        'accessNeeds', coalesce(access_needs, '{}'::text[]),
        'refunded', refunded,
        'refundedAt', refunded_at,
        'checkedInBy', checked_in_by,
        'paidBy', paid_by,
        'checkedInAt', checked_in_at,
        'perfDate', perf_date,
        'perfName', perf_name,
        'createdAt', created_at
      ) as row, created_at
      from public.reservations
    ) s;

  select coalesce(jsonb_agg(w.row order by w.created_at), '[]'::jsonb)
    into v_wait
    from (
      select jsonb_build_object(
        'id', code,
        'zone', zone,
        'partySize', party_size,
        'name', name,
        'phone', phone,
        'createdAt', created_at
      ) as row, created_at
      from public.waitlist
      where status = 'waiting'
    ) w;

  return jsonb_build_object(
    'config', jsonb_build_object(
      'performance', v_perf,
      'blockedSeats', coalesce(v_blocked, '[]'::jsonb),
      'bookingDeadline', v_deadline
    ),
    'reservations', v_res,
    'waitlist', v_wait
  );
end;
$$;

grant execute on function public.staff_get_all(text) to anon, authenticated;

-- ------------------------------------------------------------
-- 6. lookup_reservation（R38）: 希望（accessNeeds）も返す。
--    スロットル・照合条件は R12 版（R9 の形）のまま。
-- ------------------------------------------------------------
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
    'zone', v_row.zone,
    'accessNeeds', coalesce(v_row.access_needs, '{}'::text[]),
    'createdAt', v_row.created_at,
    'qrToken', v_row.qr_token,
    'checkedInAt', v_row.checked_in_at,
    'perfDate', v_row.perf_date,
    'perfName', v_row.perf_name,
    'performance', v_perf
  );
end;
$$;

grant execute on function public.lookup_reservation(text, text) to anon, authenticated;

-- ------------------------------------------------------------
-- 7. staff_check_in（R38）: R17 版に次を追加して作り直す。
--    - 要約に accessNeeds（クライアントが専用席も含めて席を詰めるため）
--    - 席の検証を sakura_seat_allowed に（希望した専用席も割当可能に）
--    - p_operator（担当者）を受け付けの処理者として記録
--    旧3引数シグネチャは drop してから作り直す。
-- ------------------------------------------------------------
drop function if exists public.staff_check_in(text, text, jsonb);

create or replace function public.staff_check_in(
  p_passcode text,
  p_token text,
  p_seat_ids jsonb default null,
  p_operator text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row public.reservations%rowtype;
  v_perf jsonb;
  v_summary jsonb;
  v_lock int;
  v_party int;
  v_blocked jsonb;
  v_items jsonb;
  v_operator text := nullif(trim(coalesce(p_operator, '')), '');
begin
  perform public.sakura_check_passcode(p_passcode);

  select 1 into v_lock from public.app_config where id = 1 for update;

  if coalesce(trim(p_token), '') = '' then
    return jsonb_build_object('ok', false, 'result', 'NOT_FOUND');
  end if;

  select * into v_row
    from public.reservations
   where qr_token = p_token
     for update;
  if not found then
    return jsonb_build_object('ok', false, 'result', 'NOT_FOUND');
  end if;

  -- 画面表示用の要約（R38: accessNeeds を追加）
  v_summary := jsonb_build_object(
    'code', v_row.code,
    'name', v_row.name,
    'items', v_row.items,
    'amount', v_row.amount,
    'kind', v_row.kind,
    'paid', v_row.paid,
    'zone', v_row.zone,
    'accessNeeds', coalesce(v_row.access_needs, '{}'::text[]),
    'checkedInAt', v_row.checked_in_at,
    'perfDate', v_row.perf_date,
    'perfName', v_row.perf_name
  );

  -- 予約時点の公演と現在の公演設定が違えば、別の公演の QR として扱う
  select performance into v_perf from public.app_config where id = 1;
  if v_row.perf_date is distinct from (v_perf ->> 'date')
     or v_row.perf_name is distinct from (v_perf ->> 'name') then
    return v_summary || jsonb_build_object(
      'ok', false, 'result', 'WRONG_PERFORMANCE'
    );
  end if;

  if v_row.status = 'cancelled' then
    return v_summary || jsonb_build_object('ok', false, 'result', 'CANCELLED');
  end if;

  if v_row.checked_in then
    return v_summary || jsonb_build_object(
      'ok', false, 'result', 'ALREADY_CHECKED_IN'
    );
  end if;

  -- ゾーン予約で席が未割当なら、受付と同時に席を決める（R17 のまま）
  if v_row.zone is not null
     and exists (
       select 1 from jsonb_array_elements(v_row.items) e
        where coalesce(e ->> 'seatId', '') = ''
     ) then
    if p_seat_ids is null then
      return v_summary || jsonb_build_object(
        'ok', false, 'result', 'NEEDS_SEATS'
      );
    end if;

    v_party := jsonb_array_length(v_row.items);
    if jsonb_typeof(p_seat_ids) <> 'array'
       or jsonb_array_length(p_seat_ids) <> v_party then
      return v_summary || jsonb_build_object(
        'ok', false, 'result', 'SEAT_INVALID'
      );
    end if;
    if (select count(distinct s) from jsonb_array_elements_text(p_seat_ids) s)
         <> v_party
       or exists (
         select 1 from jsonb_array_elements_text(p_seat_ids) s
          where coalesce(s, '') = ''
       ) then
      return v_summary || jsonb_build_object(
        'ok', false, 'result', 'SEAT_INVALID'
      );
    end if;
    select coalesce(blocked_seats, '[]'::jsonb) into v_blocked
      from public.app_config where id = 1;
    if exists (
      select 1 from jsonb_array_elements_text(p_seat_ids) s
       where to_jsonb(s) <@ v_blocked
    ) then
      return v_summary || jsonb_build_object(
        'ok', false, 'result', 'SEAT_INVALID'
      );
    end if;
    -- R38: ゾーン内の席に加え、希望した種別の専用席も許可する
    if exists (
      select 1 from jsonb_array_elements_text(p_seat_ids) s
       where not public.sakura_seat_allowed(s, v_row.zone, v_row.access_needs)
    ) then
      return v_summary || jsonb_build_object(
        'ok', false, 'result', 'SEAT_INVALID'
      );
    end if;
    if exists (
      select 1 from jsonb_array_elements_text(p_seat_ids) s
        join public.seat_state ss on ss.seat_id = s
    ) then
      return v_summary || jsonb_build_object(
        'ok', false, 'result', 'SEAT_TAKEN'
      );
    end if;

    -- 券種明細（順序・券種・金額はそのまま）に席を割り当てる
    select jsonb_agg(jsonb_set(t.e, '{seatId}', to_jsonb(s.sid)) order by t.ord)
      into v_items
      from jsonb_array_elements(v_row.items) with ordinality as t(e, ord)
      join jsonb_array_elements_text(p_seat_ids) with ordinality as s(sid, ord)
        on s.ord = t.ord;

    update public.reservations
       set items = v_items,
           checked_in = true,
           checked_in_at = now(),
           checked_in_by = coalesce(v_operator, checked_in_by)
     where id = v_row.id
    returning * into v_row;

    -- 支払いは触らないので seat_state は 'reserved'（'sold' ではない）
    insert into public.seat_state (seat_id, state)
    select s, 'reserved' from jsonb_array_elements_text(p_seat_ids) s;

    -- 要約は割当後の明細で作り直す（画面に席番号を出すため）
    v_summary := jsonb_build_object(
      'code', v_row.code,
      'name', v_row.name,
      'items', v_row.items,
      'amount', v_row.amount,
      'kind', v_row.kind,
      'paid', v_row.paid,
      'zone', v_row.zone,
      'accessNeeds', coalesce(v_row.access_needs, '{}'::text[]),
      'checkedInAt', v_row.checked_in_at,
      'perfDate', v_row.perf_date,
      'perfName', v_row.perf_name
    );

    return v_summary || jsonb_build_object('ok', true, 'result', 'OK');
  end if;

  update public.reservations
     set checked_in = true,
         checked_in_at = now(),
         checked_in_by = coalesce(v_operator, checked_in_by)
   where id = v_row.id
  returning * into v_row;

  v_summary := v_summary || jsonb_build_object(
    'checkedInAt', v_row.checked_in_at,
    'paid', v_row.paid
  );

  return v_summary || jsonb_build_object('ok', true, 'result', 'OK');
end;
$$;

grant execute on function public.staff_check_in(text, text, jsonb, text)
  to anon, authenticated;

-- ------------------------------------------------------------
-- 8. staff_assign_and_pay（R38）: R17 版に次を追加して作り直す。
--    - 席の検証を sakura_seat_allowed に（希望した専用席も割当可能に）
--    - p_operator（担当者）を支払い確定の処理者として記録
--      （受付完了 p_checked_in=true のときは受付の処理者も記録）
--    旧4引数シグネチャは drop してから作り直す。
-- ------------------------------------------------------------
drop function if exists public.staff_assign_and_pay(text, uuid, jsonb, boolean);

create or replace function public.staff_assign_and_pay(
  p_passcode text,
  p_id uuid,
  p_seat_ids jsonb,
  p_checked_in boolean default false,
  p_operator text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row public.reservations%rowtype;
  v_lock int;
  v_blocked jsonb;
  v_party int;
  v_current jsonb;
  v_items jsonb;
  v_own_complete boolean;
  v_operator text := nullif(trim(coalesce(p_operator, '')), '');
begin
  perform public.sakura_check_passcode(p_passcode);
  select 1 into v_lock from public.app_config where id = 1 for update;

  select * into v_row from public.reservations where id = p_id for update;
  if not found then
    raise exception 'NOT_FOUND: 予約が見つかりません';
  end if;
  if v_row.zone is null then
    raise exception 'NOT_ZONE_BOOKING: ゾーン予約ではありません';
  end if;
  if v_row.status <> 'active' then
    raise exception 'ALREADY_CANCELLED: キャンセル済みの予約です';
  end if;
  v_party := jsonb_array_length(v_row.items);

  -- 現在の割当（明細の seatId を順序どおりに並べたもの）
  select coalesce(jsonb_agg(e ->> 'seatId' order by ord), '[]'::jsonb)
    into v_current
    from jsonb_array_elements(v_row.items) with ordinality as t(e, ord);
  v_own_complete :=
    jsonb_array_length(v_current) = v_party
    and not exists (
      select 1 from jsonb_array_elements_text(v_current) s
       where coalesce(s, '') = ''
    );

  if v_row.paid then
    -- 冪等: すでに同じ席で支払い済みなら、来場指定と担当者だけ反映して成功
    if v_current = coalesce(p_seat_ids, '[]'::jsonb) then
      update public.reservations
         set checked_in = case
               when coalesce(p_checked_in, false) then true else checked_in end,
             checked_in_at = case
               when coalesce(p_checked_in, false)
               then coalesce(checked_in_at, now()) else checked_in_at end,
             checked_in_by = case
               when coalesce(p_checked_in, false)
               then coalesce(v_operator, checked_in_by) else checked_in_by end,
             paid_by = coalesce(v_operator, paid_by)
       where id = p_id;
      return jsonb_build_object('ok', true, 'items', v_row.items);
    end if;
    raise exception 'ALREADY_ASSIGNED: すでに別の席が割り当てられています';
  end if;

  -- 受付時に割当済み（未払い）の予約は、同じ席でのみ確定できる（R17）
  if v_own_complete
     and v_current <> coalesce(p_seat_ids, '[]'::jsonb) then
    raise exception 'ALREADY_ASSIGNED: すでに別の席が割り当てられています';
  end if;

  if p_seat_ids is null or jsonb_typeof(p_seat_ids) <> 'array'
     or jsonb_array_length(p_seat_ids) <> v_party then
    raise exception 'SEAT_COUNT_MISMATCH: 席数が人数と一致しません';
  end if;
  if (select count(distinct s) from jsonb_array_elements_text(p_seat_ids) s)
       <> v_party
     or exists (
       select 1 from jsonb_array_elements_text(p_seat_ids) s
        where coalesce(s, '') = ''
     ) then
    raise exception 'SEAT_COUNT_MISMATCH: 席の指定が不正です';
  end if;

  select coalesce(blocked_seats, '[]'::jsonb) into v_blocked
    from public.app_config where id = 1;
  if exists (
    select 1 from jsonb_array_elements_text(p_seat_ids) s
     where to_jsonb(s) <@ v_blocked
  ) then
    raise exception 'SEAT_BLOCKED: 販売していない席が含まれています';
  end if;
  -- R38: ゾーン内の席に加え、希望した種別の専用席も許可する
  if exists (
    select 1 from jsonb_array_elements_text(p_seat_ids) s
     where not public.sakura_seat_allowed(s, v_row.zone, v_row.access_needs)
  ) then
    raise exception 'SEAT_NOT_IN_ZONE: ゾーン外の席が含まれています';
  end if;
  if exists (
    select 1 from jsonb_array_elements_text(p_seat_ids) s
      join public.seat_state ss on ss.seat_id = s
     where not (to_jsonb(s) <@ v_current)
  ) then
    raise exception 'SEAT_TAKEN: 選択された座席の一部がすでに予約・販売済みです';
  end if;

  -- 券種明細（順序・券種・金額はそのまま）に席を割り当てる
  select jsonb_agg(jsonb_set(t.e, '{seatId}', to_jsonb(s.sid)) order by t.ord)
    into v_items
    from jsonb_array_elements(v_row.items) with ordinality as t(e, ord)
    join jsonb_array_elements_text(p_seat_ids) with ordinality as s(sid, ord)
      on s.ord = t.ord;

  update public.reservations
     set items = v_items,
         paid = true,
         paid_by = coalesce(v_operator, paid_by),
         checked_in = case when coalesce(p_checked_in, false) then true else checked_in end,
         checked_in_at = case
           when coalesce(p_checked_in, false) and checked_in_at is null then now()
           else checked_in_at end,
         checked_in_by = case
           when coalesce(p_checked_in, false)
           then coalesce(v_operator, checked_in_by) else checked_in_by end
   where id = p_id;

  insert into public.seat_state (seat_id, state)
  select s, 'sold' from jsonb_array_elements_text(p_seat_ids) s
  on conflict (seat_id) do update set state = excluded.state;

  return jsonb_build_object('ok', true, 'items', v_items);
end;
$$;

grant execute on function public.staff_assign_and_pay(text, uuid, jsonb, boolean, text)
  to anon, authenticated;

-- ------------------------------------------------------------
-- 9. staff_assign_seats（R38差分）: R25 版の席検証だけを
--    sakura_seat_allowed に差し替える（希望した専用席の手動指定を許可）。
--    シグネチャは不変のため create or replace のみ。
-- ------------------------------------------------------------
create or replace function public.staff_assign_seats(
  p_passcode text,
  p_id uuid,
  p_seat_ids jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row public.reservations%rowtype;
  v_lock int;
  v_blocked jsonb;
  v_party int;
  v_items jsonb;
begin
  perform public.sakura_check_passcode(p_passcode);
  select 1 into v_lock from public.app_config where id = 1 for update;

  select * into v_row from public.reservations where id = p_id for update;
  if not found then
    raise exception 'NOT_FOUND: 予約が見つかりません';
  end if;
  if v_row.zone is null then
    raise exception 'NOT_ZONE_BOOKING: ゾーン予約ではありません';
  end if;
  if v_row.status <> 'active' then
    raise exception 'ALREADY_CANCELLED: キャンセル済みの予約です';
  end if;

  -- 手動指定は「未割当」の予約だけが対象（R25 のまま）
  if exists (
    select 1 from jsonb_array_elements(v_row.items) e
     where coalesce(e ->> 'seatId', '') <> ''
  ) then
    raise exception 'ALREADY_ASSIGNED: すでに席が割り当てられています';
  end if;

  v_party := jsonb_array_length(v_row.items);

  if p_seat_ids is null or jsonb_typeof(p_seat_ids) <> 'array'
     or jsonb_array_length(p_seat_ids) <> v_party then
    raise exception 'SEAT_COUNT_MISMATCH: 席数が人数と一致しません';
  end if;
  if (select count(distinct s) from jsonb_array_elements_text(p_seat_ids) s)
       <> v_party
     or exists (
       select 1 from jsonb_array_elements_text(p_seat_ids) s
        where coalesce(s, '') = ''
     ) then
    raise exception 'SEAT_COUNT_MISMATCH: 席の指定が不正です';
  end if;

  select coalesce(blocked_seats, '[]'::jsonb) into v_blocked
    from public.app_config where id = 1;
  if exists (
    select 1 from jsonb_array_elements_text(p_seat_ids) s
     where to_jsonb(s) <@ v_blocked
  ) then
    raise exception 'SEAT_BLOCKED: 販売していない席が含まれています';
  end if;
  -- R38: ゾーン内の席に加え、希望した種別の専用席も許可する
  if exists (
    select 1 from jsonb_array_elements_text(p_seat_ids) s
     where not public.sakura_seat_allowed(s, v_row.zone, v_row.access_needs)
  ) then
    raise exception 'SEAT_NOT_IN_ZONE: ゾーン外の席が含まれています';
  end if;
  if exists (
    select 1 from jsonb_array_elements_text(p_seat_ids) s
      join public.seat_state ss on ss.seat_id = s
  ) then
    raise exception 'SEAT_TAKEN: 選択された座席の一部がすでに予約・販売済みです';
  end if;

  -- 券種明細に席を割り当てる。支払い・来場の状態には触らない（R25 のまま）
  select jsonb_agg(jsonb_set(t.e, '{seatId}', to_jsonb(s.sid)) order by t.ord)
    into v_items
    from jsonb_array_elements(v_row.items) with ordinality as t(e, ord)
    join jsonb_array_elements_text(p_seat_ids) with ordinality as s(sid, ord)
      on s.ord = t.ord;

  update public.reservations
     set items = v_items
   where id = p_id;

  insert into public.seat_state (seat_id, state)
  select s, case when v_row.paid then 'sold' else 'reserved' end
    from jsonb_array_elements_text(p_seat_ids) s;

  return jsonb_build_object('ok', true, 'items', v_items);
end;
$$;

grant execute on function public.staff_assign_seats(text, uuid, jsonb)
  to anon, authenticated;

-- ------------------------------------------------------------
-- 10. staff_update_reservation（R38）: R7 版に次を追加して作り直す。
--     - p_refunded（null = 変更しない）: 返金済みの記録（M3）
--     - p_operator: 支払い確定・受付の担当者記録（状態が新たに立つ
--       ときだけ記録し、戻したら消す。ローカル版 logic と同じ作法）
--     旧5引数シグネチャは drop してから作り直す。
-- ------------------------------------------------------------
drop function if exists public.staff_update_reservation(text, uuid, boolean, boolean, text);

create or replace function public.staff_update_reservation(
  p_passcode text,
  p_id uuid,
  p_paid boolean,
  p_checked_in boolean,
  p_status text,
  p_refunded boolean default null,
  p_operator text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_old public.reservations%rowtype;
  v_items jsonb;
  v_item jsonb;
  v_operator text := nullif(trim(coalesce(p_operator, '')), '');
begin
  perform public.sakura_check_passcode(p_passcode);

  if p_status not in ('active', 'cancelled') then
    raise exception 'INVALID_STATUS: ステータスが不正です';
  end if;

  select * into v_old from public.reservations where id = p_id for update;
  if not found then
    raise exception 'NOT_FOUND: 予約が見つかりません';
  end if;
  v_items := v_old.items;

  update public.reservations
     set paid = p_paid,
         checked_in = p_checked_in,
         checked_in_at = case
           when p_checked_in then coalesce(checked_in_at, now())
           else null
         end,
         status = p_status,
         refunded = case
           when p_refunded is null then refunded else p_refunded end,
         refunded_at = case
           when p_refunded is null then refunded_at
           when p_refunded then coalesce(refunded_at, now())
           else null end,
         paid_by = case
           when p_paid and not v_old.paid then coalesce(v_operator, paid_by)
           when not p_paid then null
           else paid_by end,
         checked_in_by = case
           when p_checked_in and not v_old.checked_in
             then coalesce(v_operator, checked_in_by)
           when not p_checked_in then null
           else checked_in_by end
   where id = p_id;

  if p_status = 'cancelled' then
    for v_item in select * from jsonb_array_elements(v_items) loop
      delete from public.seat_state where seat_id = (v_item ->> 'seatId');
    end loop;
  end if;

  return jsonb_build_object('ok', true);
end;
$$;

grant execute on function public.staff_update_reservation(
  text, uuid, boolean, boolean, text, boolean, text
) to anon, authenticated;

-- ------------------------------------------------------------
-- 11. staff_uncancel_reservation（R38・M1）: R12 版に ZONE_FULL 判定を
--     追加する。未割当のゾーン予約を復活させると、その人数分のホールドが
--     戻る。復活後のホールドがゾーンの残席（物理席数 − 販売しない席 −
--     割当済み − 現在のホールド）を超える場合は 'ZONE_FULL' を返して
--     拒否する（book_zone の収容判定と同じ式。当日受付で割り当て不能に
--     なるオーバーセルを防ぐ）。シグネチャは不変。
-- ------------------------------------------------------------
create or replace function public.staff_uncancel_reservation(
  p_passcode text,
  p_code text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row public.reservations%rowtype;
  v_item jsonb;
  v_conflict text;
  v_lock int;
  v_perf jsonb;
  v_blocked_arr jsonb;
  v_party int;
  v_physical int;
  v_blocked int;
  v_taken int;
  v_holds int;
begin
  perform public.sakura_check_passcode(p_passcode);

  -- 新規予約（book_seats / staff_sell）と同じロックで直列化する
  select 1 into v_lock from public.app_config where id = 1 for update;

  select * into v_row
    from public.reservations
   where code = p_code
     for update;
  if not found then
    return jsonb_build_object('ok', false, 'result', 'NOT_FOUND');
  end if;

  if v_row.status <> 'cancelled' then
    return jsonb_build_object('ok', false, 'result', 'NOT_CANCELLED');
  end if;

  -- 席が1つでも現在の占有（seat_state）に残っていれば、それは別の有効な
  -- 予約が使っている。未割当のゾーン予約は seatId が空なので判定対象外。
  select ss.seat_id into v_conflict
    from public.seat_state ss
   where ss.seat_id in (
     select elem ->> 'seatId'
       from jsonb_array_elements(v_row.items) as elem
      where coalesce(elem ->> 'seatId', '') <> ''
   )
   limit 1;
  if v_conflict is not null then
    return jsonb_build_object('ok', false, 'result', 'SEAT_TAKEN');
  end if;

  -- R38（M1）: 未割当のゾーン予約は、復活で増えるホールドがゾーンの
  -- 残席を超えるなら拒否する（book_zone の収容判定と同じ式）
  if v_row.zone is not null
     and not exists (
       select 1 from jsonb_array_elements(v_row.items) e
        where coalesce(e ->> 'seatId', '') <> ''
     ) then
    select performance, blocked_seats into v_perf, v_blocked_arr
      from public.app_config where id = 1;
    v_party := jsonb_array_length(v_row.items);
    select count(*) into v_physical
      from public.seat_zone sz where sz.zone = v_row.zone;
    select count(*) into v_blocked
      from public.seat_zone sz
     where sz.zone = v_row.zone
       and to_jsonb(sz.seat_id) <@ coalesce(v_blocked_arr, '[]'::jsonb);
    select count(*) into v_taken
      from public.seat_state ss
      join public.seat_zone sz on sz.seat_id = ss.seat_id
     where sz.zone = v_row.zone;
    select coalesce(sum(jsonb_array_length(r.items)), 0) into v_holds
      from public.reservations r
     where r.zone = v_row.zone
       and r.status = 'active'
       and (
         r.perf_date is null
         or (
           r.perf_date is not distinct from (v_perf ->> 'date')
           and r.perf_name is not distinct from (v_perf ->> 'name')
         )
       )
       and not exists (
         select 1 from jsonb_array_elements(r.items) ie
          where coalesce(ie ->> 'seatId', '') <> ''
       );
    if v_physical - v_blocked - v_taken - v_holds < v_party then
      return jsonb_build_object('ok', false, 'result', 'ZONE_FULL');
    end if;
  end if;

  update public.reservations
     set status = 'active'
   where id = v_row.id;

  for v_item in select * from jsonb_array_elements(v_row.items) loop
    if coalesce(v_item ->> 'seatId', '') = '' then
      continue;
    end if;
    insert into public.seat_state (seat_id, state)
    values (
      v_item ->> 'seatId',
      case when v_row.paid then 'sold' else 'reserved' end
    );
  end loop;

  return jsonb_build_object('ok', true, 'result', 'OK', 'code', v_row.code);
end;
$$;

grant execute on function public.staff_uncancel_reservation(text, text)
  to anon, authenticated;
