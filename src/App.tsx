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
import Lookup from './components/Lookup'
import Staff from './components/Staff'

type View = 'book' | 'lookup' | 'staff'

function TopHeader({
  perf,
  onLookup,
  onStaff,
}: {
  perf: Performance
  onLookup: () => void
  onStaff: () => void
}) {
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
      <div className="header-actions">
        <button type="button" className="staff-link" onClick={onLookup}>
          予約確認
        </button>
        <button type="button" className="staff-link" onClick={onStaff}>
          スタッフ用
        </button>
      </div>
    </header>
  )
}

function Shell() {
  const { data, mode, ready, loadError, retryLoad } = useStore()
  const [view, setView] = useState<View>('book')
  const perf = data.performance

  if (mode === 'cloud' && loadError) {
    return (
      <div className="app-shell">
        <main className="main">
          <section className="card">
            <h2>接続できませんでした</h2>
            <p className="muted">{loadError}</p>
            <button type="button" className="btn btn-primary btn-block" onClick={retryLoad}>
              再読み込みする
            </button>
          </section>
        </main>
      </div>
    )
  }

  if (mode === 'cloud' && !ready) {
    return (
      <div className="app-shell">
        <p className="loading-note">読み込み中…♪</p>
      </div>
    )
  }

  return (
    <div className="app-shell">
      <TopHeader
        perf={perf}
        onLookup={() => setView('lookup')}
        onStaff={() => setView('staff')}
      />
      <main className="main">
        {view === 'book' && <AudienceBook perf={perf} />}
        {view === 'lookup' && <Lookup onBack={() => setView('book')} />}
        {view === 'staff' && <Staff onExit={() => setView('book')} />}
      </main>
      <footer className="site-footer">
        <p>
          指定席予約 ― 座席表から席を選んで予約し、当日は受付で現金でお支払いいただきます。
        </p>
        <p className="muted small">
          {mode === 'cloud'
            ? '予約データはクラウドに保存され、スタッフ全員の端末で共有されます。'
            : 'このページは試作版です。予約データはこの端末内のみに保存されます。'}
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
