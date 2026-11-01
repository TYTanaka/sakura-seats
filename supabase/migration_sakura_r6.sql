-- ============================================================================
-- sakura-seats 追加マイグレーション (R6): キャンセルの取り消し（復旧）
-- Supabase ダッシュボードの SQL Editor でそのまま実行できる冪等なスクリプト。
-- 前提: migration_sakura.sql / migration_sakura_r4.sql が適用済みであること。
--
-- このファイルを SQL Editor に貼って実行するだけです。
-- 新クライアントのデプロイ「前」でも「後」でも適用してよい。理由:
-- 1. 追加するのは新規 RPC（staff_uncancel_reservation）だけで、既存の
-- テーブル・RPC は一切変更しない。旧クライアントは無影響。
-- 2. 未適用の間、新クライアントの「キャンセルを取り消す」は RPC が
-- 見つからないエラーを受け、画面に「サーバ更新（migration_sakura_r6 の
-- 適用）後に使えるようになります」と表示される（汎用エラーに化けない）。
--
-- ビジネス上の結果は例外ではなく JSON で返す（cancel_reservation と同じ作法）:
-- { "ok": true, "result": "OK", "code": "SK-0001"}
-- { "ok": false, "result": "NOT_FOUND"} その予約番号の予約がない
-- { "ok": false, "result": "NOT_CANCELLED"} キャンセル済みではない
-- { "ok": false, "result": "SEAT_TAKEN"} 席の一部が別の有効な予約に
-- 使われているため復旧できない
-- パスコード違いは他の staff_* RPC と同様に例外（UNAUTHORIZED）で返す。
--
-- 復旧時の seat_state は予約の支払い状態に合わせる:
-- 支払済みなら 'sold'、未払いなら 'reserved'（book_seats / staff_sell の
-- 書き込みと同一セマンティクス）。キャンセル時に seat_state から削除された
-- 席を、ここで再登録する。
-- 競合対策: book_seats / staff_sell と同じく app_config 行を FOR UPDATE で
-- ロックしてから判定・更新するため、復旧と新規予約が同時に走っても
-- 同じ席を二重に占有することはない。
-- ============================================================================

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
-- 予約が使っている。キャンセル済みの自席は seat_state から消えている
-- はずなので、存在 = 他者に取られている、と判定できる。
select ss.seat_id into v_conflict
from public.seat_state ss
where ss.seat_id in (
select elem ->> 'seatId'
from jsonb_array_elements(v_row.items) as elem
)
limit 1;
if v_conflict is not null then
return jsonb_build_object('ok', false, 'result', 'SEAT_TAKEN');
end if;

update public.reservations
set status = 'active'
where id = v_row.id;

for v_item in select * from jsonb_array_elements(v_row.items) loop
insert into public.seat_state (seat_id, state)
values (
v_item ->> 'seatId',
case when v_row.paid then 'sold' else 'reserved' end
);
end loop;

return jsonb_build_object('ok', true, 'result', 'OK', 'code', v_row.code);
end;
$$;

-- ---------------------------------------------------------------------------
-- RPC の実行権限（anon）
-- 新規 RPC のみ付与する（既存の GRANT は変更しない）。
-- ---------------------------------------------------------------------------

grant execute on function public.staff_uncancel_reservation(text, text) to anon;
