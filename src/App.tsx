import { useState } from 'react'
import { ALL_SEATS } from './data/seats'
import {
  formatPerformanceWhen,
  formatTicketTypes,
  seatStatus,
  type Performance,
} from './lib/logic'
import { StoreProvider, useStore } from './lib/store'
import AudienceBook from './components/AudienceBook'
import Staff from './components/Staff'

type View = 'book' | 'staff'

function TopHeader({ perf, onStaff }: { perf: Performance; onStaff: () => void }) {
  const { data } = useStore()
  const available = ALL_SEATS.filter((s) => seatStatus(data, s.id) === 'available').length
  return (
    <header className="site-header">
      <p className="venue-line">戸塚区民文化センター さくらプラザ・ホール</p>
      <h1 className="site-title">{perf.name}</h1>
      <p className="site-when">{formatPerformanceWhen(perf)}</p>
      <p className="site-meta">
        料金：{formatTicketTypes(perf)}（当日現金払い） ／ 空席 {available}席
      </p>
      {perf.priceNote && <p className="site-note">※{perf.priceNote}</p>}
      {perf.note && <p className="site-note">{perf.note}</p>}
      <button type="button" className="staff-link" onClick={onStaff}>
        スタッフ用
      </button>
    </header>
  )
}

function Shell() {
  const { data } = useStore()
  const [view, setView] = useState<View>('book')
  const perf = data.performance

  return (
    <div className="app-shell">
      <TopHeader perf={perf} onStaff={() => setView('staff')} />
      <main className="main">
        {view === 'book' ? (
          <AudienceBook perf={perf} />
        ) : (
          <Staff onExit={() => setView('book')} />
        )}
      </main>
      <footer className="site-footer">
        <p>
          指定席予約（試作版） ― 座席表から席を選んで予約し、当日は受付で現金でお支払いいただきます。
        </p>
        <p className="muted small">
          このページは試作版です。予約データはこの端末内のみに保存されます。
        </p>
      </footer>
    </div>
  )
}

export default function App() {
  return (
    <StoreProvider>
      <Shell />
    </StoreProvider>
  )
}
