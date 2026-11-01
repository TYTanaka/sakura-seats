-- ============================================================================
-- sakura-seats 追加マイグレーション (R4): 販売者（seller）記録 + 本人キャンセル
-- Supabase ダッシュボードの SQL Editor でそのまま実行できる冪等なスクリプト。
-- 前提: migration_sakura.sql が適用済みであること。
--
--
-- このスクリプトは新しいクライアントのデプロイ「前」に適用してよい。
-- 旧クライアントは適用後もそのまま動作する。理由:
-- 1. reservations.seller は NULL 既定の追加カラム。旧クライアントは
-- このカラムを参照しないため無影響（既存行は NULL になる）。
-- 2. staff_sell は既存の3引数シグネチャを残し、4引数のオーバーロードを
-- 追加する。3引数版は seller=NULL で4引数版に委譲するよう置き換える
-- ので、旧クライアントの呼び出し・料金計算・ロック挙動は従来と同一。
-- 新クライアントだけが seller を渡せる。
-- 3. staff_get_all の戻り値は jsonb のまま（SQL レベルの戻り型は不変）
-- なので CREATE OR REPLACE で差し替えでき、既存の GRANT も保持される。
-- reservations の各行に 'seller' キーが増えるだけであり、旧クライアント
-- の行マッピング（mapReservationRow）は未知のキーを無視する。
-- 4. cancel_reservation は新規 RPC の追加のみ。既存 RPC は変更しない。
-- なお seller はスタッフ専用情報のため、lookup_reservation と
-- get_public_state の戻り値には含めない（意図的に非公開）。
--
--
-- ビジネス上の結果は例外ではなく JSON で返す（クライアントは ok/result で分岐）:
-- { "ok": true, "result": "OK", "code": "SK-0001"}
-- { "ok": false, "result": "NOT_FOUND"} 番号・電話が一致する予約がない
-- （番号違いか電話違いかは明かさない）
-- { "ok": false, "result": "ALREADY_CANCELLED"} 既にキャンセル済み
-- { "ok": false, "result": "PAID_LOCKED"} 支払い済み（返金対応が絡むため不可）
-- { "ok": false, "result": "CHECKED_IN_LOCKED"} 受付（来場）済み
-- { "ok": false, "result": "TOO_LATE"} キャンセル期限を過ぎている
-- 判定の優先順位は上記の並び順:
-- NOT_FOUND → ALREADY_CANCELLED → PAID_LOCKED → CHECKED_IN_LOCKED → TOO_LATE
-- キャンセル期限: app_config.booking_deadline が設定されていればそれを優先し、
-- 無ければ公演日時（performance.date + performance.time）を使う。公演の日時は
-- 会場（横浜）の現地時刻なので Asia/Tokyo として解釈する（DB のセッション
-- タイムゾーンに依存させない）。期限ちょうど（now = 期限）はキャンセル不可。
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. 販売者カラム
-- NULL = 通常のWeb予約（または販売者を記録していない当日販売）。
-- 値が入るのは新クライアント経由の staff_sell（手売り・当日販売）のみ。
-- ---------------------------------------------------------------------------

alter table public.reservations
add column if not exists seller text;

-- ---------------------------------------------------------------------------
-- 2. 内部ヘルパー: 電話番号の正規化
-- クライアントの normalizePhone と同じ規則:
-- 全角数字（０-９）を半角化し、数字以外（ハイフン・空白など）を除去する。
-- cancel_reservation ではクライアント正規化済みの値が来る前提だが、
-- 旧データ（ハイフン入り等で保存された電話）や直接呼び出しにも耐えるよう
-- サーバ側でも保存値・入力値の両方を正規化して比較する。
-- ---------------------------------------------------------------------------

create or replace function public.sakura_normalize_phone(p_phone text)
returns text
language sql
immutable
as $$
select regexp_replace(
translate(coalesce(p_phone, ''),
'０１２３４５６７８９',
'0123456789'),
'[^0-9]', '', 'g'
);
$$;

-- ---------------------------------------------------------------------------
-- 3. staff_sell: 販売者対応
-- 4引数オーバーロードが実体。料金再計算・app_config 行ロック・採番リトライは
-- 従来の staff_sell と同一で、insert に seller を加えただけ。
-- 販売者は前後の空白を取り除き、空文字は NULL にする。
-- ---------------------------------------------------------------------------

create or replace function public.staff_sell(
p_passcode text,
p_name text,
p_items jsonb,
p_seller text
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
v_attempt int:= 0;
v_lock int;
v_seller text:= nullif(trim(coalesce(p_seller, '')), '');
begin
perform public.sakura_check_passcode(p_passcode);
select 1 into v_lock from public.app_config where id = 1 for update;

v_priced:= public.sakura_price_items(p_items, false);

loop
v_attempt:= v_attempt + 1;
v_code:= public.sakura_next_code();
begin
insert into public.reservations (code, name, phone, note, items, amount, kind, paid, seller)
values (
v_code,
coalesce(nullif(trim(p_name), ''), '当日'),
'',
'',
v_priced -> 'items',
(v_priced ->> 'amount')::int,
'door',
true,
v_seller
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

-- 既存の3引数版は互換のため残し、seller=NULL で4引数版に委譲する。
-- 旧クライアントはこのシグネチャを呼び続ける（挙動は従来と同一）。
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
begin
return public.staff_sell(p_passcode, p_name, p_items, null::text);
end;
$$;

-- ---------------------------------------------------------------------------
-- 4. staff_get_all: reservations の各行に seller を追加する。
-- 戻り型は jsonb のまま変わらないため CREATE OR REPLACE で足り、
-- DROP は不要（DROP すると GRANT が消え、付け直すまでの窓も生じる）。
-- seller はこのスタッフ専用 RPC でのみ返す。
-- ---------------------------------------------------------------------------

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

-- ---------------------------------------------------------------------------
-- 5. 本人キャンセル（お客様向け RPC）
-- 予約番号 + 電話番号の一致で本人確認し（lookup_reservation と同じ作法）、
-- 条件を満たす場合のみキャンセルして席を解放する。
-- 席の解放は staff_update_reservation のキャンセル経路と同一セマンティクス:
-- status を 'cancelled' にし、明細の各 seatId を seat_state から削除する。
-- 行を FOR UPDATE でロックするため、同時実行されても二重成功しない
-- （後続はコミット後の状態を読み直し ALREADY_CANCELLED になる）。
-- ---------------------------------------------------------------------------

create or replace function public.cancel_reservation(p_code text, p_phone text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
v_row public.reservations%rowtype;
v_phone text;
v_deadline timestamptz;
v_perf jsonb;
v_limit timestamptz;
v_item jsonb;
begin
v_phone:= public.sakura_normalize_phone(p_phone);

-- 入力が空なら探索するまでもなく NOT_FOUND（情報は漏らさない）
if coalesce(p_code, '') = '' or v_phone = '' then
return jsonb_build_object('ok', false, 'result', 'NOT_FOUND');
end if;

-- 予約番号は完全一致、電話は正規化して比較する。
select * into v_row
from public.reservations
where code = p_code
and public.sakura_normalize_phone(phone) = v_phone
for update;
if not found then
return jsonb_build_object('ok', false, 'result', 'NOT_FOUND');
end if;

if v_row.status = 'cancelled' then
return jsonb_build_object('ok', false, 'result', 'ALREADY_CANCELLED');
end if;

-- 支払い済みは返金・精算が絡むため本人キャンセル不可（スタッフ対応）
if v_row.paid then
return jsonb_build_object('ok', false, 'result', 'PAID_LOCKED');
end if;

-- 受付（来場）済みは不可
if v_row.checked_in then
return jsonb_build_object('ok', false, 'result', 'CHECKED_IN_LOCKED');
end if;

-- キャンセル期限: 予約締切があればそれ、無ければ公演日時（Asia/Tokyo 解釈）
select booking_deadline, performance
into v_deadline, v_perf
from public.app_config where id = 1;

v_limit:= v_deadline;
if v_limit is null
and v_perf is not null
and coalesce(v_perf ->> 'date', '') <> '' then
begin
v_limit:= ((v_perf ->> 'date')
|| ' '
|| coalesce(nullif(v_perf ->> 'time', ''), '00:00'))::timestamp
at time zone 'Asia/Tokyo';
exception when others then
-- 公演日時が解釈できない設定ではフォールバック期限なし（締切のみで判定）
v_limit:= null;
end;
end if;

if v_limit is not null and now() >= v_limit then
return jsonb_build_object('ok', false, 'result', 'TOO_LATE');
end if;

-- キャンセル実行（staff_update_reservation のキャンセル経路と同一処理）
update public.reservations
set status = 'cancelled'
where id = v_row.id;

for v_item in select * from jsonb_array_elements(v_row.items) loop
delete from public.seat_state where seat_id = (v_item ->> 'seatId');
end loop;

return jsonb_build_object('ok', true, 'result', 'OK', 'code', v_row.code);
end;
$$;

-- ---------------------------------------------------------------------------
-- RPC の実行権限（anon）
-- 既存シグネチャの GRANT は CREATE OR REPLACE で保持されるため付け直さない。
-- 新規の2つ（staff_sell 4引数版 / cancel_reservation）だけ付与する。
-- ---------------------------------------------------------------------------

grant execute on function public.staff_sell(text, text, jsonb, text) to anon;
grant execute on function public.cancel_reservation(text, text) to anon;
