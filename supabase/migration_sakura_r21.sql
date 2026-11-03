-- ============================================================================
-- sakura-seats 追加マイグレーション (R21): 来場済み予約の「未払いに戻す」で
-- 席を解放しない（評価ラウンド8・S-2 の修正）
-- Supabase ダッシュボードの SQL Editor でそのまま実行できる冪等なスクリプト。
-- 前提: migration_sakura.sql / _r4 / _r6 / _r7 / _r8 / _r9 / _r12 / _r15
--       / _r17 が適用済み。
--
-- 問題（ラウンド8・運営 S-2）:
-- これまで staff_unassign_and_unpay（R12）は、ゾーン予約を未払いに戻すと
-- 来場状態にかかわらず割り当てた席を解放していた（seat_state 削除＋
-- items の seatId を空に）。R17 以降は受付（チェックイン）でも席が決まる
-- ため、「来場済み・未払いに戻す」操作をすると、お客様が実際に座っている
-- 可能性がある席の押さえだけが消え、後から別の予約の支払い割当で同じ席が
-- 回ってしまう（二重割当）リスクがあった。
--
-- 変更内容:
-- staff_unassign_and_unpay を作り直し、来場済み（checked_in = true かつ
-- status = 'active'）の予約については席を解放しない:
--   - seat_state は削除せず 'reserved' に戻す（未払いなので 'sold' ではない）
--   - items の seatId はそのまま保持する
--   - paid = false だけを変更する
-- 来場していない予約については従来どおり（席を解放して未割当に戻す）。
-- 席を解放したい場合は、先に来場を取り消してから未払いに戻すか、
-- 予約自体をキャンセルする（キャンセルは従来どおり席を解放する）。
-- 再度「支払い済みに」するときは、保持された同じ席がそのまま確定する
-- （R17 の staff_assign_and_pay の「自分の席」扱いで sold に戻る）。
--
-- 既存データへの影響: なし（関数の作り直しのみ）。
-- 適用順序: クライアント（R21 のコード）より先に本マイグレーションを
-- 適用すること。逆順でもエラーにはならないが、適用するまでの間クラウド
-- では旧挙動（来場済みでも席が解放される）が残る。
-- ============================================================================

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

  -- R21: 来場済みの予約は、未払いに戻しても席を解放しない。
  -- 席は 'reserved' として保持し、支払い状態だけを戻す
  if v_row.checked_in and v_row.status = 'active' then
    update public.seat_state
       set state = 'reserved'
     where seat_id in (
       select e ->> 'seatId'
         from jsonb_array_elements(v_row.items) e
        where coalesce(e ->> 'seatId', '') <> ''
     );

    update public.reservations
       set paid = false
     where id = p_id;

    return jsonb_build_object('ok', true, 'seatsKept', true);
  end if;

  -- 従来どおり: 割り当てた席を解放し（seat_state 削除）、items の seatId を
  -- 空に戻して未払いにする。すでに未払い・未割当なら冪等に成功
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

  return jsonb_build_object('ok', true, 'seatsKept', false);
end;
$$;

grant execute on function public.staff_unassign_and_unpay(text, uuid)
  to anon, authenticated;
