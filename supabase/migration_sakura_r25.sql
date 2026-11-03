-- ============================================================================
-- sakura-seats 追加マイグレーション (R25): 席の手動指定 RPC
-- staff_assign_seats ― ゾーン予約にスタッフが席だけを割り当てる
-- （評価ラウンド10・S-1 の修正）
-- Supabase ダッシュボードの SQL Editor でそのまま実行できる冪等なスクリプト。
-- 前提: migration_sakura.sql / _r4 / _r6 / _r7 / _r8 / _r9 / _r12 / _r15
--       / _r17 / _r21 が適用済み。
--
-- 問題（ラウンド10・運営 S-1）:
-- 自動割当（詰め）ができないゾーン予約は、案内どおり受付一覧から手動で
-- チェックインすると「来場済み・席未確定」のまま残った。支払い操作は
-- 自動割当が成功しない限り理由つきで拒否されるため、空きが出るか
-- ブロックを外すかしないと、スタッフがその場で席を決める手段がなかった。
--
-- 変更内容（このファイルで追加するもの）:
-- staff_assign_seats(p_passcode, p_id, p_seat_ids):
--   支払い・来場の状態は一切変えず、席だけを確定する RPC。
--   検証は staff_assign_and_pay（R17）と同一の基準:
--     - ゾーン予約であること（NOT_ZONE_BOOKING）
--     - キャンセル済みでないこと（ALREADY_CANCELLED）
--     - まだ席が割り当てられていないこと（ALREADY_ASSIGNED）
--     - 席数 = 人数・重複なし・空文字なし（SEAT_COUNT_MISMATCH）
--     - 販売しない席を含まない（SEAT_BLOCKED）
--     - 全席が予約のゾーン内にある（SEAT_NOT_IN_ZONE / seat_zone で照合）
--     - 他の予約・販売で使われていない（SEAT_TAKEN / seat_state で照合）
--   成功時は明細へ席を書き込み、seat_state に
--   支払い済みなら 'sold'、未払いなら 'reserved' で登録する
--   （未払いの通常ケースは 'reserved'。来場済み・未払いのまま席だけ
--   決めるのが主用途で、後の支払い操作は R17 の「自分の席」経路で
--   そのまま 'sold' に確定できる）。
--   未割当ホールドは items の seatId が埋まることで自動的に解ける
--   （get_public_state の zoneHolds 集計は未割当の予約だけを数える）。
--
-- 既存データへの影響: なし（関数の追加のみ）。
--
-- ★ 適用順序（重要）: クライアント（R25 のコード）より先に本マイグレーション
--   を適用すること。逆順でも既存機能は壊れないが、適用するまでの間
--   「席を指定する」操作だけが「サーバ更新（migration_sakura_r25 の適用）
--   後に使えるようになります」の案内になる。
-- ============================================================================

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

  -- 手動指定は「未割当」の予約だけが対象。すでに席がある予約の席を
  -- 動かしたい場合は、従来どおり未払い戻し等の既存経路を使う
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

  -- 券種明細（順序・券種・金額はそのまま）に席を割り当てる。
  -- 支払い・来場の状態には触らない
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
