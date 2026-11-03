-- ============================================================================
-- sakura-seats 追加マイグレーション (R17): QR受付のタイミングで席を決める
-- Supabase ダッシュボードの SQL Editor でそのまま実行できる冪等なスクリプト。
-- 前提: migration_sakura.sql / _r4 / _r6 / _r7 / _r8 / _r9 / _r12 / _r15
--       が適用済み。
--
-- 目的（2026-11-03 のオーナー要望）:
-- これまで席が決まるのは「スタッフが支払い済みにしたとき」（R12）だけ
-- だった。当日、入口で QR を読み取った瞬間に席が決まってほしい
-- （ゾーン分け＝ブロックは現行のまま）。
--
-- 変更内容:
-- 1. staff_check_in を3引数化する（2引数の旧シグネチャは drop してから
--    作り直し、オーバーロードの曖昧さを避ける）。
--    判定順と結果コードは従来どおり:
--      パスコード → 空トークン NOT_FOUND → トークン照合 →
--      WRONG_PERFORMANCE → CANCELLED → ALREADY_CHECKED_IN → OK
--    追加の振る舞い: ゾーン予約で席が未割当のときだけ、
--      - p_seat_ids が null なら受付せず 'NEEDS_SEATS' を返す
--        （クライアントが最新の空席から席を詰めて再送する）
--      - p_seat_ids があれば staff_assign_and_pay と同じ検証を行い、
--        席の割当と受付を原子的に行う。検証に失敗したら受付しない:
--        席が使用中なのが原因なら 'SEAT_TAKEN'、それ以外は 'SEAT_INVALID'
--      - 割当した席は seat_state に 'reserved' で入る（'sold' ではない）。
--        paid は一切触らない（支払いは従来どおりスタッフの手動操作のみ）
--    すでに席がある予約・従来型（zone なし）の予約では p_seat_ids を
--    無視し、従来どおり受付する。
-- 2. staff_assign_and_pay が「受付時に割当済み・未払い」の予約を受けられる
--    ようにする: 自分の予約がすでに押さえている席は SEAT_TAKEN の対象
--    から外し、同じ席での確定なら seat_state を 'sold' に更新して支払い
--    済みにできる。割当済みの予約に別の席を渡したら ALREADY_ASSIGNED。
--    （未割当の予約に対する従来の検証・冪等挙動は不変）
--
-- 既存データへの影響: なし（関数の作り直しのみ）。
-- ============================================================================

-- ------------------------------------------------------------
-- 1. staff_check_in（R17）: QR受付＋（未割当ゾーン予約なら）席の同時割当
-- ------------------------------------------------------------
drop function if exists public.staff_check_in(text, text);

create or replace function public.staff_check_in(
  p_passcode text,
  p_token text,
  p_seat_ids jsonb default null
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

  -- R17: ゾーン予約で席が未割当なら、受付と同時に席を決める
  if v_row.zone is not null
     and exists (
       select 1 from jsonb_array_elements(v_row.items) e
        where coalesce(e ->> 'seatId', '') = ''
     ) then
    if p_seat_ids is null then
      -- 席の候補はクライアント（最新の空席を知っている）が詰めて再送する
      return v_summary || jsonb_build_object(
        'ok', false, 'result', 'NEEDS_SEATS'
      );
    end if;

    -- staff_assign_and_pay と同じ検証（ただし結果は例外ではなく result で返す）
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
    if exists (
      select 1 from jsonb_array_elements_text(p_seat_ids) s
       where not exists (
         select 1 from public.seat_zone sz
          where sz.seat_id = s and sz.zone = v_row.zone
       )
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
           checked_in_at = now()
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
      'checkedInAt', v_row.checked_in_at,
      'perfDate', v_row.perf_date,
      'perfName', v_row.perf_name
    );

    return v_summary || jsonb_build_object('ok', true, 'result', 'OK');
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

grant execute on function public.staff_check_in(text, text, jsonb)
  to anon, authenticated;

-- ------------------------------------------------------------
-- 2. staff_assign_and_pay（R17差分）: 受付時に割当済みの席を
--    「自分の席」として扱い、同じ席での支払い確定を受けられるようにする。
--    それ以外は R12 版と同一。
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
  v_own_complete boolean;
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
    -- 冪等: すでに同じ席で支払い済みなら、来場指定だけ反映して成功
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

  -- R17: 受付時に割当済み（未払い）の予約は、同じ席でのみ確定できる
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
         checked_in = case when coalesce(p_checked_in, false) then true else checked_in end,
         checked_in_at = case
           when coalesce(p_checked_in, false) and checked_in_at is null then now()
           else checked_in_at end
   where id = p_id;

  insert into public.seat_state (seat_id, state)
  select s, 'sold' from jsonb_array_elements_text(p_seat_ids) s
  on conflict (seat_id) do update set state = excluded.state;

  return jsonb_build_object('ok', true, 'items', v_items);
end;
$$;

grant execute on function public.staff_assign_and_pay(text, uuid, jsonb, boolean)
  to anon, authenticated;
