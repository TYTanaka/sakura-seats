import { SEATS_UNDECIDED_NOTICE } from '../lib/zones'

/**
 * 「座席はお支払い時、または当日の受付時に確定します」をフレーズの塊で出す（R31）。
 * 読点の前後をそれぞれ .u-nowrap にし、塊の途中では改行しない。
 * 完了画面・予約確認・控えで文面と改行のされ方を揃えるために共用する。
 */
export default function SeatsNotice() {
  const idx = SEATS_UNDECIDED_NOTICE.indexOf('、')
  if (idx < 0) return <>{SEATS_UNDECIDED_NOTICE}</>
  return (
    <>
      <span className="u-nowrap">{SEATS_UNDECIDED_NOTICE.slice(0, idx + 1)}</span>
      <span className="u-nowrap">{SEATS_UNDECIDED_NOTICE.slice(idx + 1)}</span>
    </>
  )
}
