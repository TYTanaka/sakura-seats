-- ============================================================================
-- sakura-seats 追加マイグレーション (R15): 電話番号の厳格チェック
-- Supabase ダッシュボードの SQL Editor でそのまま実行できる冪等なスクリプト。
-- 前提: migration_sakura.sql / _r4 / _r6 / _r7 / _r8 / _r9 / _r12 が適用済み。
--
-- 目的（2026-11-03 のオーナー報告: 090-0000-0000 のような実在しない番号でも
-- 予約できてしまう）:
-- これまでサーバ側（book_zone / book_seats）は電話番号が「空でないこと」しか
-- 見ておらず、形式チェックはクライアント側の桁数チェック（10〜11桁）だけ
-- だった。R15 では日本の電話番号規則＋明らかな偽番号パターンを、クライアント
-- （isValidPhone）とサーバで「まったく同じ規則」にして両方で弾く。
--
-- 規則（正規化後の数字列に対する判定。クライアント normalizePhone と一致）:
--   正規化: 全角数字→半角、数字以外を除去、+81形式（81+10桁）は 0 始まりへ。
--   形式:
--     - 11桁: 携帯 070/080/090、IP電話 050
--     - 10桁: 固定電話・フリーダイヤル等（0 + [1-9] + 8桁）。
--       ただし携帯/IP のプレフィックス（050/070/080/090）で始まる10桁は
--       「桁落ち」とみなし不可。0800 フリーダイヤル（0800 + 6桁）は例外として可。
--   偽番号パターン（形式が合っても不可）:
--     - 全桁同一（例: 11111111111）
--     - 0 が6桁以上連続（例: 09000000000）
--     - 8桁以上の連番（昇順/降順。例: 09012345678、08098765432）
--
-- 強制の仕組み:
--   予約系 RPC（book_zone / book_seats）は巨大なため再定義せず、
--   reservations への BEFORE INSERT トリガで一元的に弾く。これにより
--   book_zone / book_seats / 将来の INSERT 経路すべてに同じ規則が効く。
--   トリガは INSERT のみ（UPDATE では再検証しない）: スタッフの支払い
--   トグル等の更新が、既存予約の電話番号を理由に失敗することはない。
--
--   例外として、当日販売（staff_sell）は電話番号を持たない（phone = '' で
--   INSERT する）ため、kind = 'door' かつ電話番号が空の行は検証対象外とする。
--   door でも電話番号が入っている行は通常どおり検証する。
--
--   弾くときは errcode P0001 で 'PHONE_INVALID: 電話番号をご確認ください'
--   を投げる（book_zone / book_seats の unique_violation リトライには
--   引っかからず、そのままクライアントへ伝わる）。
--
-- 既存データ: 適用時点で reservations は 0 件（本番リセット済み）のため、
-- 既存行がトリガで問題になることはない（トリガは新規 INSERT のみ）。
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. sakura_valid_phone: 電話番号の厳格チェック（クライアント isValidPhone と
--    同一規則）。内部ヘルパーのため anon / authenticated へは公開しない。
-- ----------------------------------------------------------------------------
create or replace function public.sakura_valid_phone(p_phone text)
returns boolean
language plpgsql
immutable
set search_path = public
as $$
declare
  v_digits text;
begin
  if p_phone is null then
    return false;
  end if;

  -- 正規化（クライアント normalizePhone と同じ手順）
  v_digits := translate(p_phone, '０１２３４５６７８９', '0123456789');
  v_digits := regexp_replace(v_digits, '[^0-9]', '', 'g');
  if v_digits ~ '^81[0-9]{10}$' then
    v_digits := '0' || substr(v_digits, 3);
  end if;

  -- 明らかな偽番号パターン
  if v_digits ~ '^([0-9])\1+$' then
    return false;  -- 全桁同一
  end if;
  if v_digits like '%000000%' then
    return false;  -- 0 が6桁以上連続
  end if;
  if v_digits like '%01234567%' or v_digits like '%12345678%'
     or v_digits like '%23456789%' or v_digits like '%98765432%'
     or v_digits like '%87654321%' or v_digits like '%76543210%' then
    return false;  -- 8桁以上の連番（昇順・降順）
  end if;

  -- 形式
  if length(v_digits) = 11 then
    return v_digits ~ '^0(70|80|90)[0-9]{8}$' or v_digits ~ '^050[0-9]{8}$';
  end if;
  if length(v_digits) = 10 then
    -- 携帯/IP プレフィックスの桁落ちは不可（0800 フリーダイヤルは例外）
    if v_digits ~ '^0(50|70|80|90)' and v_digits !~ '^0800' then
      return false;
    end if;
    return v_digits ~ '^0[1-9][0-9]{8}$';
  end if;
  return false;
end;
$$;

revoke execute on function public.sakura_valid_phone(text)
  from public, anon, authenticated;

-- ----------------------------------------------------------------------------
-- 2. INSERT トリガ: オンライン予約の電話番号をサーバ側でも検証する。
--    当日販売（kind='door'・電話番号なし）だけは対象外。
--    トリガ関数は SECURITY DEFINER にする: 検証用ヘルパー（実行権限を
--    公開していない sakura_valid_phone）を、INSERT したロールの権限に
--    依存せず呼べるようにするため（入力は NEW のみで呼び出し側の影響を
--    受けない）。PGlite 検証で非オーナーロールからの INSERT でも
--    PHONE_INVALID が正しく返ることを確認済み。
-- ----------------------------------------------------------------------------
create or replace function public.sakura_check_reservation_phone()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.kind = 'door' and coalesce(trim(new.phone), '') = '' then
    return new;
  end if;
  if not public.sakura_valid_phone(new.phone) then
    raise exception 'PHONE_INVALID: 電話番号をご確認ください' using errcode = 'P0001';
  end if;
  return new;
end;
$$;

revoke execute on function public.sakura_check_reservation_phone()
  from public, anon, authenticated;

drop trigger if exists trg_reservations_phone_check on public.reservations;
create trigger trg_reservations_phone_check
  before insert on public.reservations
  for each row execute function public.sakura_check_reservation_phone();
