-- ============================================================
-- さくら席 R12 マイグレーション
-- 「席は予約時に確定しない」モデルへの移行:
--   - オンライン予約はゾーン＋人数（券種内訳）だけを申し込み、
--     座席は未確定のまま保持する（items の seatId は空文字）
--   - 実際の座席は、スタッフが「支払い済み」にした時点で割り当てる
--     （staff_assign_and_pay が支払い確定と席の割当を原子的に行う）
--   - reservations に zone 列（nullable）を追加。既存行は zone = null の
--     まま＝従来どおり「席が確定している予約」として扱う（grandfathering）
--
-- 冪等性: 何度貼ってもよい（add column if not exists / create or replace /
-- on conflict do nothing）。既存行のデータは一切変更しない。
-- 適用手順: このファイル全体を Supabase SQL Editor に貼って Run。
-- 前提: migration_sakura.sql / r4 / r6 / r7 / r8 / r9 が適用済みであること。
-- ============================================================

-- ------------------------------------------------------------
-- 1. reservations.zone 列（ゾーン予約の識別。null = 従来型の予約）
-- ------------------------------------------------------------
alter table public.reservations
  add column if not exists zone text;

-- ------------------------------------------------------------
-- 2. seat_zone: 座席→ゾーンの静的対応表（アプリ側 src/lib/zones.ts と同一内容）
--    RPC 内での「そのゾーンの席か」「ゾーンの物理席数」の判定にだけ使う。
--    RLS 有効・anon/authenticated への権限なし（SECURITY DEFINER 関数経由のみ）。
-- ------------------------------------------------------------
create table if not exists public.seat_zone (
  seat_id text primary key,
  zone text not null
);

alter table public.seat_zone enable row level security;
revoke all on table public.seat_zone from anon, authenticated;

insert into public.seat_zone (seat_id, zone) values
('1F-1-6', 'A'),
('1F-1-7', 'A'),
('1F-1-8', 'A'),
('1F-1-9', 'A'),
('1F-1-10', 'A'),
('1F-1-11', 'A'),
('1F-1-12', 'A'),
('1F-1-13', 'A'),
('1F-1-14', 'A'),
('1F-1-15', 'A'),
('1F-1-16', 'A'),
('1F-1-17', 'A'),
('1F-1-18', 'A'),
('1F-1-19', 'A'),
('1F-1-20', 'A'),
('1F-2-6', 'A'),
('1F-2-7', 'A'),
('1F-2-8', 'A'),
('1F-2-9', 'A'),
('1F-2-10', 'A'),
('1F-2-11', 'A'),
('1F-2-12', 'A'),
('1F-2-13', 'A'),
('1F-2-14', 'A'),
('1F-2-15', 'A'),
('1F-2-16', 'A'),
('1F-2-17', 'A'),
('1F-2-18', 'A'),
('1F-2-19', 'A'),
('1F-2-20', 'A'),
('1F-2-21', 'A'),
('1F-3-6', 'A'),
('1F-3-7', 'A'),
('1F-3-8', 'A'),
('1F-3-9', 'A'),
('1F-3-10', 'A'),
('1F-3-11', 'A'),
('1F-3-12', 'A'),
('1F-3-13', 'A'),
('1F-3-14', 'A'),
('1F-3-15', 'A'),
('1F-3-16', 'A'),
('1F-3-17', 'A'),
('1F-3-18', 'A'),
('1F-3-19', 'A'),
('1F-3-20', 'A'),
('1F-4-6', 'A'),
('1F-4-7', 'A'),
('1F-4-8', 'A'),
('1F-4-9', 'A'),
('1F-4-10', 'A'),
('1F-4-11', 'A'),
('1F-4-12', 'A'),
('1F-4-13', 'A'),
('1F-4-14', 'A'),
('1F-4-15', 'A'),
('1F-4-16', 'A'),
('1F-4-17', 'A'),
('1F-4-18', 'A'),
('1F-4-19', 'A'),
('1F-4-20', 'A'),
('1F-4-21', 'A'),
('1F-5-6', 'B'),
('1F-5-7', 'B'),
('1F-5-8', 'B'),
('1F-5-9', 'B'),
('1F-5-10', 'B'),
('1F-5-11', 'B'),
('1F-5-12', 'B'),
('1F-5-13', 'B'),
('1F-5-14', 'B'),
('1F-5-15', 'B'),
('1F-5-16', 'B'),
('1F-5-17', 'B'),
('1F-5-18', 'B'),
('1F-5-19', 'B'),
('1F-5-20', 'B'),
('1F-6-6', 'B'),
('1F-6-7', 'B'),
('1F-6-8', 'B'),
('1F-6-9', 'B'),
('1F-6-10', 'B'),
('1F-6-11', 'B'),
('1F-6-12', 'B'),
('1F-6-13', 'B'),
('1F-6-14', 'B'),
('1F-6-15', 'B'),
('1F-6-16', 'B'),
('1F-6-17', 'B'),
('1F-6-18', 'B'),
('1F-6-19', 'B'),
('1F-6-20', 'B'),
('1F-6-21', 'B'),
('1F-7-6', 'B'),
('1F-7-7', 'B'),
('1F-7-8', 'B'),
('1F-7-9', 'B'),
('1F-7-10', 'B'),
('1F-7-11', 'B'),
('1F-7-12', 'B'),
('1F-7-13', 'B'),
('1F-7-14', 'B'),
('1F-7-15', 'B'),
('1F-7-16', 'B'),
('1F-7-17', 'B'),
('1F-7-18', 'B'),
('1F-7-19', 'B'),
('1F-7-20', 'B'),
('1F-7-21', 'B'),
('1F-8-6', 'B'),
('1F-8-7', 'B'),
('1F-8-8', 'B'),
('1F-8-9', 'B'),
('1F-8-10', 'B'),
('1F-8-11', 'B'),
('1F-8-12', 'B'),
('1F-8-13', 'B'),
('1F-8-14', 'B'),
('1F-8-15', 'B'),
('1F-8-16', 'B'),
('1F-8-17', 'B'),
('1F-8-18', 'B'),
('1F-8-19', 'B'),
('1F-8-20', 'B'),
('1F-8-21', 'B'),
('1F-9-6', 'B'),
('1F-9-7', 'B'),
('1F-9-8', 'B'),
('1F-9-9', 'B'),
('1F-9-10', 'B'),
('1F-9-11', 'B'),
('1F-9-12', 'B'),
('1F-9-13', 'B'),
('1F-9-14', 'B'),
('1F-9-15', 'B'),
('1F-9-16', 'B'),
('1F-9-17', 'B'),
('1F-9-18', 'B'),
('1F-9-19', 'B'),
('1F-9-20', 'B'),
('1F-9-21', 'B'),
('1F-10-6', 'B'),
('1F-10-7', 'B'),
('1F-10-8', 'B'),
('1F-10-9', 'B'),
('1F-10-10', 'B'),
('1F-10-11', 'B'),
('1F-10-12', 'B'),
('1F-10-13', 'B'),
('1F-10-14', 'B'),
('1F-10-15', 'B'),
('1F-10-16', 'B'),
('1F-10-17', 'B'),
('1F-10-18', 'B'),
('1F-10-19', 'B'),
('1F-10-20', 'B'),
('1F-10-21', 'B'),
('1F-11-10', 'C'),
('1F-11-11', 'C'),
('1F-11-12', 'C'),
('1F-11-13', 'C'),
('1F-11-14', 'C'),
('1F-11-15', 'C'),
('1F-11-16', 'C'),
('1F-11-17', 'C'),
('1F-11-18', 'C'),
('1F-11-19', 'C'),
('1F-11-20', 'C'),
('1F-11-21', 'C'),
('1F-12-10', 'C'),
('1F-12-11', 'C'),
('1F-12-12', 'C'),
('1F-12-13', 'C'),
('1F-12-14', 'C'),
('1F-12-15', 'C'),
('1F-12-16', 'C'),
('1F-12-17', 'C'),
('1F-12-18', 'C'),
('1F-12-19', 'C'),
('1F-12-20', 'C'),
('1F-12-21', 'C'),
('1F-13-6', 'C'),
('1F-13-7', 'C'),
('1F-13-8', 'C'),
('1F-13-9', 'C'),
('1F-13-10', 'C'),
('1F-13-11', 'C'),
('1F-13-12', 'C'),
('1F-13-13', 'C'),
('1F-13-14', 'C'),
('1F-13-15', 'C'),
('1F-13-16', 'C'),
('1F-13-17', 'C'),
('1F-13-18', 'C'),
('1F-13-19', 'C'),
('1F-13-20', 'C'),
('1F-13-21', 'C'),
('1F-14-6', 'C'),
('1F-14-7', 'C'),
('1F-14-8', 'C'),
('1F-14-9', 'C'),
('1F-14-10', 'C'),
('1F-14-11', 'C'),
('1F-14-12', 'C'),
('1F-14-13', 'C'),
('1F-14-14', 'C'),
('1F-14-15', 'C'),
('1F-14-16', 'C'),
('1F-14-17', 'C'),
('1F-14-18', 'C'),
('1F-14-19', 'C'),
('1F-14-20', 'C'),
('1F-14-21', 'C'),
('1F-15-6', 'C'),
('1F-15-7', 'C'),
('1F-15-8', 'C'),
('1F-15-9', 'C'),
('1F-15-10', 'C'),
('1F-15-11', 'C'),
('1F-15-12', 'C'),
('1F-15-13', 'C'),
('1F-15-14', 'C'),
('1F-15-15', 'C'),
('1F-15-16', 'C'),
('1F-15-17', 'C'),
('1F-15-18', 'C'),
('1F-15-19', 'C'),
('1F-15-20', 'C'),
('1F-15-21', 'C'),
('1F-1-3', 'D'),
('1F-1-4', 'D'),
('1F-1-5', 'D'),
('1F-2-2', 'D'),
('1F-2-3', 'D'),
('1F-2-4', 'D'),
('1F-2-5', 'D'),
('1F-3-2', 'D'),
('1F-3-3', 'D'),
('1F-3-4', 'D'),
('1F-3-5', 'D'),
('1F-4-1', 'D'),
('1F-4-2', 'D'),
('1F-4-3', 'D'),
('1F-4-4', 'D'),
('1F-4-5', 'D'),
('1F-5-1', 'D'),
('1F-5-2', 'D'),
('1F-5-3', 'D'),
('1F-5-4', 'D'),
('1F-5-5', 'D'),
('1F-6-1', 'D'),
('1F-6-2', 'D'),
('1F-6-3', 'D'),
('1F-6-4', 'D'),
('1F-6-5', 'D'),
('1F-7-1', 'D'),
('1F-7-2', 'D'),
('1F-7-3', 'D'),
('1F-7-4', 'D'),
('1F-7-5', 'D'),
('1F-8-1', 'D'),
('1F-8-2', 'D'),
('1F-8-3', 'D'),
('1F-8-4', 'D'),
('1F-8-5', 'D'),
('1F-9-1', 'D'),
('1F-9-2', 'D'),
('1F-9-3', 'D'),
('1F-9-4', 'D'),
('1F-9-5', 'D'),
('1F-10-1', 'D'),
('1F-10-2', 'D'),
('1F-10-3', 'D'),
('1F-10-4', 'D'),
('1F-10-5', 'D'),
('1F-11-1', 'E'),
('1F-11-2', 'E'),
('1F-11-3', 'E'),
('1F-11-4', 'E'),
('1F-11-5', 'E'),
('1F-12-1', 'E'),
('1F-12-2', 'E'),
('1F-12-3', 'E'),
('1F-12-4', 'E'),
('1F-12-5', 'E'),
('1F-14-1', 'E'),
('1F-14-2', 'E'),
('1F-14-3', 'E'),
('1F-14-4', 'E'),
('1F-14-5', 'E'),
('1F-15-1', 'E'),
('1F-15-2', 'E'),
('1F-15-3', 'E'),
('1F-15-4', 'E'),
('1F-15-5', 'E'),
('1F-16-1', 'E'),
('1F-16-2', 'E'),
('1F-16-3', 'E'),
('1F-16-4', 'E'),
('1F-1-22', 'F'),
('1F-1-23', 'F'),
('1F-1-24', 'F'),
('1F-2-22', 'F'),
('1F-2-23', 'F'),
('1F-2-24', 'F'),
('1F-2-25', 'F'),
('1F-3-22', 'F'),
('1F-3-23', 'F'),
('1F-3-24', 'F'),
('1F-3-25', 'F'),
('1F-4-22', 'F'),
('1F-4-23', 'F'),
('1F-4-24', 'F'),
('1F-4-25', 'F'),
('1F-4-26', 'F'),
('1F-5-22', 'F'),
('1F-5-23', 'F'),
('1F-5-24', 'F'),
('1F-5-25', 'F'),
('1F-5-26', 'F'),
('1F-6-22', 'F'),
('1F-6-23', 'F'),
('1F-6-24', 'F'),
('1F-6-25', 'F'),
('1F-6-26', 'F'),
('1F-7-22', 'F'),
('1F-7-23', 'F'),
('1F-7-24', 'F'),
('1F-7-25', 'F'),
('1F-7-26', 'F'),
('1F-8-22', 'F'),
('1F-8-23', 'F'),
('1F-8-24', 'F'),
('1F-8-25', 'F'),
('1F-8-26', 'F'),
('1F-9-22', 'F'),
('1F-9-23', 'F'),
('1F-9-24', 'F'),
('1F-9-25', 'F'),
('1F-9-26', 'F'),
('1F-10-22', 'F'),
('1F-10-23', 'F'),
('1F-10-24', 'F'),
('1F-10-25', 'F'),
('1F-10-26', 'F'),
('1F-11-22', 'G'),
('1F-11-23', 'G'),
('1F-11-24', 'G'),
('1F-11-25', 'G'),
('1F-11-26', 'G'),
('1F-12-22', 'G'),
('1F-12-23', 'G'),
('1F-12-24', 'G'),
('1F-12-25', 'G'),
('1F-12-26', 'G'),
('1F-14-22', 'G'),
('1F-14-23', 'G'),
('1F-14-24', 'G'),
('1F-14-25', 'G'),
('1F-14-26', 'G'),
('1F-15-22', 'G'),
('1F-15-23', 'G'),
('1F-15-24', 'G'),
('1F-15-25', 'G'),
('1F-15-26', 'G'),
('1F-16-23', 'G'),
('1F-16-24', 'G'),
('1F-16-25', 'G'),
('1F-16-26', 'G'),
('2F-21-3', 'H'),
('2F-21-4', 'H'),
('2F-21-5', 'H'),
('2F-21-6', 'H'),
('2F-21-7', 'H'),
('2F-21-8', 'H'),
('2F-21-9', 'H'),
('2F-21-10', 'H'),
('2F-21-11', 'H'),
('2F-21-12', 'H'),
('2F-21-13', 'H'),
('2F-21-14', 'H'),
('2F-21-15', 'H'),
('2F-21-16', 'H'),
('2F-21-17', 'H'),
('2F-21-18', 'H'),
('2F-21-19', 'H'),
('2F-21-20', 'H'),
('2F-21-21', 'H'),
('2F-21-22', 'H'),
('2F-21-23', 'H'),
('2F-21-24', 'H'),
('2F-21-25', 'H'),
('2F-21-26', 'H'),
('2F-22-2', 'H'),
('2F-22-3', 'H'),
('2F-22-4', 'H'),
('2F-22-5', 'H'),
('2F-22-6', 'H'),
('2F-22-7', 'H'),
('2F-22-8', 'H'),
('2F-22-9', 'H'),
('2F-22-10', 'H'),
('2F-22-11', 'H'),
('2F-22-12', 'H'),
('2F-22-13', 'H'),
('2F-22-14', 'H'),
('2F-22-15', 'H'),
('2F-22-16', 'H'),
('2F-22-17', 'H'),
('2F-22-18', 'H'),
('2F-22-19', 'H'),
('2F-22-20', 'H'),
('2F-22-21', 'H'),
('2F-22-22', 'H'),
('2F-22-23', 'H'),
('2F-22-24', 'H'),
('2F-22-25', 'H'),
('2F-22-26', 'H'),
('2F-22-27', 'H'),
('2F-23-1', 'H'),
('2F-23-2', 'H'),
('2F-23-3', 'H'),
('2F-23-4', 'H'),
('2F-23-5', 'H'),
('2F-23-6', 'H'),
('2F-23-7', 'H'),
('2F-23-8', 'H'),
('2F-23-9', 'H'),
('2F-23-10', 'H'),
('2F-23-11', 'H'),
('2F-23-12', 'H'),
('2F-23-13', 'H'),
('2F-23-14', 'H'),
('2F-23-15', 'H'),
('2F-23-16', 'H'),
('2F-23-17', 'H'),
('2F-23-18', 'H'),
('2F-23-19', 'H'),
('2F-23-20', 'H'),
('2F-23-21', 'H'),
('2F-23-22', 'H'),
('2F-23-23', 'H'),
('2F-23-24', 'H'),
('2F-23-25', 'H'),
('2F-23-26', 'H'),
('2F-23-27', 'H'),
('2F-23-28', 'H'),
('2F-SIDE-L-1', 'I'),
('2F-SIDE-L-2', 'I'),
('2F-SIDE-L-3', 'I'),
('2F-SIDE-L-4', 'I'),
('2F-SIDE-L-5', 'I'),
('2F-SIDE-L-6', 'I'),
('2F-SIDE-L-7', 'I'),
('2F-SIDE-R-1', 'I'),
('2F-SIDE-R-2', 'I'),
('2F-SIDE-R-3', 'I'),
('2F-SIDE-R-4', 'I'),
('2F-SIDE-R-5', 'I'),
('2F-SIDE-R-6', 'I'),
('2F-SIDE-R-7', 'I')
on conflict (seat_id) do nothing;

-- ------------------------------------------------------------
-- 3. sakura_price_zone_items: ゾーン予約の券種明細をサーバ側で作る
--    sakura_price_items のゾーン版。入力は券種IDの配列で、席は持たない
--    （seatId は空文字）。戻り値は sakura_price_items と同じ {items, amount}。
--    締切チェックも sakura_price_items(p_check_deadline=true) と揃える。
-- ------------------------------------------------------------
create or replace function public.sakura_price_zone_items(
  p_type_ids jsonb,
  p_check_deadline boolean
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_perf jsonb;
  v_deadline timestamptz;
  v_type_id text;
  v_type jsonb;
  v_out jsonb := '[]'::jsonb;
  v_total int := 0;
begin
  select performance, booking_deadline
    into v_perf, v_deadline
    from public.app_config where id = 1;
  if v_perf is null then
    raise exception 'NOT_CONFIGURED: 公演設定がありません';
  end if;

  if p_check_deadline and v_deadline is not null and now() > v_deadline then
    raise exception 'BOOKING_CLOSED: 予約受付は終了しました';
  end if;

  if p_type_ids is null or jsonb_typeof(p_type_ids) <> 'array'
     or jsonb_array_length(p_type_ids) = 0 then
    raise exception 'NO_SEATS: 人数が選択されていません';
  end if;

  for v_type_id in select jsonb_array_elements_text(p_type_ids) loop
    select t into v_type
      from jsonb_array_elements(v_perf -> 'ticketTypes') as t
     where t ->> 'id' = v_type_id;
    if v_type is null then
      raise exception 'INVALID_TYPE: 券種が見つかりません';
    end if;
    v_out := v_out || jsonb_build_object(
      'seatId', '',
      'typeId', v_type ->> 'id',
      'typeName', v_type ->> 'name',
      'price', (v_type ->> 'price')::int
    );
    v_total := v_total + (v_type ->> 'price')::int;
  end loop;

  return jsonb_build_object('items', v_out, 'amount', v_total);
end;
$$;

revoke execute on function public.sakura_price_zone_items(jsonb, boolean)
  from public, anon, authenticated;

-- ------------------------------------------------------------
-- 4. book_zone: ゾーン＋人数でのオンライン予約（book_seats のゾーン版）
--    - 席は割り当てない（items の seatId は空文字、seat_state は書かない）
--    - 収容判定は app_config の行ロック下で原子的:
--        ゾーン物理席数 − 販売しない席 − 割当済み席(seat_state)
--        − 未割当の有効なゾーン予約の人数合計（カウントホールド）
--      が申込人数未満なら ZONE_FULL
--    - R9 の不正対策（全体レート TOO_BUSY / 同一電話3件 PHONE_LIMIT）を
--      book_seats と同一条件で移植（しきい値は sakura_r9_limits が正）
--    - 金額はサーバ側で券種から再計算する
-- ------------------------------------------------------------
create or replace function public.book_zone(
  p_name text,
  p_phone text,
  p_note text,
  p_zone text,
  p_type_ids jsonb
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

  -- R9 (2): 同一電話番号の有効予約上限（book_seats と同一条件。
  -- 未割当のゾーン予約も kind='online' の有効な予約として自然に数えられる）
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

  -- 券種明細を作成し、金額をサーバ側で再計算する（seatId は空文字。
  -- 締切チェックもここで行われる）
  v_priced := public.sakura_price_zone_items(p_type_ids, true);
  v_party := jsonb_array_length(v_priced -> 'items');

  -- 収容判定（カウントホールド）。app_config の行ロック下なので原子的。
  -- 未割当ホールドは「同じ公演の・有効な・そのゾーンの・席が1つも
  -- 割り当たっていない予約」の人数合計。支払い済みでも未割当なら
  -- （通常は存在しないが）容量を消費する側に倒す。
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
         perf_date, perf_name, zone)
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
        p_zone
      );
      exit;
    exception when unique_violation then
      if v_attempt >= 5 then raise; end if;
    end;
  end loop;

  -- seat_state には何も書かない: 特定の席は押さえていない。
  -- 残席への反映は get_public_state の zoneHolds 集計で行う。

  return jsonb_build_object(
    'code', v_code,
    'amount', (v_priced ->> 'amount')::int,
    'token', v_token
  );
end;
$$;

grant execute on function public.book_zone(text, text, text, text, jsonb)
  to anon, authenticated;

-- ------------------------------------------------------------
-- 5. get_public_state: ゾーン別の「未割当ホールド人数」を集計で追加
--    プライバシー: 公開するのはゾーンごとの合計人数のみ。
--    誰の予約か・どの席かは一切含まない（席自体も押さえていない）。
--    既存キー（performance / blockedSeats / bookingDeadline / seats）は不変。
-- ------------------------------------------------------------
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
  v_holds jsonb;
begin
  select performance, blocked_seats, booking_deadline
    into v_perf, v_blocked, v_deadline
    from public.app_config where id = 1;

  select coalesce(jsonb_agg(jsonb_build_object('seatId', seat_id, 'state', state)), '[]'::jsonb)
    into v_seats
    from public.seat_state;

  select coalesce(jsonb_object_agg(h.zone, h.cnt), '{}'::jsonb)
    into v_holds
    from (
      select r.zone as zone,
             sum(jsonb_array_length(r.items))::int as cnt
        from public.reservations r
       where r.zone is not null
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
         )
       group by r.zone
    ) h;

  return jsonb_build_object(
    'performance', v_perf,
    'blockedSeats', coalesce(v_blocked, '[]'::jsonb),
    'bookingDeadline', v_deadline,
    'seats', v_seats,
    'zoneHolds', v_holds
  );
end;
$$;

grant execute on function public.get_public_state() to anon, authenticated;

-- ------------------------------------------------------------
-- 6. staff_assign_and_pay: 支払い確定と座席割当を原子的に行う
--    スタッフアプリが zones.ts の割当ロジックで選んだ席を受け取り、
--    サーバ側で再検証してから paid=true と席を同時に確定する。
--    検証: 予約が存在し・ゾーン予約で・キャンセル済みでなく・
--          まだ未払い（冪等: すでに同じ席で支払い済みなら成功）・
--          席数が人数と一致・重複や空が無い・全席がそのゾーン内・
--          販売しない席でない・どの予約にも割当済みでない
--    p_checked_in = true のときは受付完了（支払い＋来場）として扱う。
--    失敗した場合は例外になり、支払い済みにはならない。
-- ------------------------------------------------------------
create or replace function public.staff_assign_and_pay(
  p_passcode text,
  p_id uuid,
  p_seat_ids jsonb,
  p_checked_in boolean default false
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

  if v_row.paid then
    -- 冪等: すでに同じ席で支払い済みなら、来場指定だけ反映して成功
    select coalesce(jsonb_agg(e ->> 'seatId' order by ord), '[]'::jsonb)
      into v_current
      from jsonb_array_elements(v_row.items) with ordinality as t(e, ord);
    if v_current = coalesce(p_seat_ids, '[]'::jsonb) then
      if coalesce(p_checked_in, false) and not v_row.checked_in then
        update public.reservations
           set checked_in = true,
               checked_in_at = coalesce(checked_in_at, now())
         where id = p_id;
      end if;
      return jsonb_build_object('ok', true, 'items', v_row.items);
    end if;
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
  if exists (
    select 1 from jsonb_array_elements_text(p_seat_ids) s
     where not exists (
       select 1 from public.seat_zone sz
        where sz.seat_id = s and sz.zone = v_row.zone
     )
  ) then
    raise exception 'SEAT_NOT_IN_ZONE: ゾーン外の席が含まれています';
  end if;
  if exists (
    select 1 from jsonb_array_elements_text(p_seat_ids) s
      join public.seat_state ss on ss.seat_id = s
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
         checked_in = case when coalesce(p_checked_in, false) then true else checked_in end,
         checked_in_at = case
           when coalesce(p_checked_in, false) and checked_in_at is null then now()
           else checked_in_at end
   where id = p_id;

  insert into public.seat_state (seat_id, state)
  select s, 'sold' from jsonb_array_elements_text(p_seat_ids) s;

  return jsonb_build_object('ok', true, 'items', v_items);
end;
$$;

grant execute on function public.staff_assign_and_pay(text, uuid, jsonb, boolean)
  to anon, authenticated;

-- ------------------------------------------------------------
-- 7. staff_unassign_and_unpay: ゾーン予約の「未払いに戻す」
--    割り当てた席を解放し（seat_state 削除）、items の seatId を空に戻し、
--    paid=false にする。来場状態には触れない（staff_update_reservation
--    の支払い切替と同じ）。すでに未払い・未割当なら冪等に成功。
-- ------------------------------------------------------------
create or replace function public.staff_unassign_and_unpay(
  p_passcode text,
  p_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row public.reservations%rowtype;
  v_lock int;
  v_seat text;
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

  for v_seat in
    select e ->> 'seatId' from jsonb_array_elements(v_row.items) e
     where coalesce(e ->> 'seatId', '') <> ''
  loop
    delete from public.seat_state where seat_id = v_seat;
  end loop;

  select jsonb_agg(jsonb_set(e, '{seatId}', '""'::jsonb) order by ord)
    into v_items
    from jsonb_array_elements(v_row.items) with ordinality as t(e, ord);

  update public.reservations
     set items = v_items, paid = false
   where id = p_id;

  return jsonb_build_object('ok', true);
end;
$$;

grant execute on function public.staff_unassign_and_unpay(text, uuid)
  to anon, authenticated;

-- ------------------------------------------------------------
-- 8. staff_get_all: 行に zone を足す（R7 版の形をそのまま維持）
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
        'checkedInAt', checked_in_at,
        'perfDate', perf_date,
        'perfName', perf_name,
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

grant execute on function public.staff_get_all(text) to anon, authenticated;

-- ------------------------------------------------------------
-- 9. lookup_reservation: zone を足す（R9 版の形・スロットルをそのまま維持）
--    未払いのゾーン予約では items の seatId が空のまま返る＝
--    お客様画面に席番号は出ない。支払い後に割り当たれば席が入って返る。
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
-- 10. staff_check_in: 表示用サマリに zone を足す（R7 版の判定は不変。
--     受付は支払いに触れないという規則も不変）
-- ------------------------------------------------------------
create or replace function public.staff_check_in(
  p_passcode text,
  p_token text
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

  -- 画面表示用の要約（コード・氏名・明細・金額・支払い状態・公演スナップショット）
  v_summary := jsonb_build_object(
    'code', v_row.code,
    'name', v_row.name,
    'items', v_row.items,
    'amount', v_row.amount,
    'kind', v_row.kind,
    'paid', v_row.paid,
    'zone', v_row.zone,
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

  update public.reservations
     set checked_in = true,
         checked_in_at = now()
   where id = v_row.id
  returning * into v_row;

  v_summary := v_summary || jsonb_build_object(
    'checkedInAt', v_row.checked_in_at,
    'paid', v_row.paid
  );

  return v_summary || jsonb_build_object('ok', true, 'result', 'OK');
end;
$$;

grant execute on function public.staff_check_in(text, text) to anon, authenticated;

-- ------------------------------------------------------------
-- 11. staff_uncancel_reservation: 空の seatId を seat_state に書き戻さない
--     （未割当のゾーン予約を復活させたとき、座席 '' の幽霊行を作らない。
--     競合判定からも空 seatId を除く。それ以外は R6 版と同一）
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
