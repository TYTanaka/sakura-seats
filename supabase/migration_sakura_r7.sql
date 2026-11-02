-- ============================================================================
-- sakura-seats 追加マイグレーション (R7): QR受付をサーバ検証式にする
-- Supabase ダッシュボードの SQL Editor でそのまま実行できる冪等なスクリプト。
-- 前提: migration_sakura.sql / migration_sakura_r4.sql /
--       migration_sakura_r6.sql が適用済みであること。
--
-- 背景（旧方式の問題）:
-- 旧 QR は予約番号（SK-0001 のような連番）そのものを埋め込んでおり、
-- スキャン側はスタッフ端末に読み込み済みのデータと突き合わせるだけだった。
-- 連番は推測できるため、誰でも番号入り QR を印刷すれば偽装できてしまう。
-- また QR に公演の情報も使用済みかどうかも含まれず、複数公演では使えない。
--
-- 新方式:
-- - 予約ごとに推測不能なトークン（128bit 乱数の base64url）を発行し、
--   QR には「sk1: + トークン」だけを入れる（予約番号は入れない）。
-- - 受付は staff_check_in RPC がサーバで検証し、原子的に受付を記録する:
--     NOT_FOUND          トークンが一致する予約が無い（偽造・改ざん）
--     WRONG_PERFORMANCE  予約時点の公演スナップショットが現在の公演設定と違う
--     CANCELLED          キャンセル済みの予約
--     ALREADY_CHECKED_IN 受付済み（元の受付日時を返す・二重受付しない）
--     OK                 受付を記録した
--   判定の優先順位は上記の並び順。結果は例外ではなく JSON { ok, result }
--   で返す（cancel_reservation と同じ作法）。パスコード違いは例外。
-- - 支払い（paid）は受付では絶対に変更しない。支払いの記録は従来どおり
--   スタッフの手動操作（staff_update_reservation）のみで行う。
--
-- 適用タイミング: 新クライアントのデプロイ「前」でも「後」でもよい。
-- - 未適用の間、新クライアントの QR 受付は「サーバ更新（migration_sakura_r7
--   の適用）後に使えるようになります」と表示して予約番号の手入力に誘導する。
--   予約自体は従来どおり可能で、完了画面の QR は番号表示にフォールバックする
--   （book_seats / staff_sell の返却に token が無い場合の想定済み動作）。
-- - 適用後すぐ旧クライアントも従来どおり動作する: 追加カラムは NULL 既定で、
--   既存 RPC のシグネチャは変えず、返却 JSON にキーが増えるだけ
--   （旧クライアントの行マッピングは未知のキーを無視する）。
--
-- 既存行のバックフィルについて:
-- 現在の予約行はすべてテストデータである。既存行にもトークンを発行し、
-- 公演スナップショットは「現在の app_config の公演」を正として埋める
-- （＝移行時点の公演の予約として扱う）。受付済みの既存行の checked_in_at は
-- 正確な受付時刻が残っていないため、申込日時（created_at）で近似する。
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. カラム追加（すべて NULL 既定・冪等）
-- ---------------------------------------------------------------------------

alter table public.reservations
add column if not exists qr_token text;

alter table public.reservations
add column if not exists checked_in_at timestamptz;

alter table public.reservations
add column if not exists perf_date text;

alter table public.reservations
add column if not exists perf_name text;

-- ---------------------------------------------------------------------------
-- 2. トークン生成ヘルパー
-- pgcrypto の gen_random_bytes で 16 バイト（128bit）を引、
-- base64url（+→-, /→_, 末尾の = を除去）にして 22 文字で返す。
-- クライアント側 generateQrToken と同じ形式。
-- ---------------------------------------------------------------------------

create or replace function public.sakura_new_qr_token()
returns text
language sql
volatile
set search_path = public, extensions
as $$
select replace(
replace(
translate(encode(gen_random_bytes(16), 'base64'), '+/', '-_'),
'=', ''),
chr(10), '');
$$;

-- ---------------------------------------------------------------------------
-- 3. 既存行のバックフィル（値が無い行だけ・再実行しても安全）
-- ---------------------------------------------------------------------------

update public.reservations
set qr_token = public.sakura_new_qr_token()
where qr_token is null;

update public.reservations r
set perf_date = (select performance ->> 'date' from public.app_config where id = 1),
perf_name = (select performance ->> 'name' from public.app_config where id = 1)
where r.perf_date is null or r.perf_name is null;

-- 受付済みなのに受付日時が無い既存行は、申込日時で近似して埋める
update public.reservations
set checked_in_at = created_at
where checked_in and checked_in_at is null;

-- トークンの一意性（NULL は対象外＝未発行行が複数あってもよい）
create unique index if not exists reservations_qr_token_uidx
on public.reservations (qr_token);

-- ---------------------------------------------------------------------------
-- 4. book_seats: トークン発行 + 公演スナップショット記録 + token を返却
-- 料金再計算・行ロック・採番リトライは従来と同一。
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
v_attempt int:= 0;
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

v_priced:= public.sakura_price_items(p_items, true);

-- 予約時点の公演スナップショット（QR受付での公演照合用）
select performance into v_perf from public.app_config where id = 1;

loop
v_attempt:= v_attempt + 1;
v_code:= public.sakura_next_code();
v_token:= public.sakura_new_qr_token();
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

-- ---------------------------------------------------------------------------
-- 5. staff_sell: 4引数版（実体）にトークン発行 + 公演スナップショットを追加。
-- 3引数版は委譲ラッパーのまま（CREATE OR REPLACE で再掲し意図を保つ）。
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
v_token text;
v_perf jsonb;
v_item jsonb;
v_attempt int:= 0;
v_lock int;
v_seller text:= nullif(trim(coalesce(p_seller, '')), '');
begin
perform public.sakura_check_passcode(p_passcode);
select 1 into v_lock from public.app_config where id = 1 for update;

v_priced:= public.sakura_price_items(p_items, false);

select performance into v_perf from public.app_config where id = 1;

loop
v_attempt:= v_attempt + 1;
v_code:= public.sakura_next_code();
v_token:= public.sakura_new_qr_token();
begin
insert into public.reservations
(code, name, phone, note, items, amount, kind, paid, seller, qr_token, perf_date, perf_name)
values (
v_code,
coalesce(nullif(trim(p_name), ''), '当日'),
'',
'',
v_priced -> 'items',
(v_priced ->> 'amount')::int,
'door',
true,
v_seller,
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
values (v_item ->> 'seatId', 'sold');
end loop;

return jsonb_build_object(
'code', v_code,
'amount', (v_priced ->> 'amount')::int,
'token', v_token
);
end;
$$;

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
-- 6. staff_get_all: 行に checkedInAt と公演スナップショットを足す。
-- qr_token は含めない（スタッフ一覧に推測不能値を配る必要はない。
-- 受付は「提示されたトークンを staff_check_in で検証」で完結する）。
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

-- ---------------------------------------------------------------------------
-- 7. lookup_reservation: 本人確認（番号+電話）済みの経路なので、
-- 自分の QR を再表示できるよう qrToken も返すようになる。
-- あわせて checkedInAt と公演スナップショットも返す。
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
'qrToken', v_row.qr_token,
'checkedInAt', v_row.checked_in_at,
'perfDate', v_row.perf_date,
'perfName', v_row.perf_name,
'performance', v_perf
);
end;
$$;

-- ---------------------------------------------------------------------------
-- 8. staff_update_reservation: 支払い・来場・ステータスの手動変更は従来
-- どおり。来場フラグに合わせて checked_in_at も同期する（受付日時の表示が
-- 手動チェックインでも正しくなるように）。paid の変更はここ（スタッフの
-- 手動操作）でのみ可能で、staff_check_in は paid を触らない。
-- ---------------------------------------------------------------------------

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
checked_in_at = case
when p_checked_in then coalesce(checked_in_at, now())
else null
end,
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

-- ---------------------------------------------------------------------------
-- 9. staff_check_in（新規）: QR受付のサーバ検証。
-- app_config 行ロックで新規予約・復旧と直列化し、対象行も FOR UPDATE で
-- ロックするため、同じ QR の同時スキャンでも二重受付にならない。
-- 支払い（paid）はここでは変更しない（受付＝来場の記録のみ）。
-- ---------------------------------------------------------------------------

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
v_summary:= jsonb_build_object(
'code', v_row.code,
'name', v_row.name,
'items', v_row.items,
'amount', v_row.amount,
'kind', v_row.kind,
'paid', v_row.paid,
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

v_summary:= v_summary || jsonb_build_object(
'checkedInAt', v_row.checked_in_at,
'paid', v_row.paid
);

return v_summary || jsonb_build_object('ok', true, 'result', 'OK');
end;
$$;

-- ---------------------------------------------------------------------------
-- RPC の実行権限（anon）
-- 既存シグネチャの GRANT は CREATE OR REPLACE で保持されるため付け直さない。
-- 新規の staff_check_in だけ付与する。
-- ---------------------------------------------------------------------------

grant execute on function public.staff_check_in(text, text) to anon;
