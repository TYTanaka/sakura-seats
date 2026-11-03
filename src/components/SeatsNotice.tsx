import { SEATS_UNDECIDED_NOTICE } from '../lib/zones'

/**
 * 「座席はお支払い時、または当日の受付時に確定します」をフレーズの塊で出す（R31）。
 * 塊の途中では改行しない。完了画面・予約確認・控えで文面と改行の
 * され方を揃えるために共用する。
 *
 * R35: 塊は3つに分ける。後半を1塊（15文字）にすると、予約確認の
 * 明細のような狭い列（「大」360pxで約220px）からはみ出して
 * 右端で切れたため、「受付時に」で一区切り増やした。
 */
export default function SeatsNotice() {
  const idx = SEATS_UNDECIDED_NOTICE.indexOf('、')
  if (idx < 0) return <>{SEATS_UNDECIDED_NOTICE}</>
  const head = SEATS_UNDECIDED_NOTICE.slice(0, idx + 1)
  const rest = SEATS_UNDECIDED_NOTICE.slice(idx + 1)
  const idx2 = rest.indexOf('受付時に')
  if (idx2 < 0) {
    return (
      <>
        <span className="u-nowrap">{head}</span>
        <span className="u-nowrap">{rest}</span>
      </>
    )
  }
  const mid = rest.slice(0, idx2 + '受付時に'.length)
  const tail = rest.slice(idx2 + '受付時に'.length)
  return (
    <>
      <span className="u-nowrap">{head}</span>
      <span className="u-nowrap">{mid}</span>
      <span className="u-nowrap">{tail}</span>
    </>
  )
}
