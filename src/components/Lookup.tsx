import { useState } from 'react'
import { seatById } from '../data/seats'
import {
  formatPerformanceWhen,
  formatYen,
  reservationTypeSummary,
  type Reservation,
} from '../lib/logic'
import { useStore } from '../lib/store'
import ReservationQr from './ReservationQr'

/**
 * 予約確認ページ: 予約番号 + 電話番号で自分の予約を表示する。
 * クラウドモードでは lookup_reservation RPC、ローカルモードでは端末内データを照合する。
 */
export default function Lookup({ onBack }: { onBack: () => void }) {
  const { data, mode, lookupReservation } = useStore()
  const [code, setCode] = useState('')
  const [phone, setPhone] = useState('')
  const [error, setError] = useState('')
  const [searching, setSearching] = useState(false)
  const [found, setFound] = useState<Reservation | null>(null)

  const handleSearch = async (e: React.FormEvent) => {
    e.preventDefault()
    setError('')
    setFound(null)
    if (!code.trim() || !phone.trim()) {
      setError('予約番号と電話番号を入力してください')
      return
    }
    setSearching(true)
    try {
      const result = await lookupReservation(code, phone)
      if (!result) {
        setError('予約が見つかりませんでした。予約番号と電話番号をご確認ください')
        return
      }
      setFound(result)
    } catch {
      setError('検索に失敗しました。しばらくしてからもう一度お試しください')
    } finally {
      setSearching(false)
    }
  }

  const perf = data.performance

  return (
    <section className="card lookup-card">
      <button type="button" className="btn btn-ghost back-btn" onClick={onBack}>
        ← 予約画面へ戻る
      </button>
      <h2>予約確認</h2>
      <p className="muted">
        予約完了画面でお伝えした予約番号（SK-XXXX）と、申込時に入力した電話番号で
        ご予約の内容を確認できます。
      </p>
      {mode === 'local' && (
        <p className="muted small">
          ※試作版のため、この端末で申し込んだ予約のみ確認できます。
        </p>
      )}
      <form onSubmit={handleSearch}>
        <label className="field">
          <span>予約番号</span>
          <input
            type="text"
            value={code}
            onChange={(e) => setCode(e.target.value)}
            placeholder="例：SK-0001"
            autoComplete="off"
          />
        </label>
        <label className="field">
          <span>電話番号</span>
          <input
            type="tel"
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
            placeholder="例：090-0000-0000"
            autoComplete="tel"
          />
        </label>
        {error && (
          <p className="error-text" data-lookup-error>
            {error}
          </p>
        )}
        <button type="submit" className="btn btn-primary btn-block" disabled={searching}>
          {searching ? '検索中…' : '予約を確認する'}
        </button>
      </form>

      {found && found.cancelled && (
        <div className="lookup-result lookup-cancelled" data-lookup-cancelled>
          <p className="error-text">この予約はキャンセル済みです</p>
          <p className="muted">
            予約番号 {found.id} のご予約は、すでにキャンセルされています。
            お心当たりがない場合や、再度ご予約をご希望の場合は、主催者までご連絡ください。
          </p>
        </div>
      )}

      {found && !found.cancelled && (
        <div className="lookup-result" data-lookup-result>
          <p className="done-badge">予約が見つかりました</p>
          <p className="reservation-code">{found.id}</p>
          <ReservationQr code={found.id} />
          <dl className="detail-list">
            <div>
              <dt>公演</dt>
              <dd>
                {perf.name}
                <br />
                {formatPerformanceWhen(perf)}
              </dd>
            </div>
            <div>
              <dt>お名前</dt>
              <dd>{found.name} 様</dd>
            </div>
            <div>
              <dt>座席</dt>
              <dd>
                {found.items.map((item) => (
                  <span key={item.seatId} className="detail-seat-line">
                    {seatById(item.seatId).label}（{item.typeName} {formatYen(item.price)}）
                  </span>
                ))}
              </dd>
            </div>
            <div>
              <dt>券種内訳</dt>
              <dd>{reservationTypeSummary(found)}</dd>
            </div>
            <div>
              <dt>合計</dt>
              <dd className="detail-total">{formatYen(found.amount)}</dd>
            </div>
            <div>
              <dt>お支払い</dt>
              <dd>{found.paid ? '支払済みです' : '当日、受付で現金でお支払いください'}</dd>
            </div>
          </dl>
          <div className="notice-box">
            <p>当日は受付でお名前と予約番号をお伝えください。</p>
            <p>変更・キャンセルは主催者までご連絡ください。</p>
          </div>
        </div>
      )}
    </section>
  )
}
