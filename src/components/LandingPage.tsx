import {
  formatMonthDayTime,
  formatPerformanceWhen,
  formatYen,
  isBookingClosed,
  type Performance,
} from '../lib/logic'
import { useStore } from '../lib/store'
import { totalAvailableSeats } from '../lib/zones'
import { useNow } from '../lib/useNow'
import { LP_CONTENT } from '../data/lpContent'
import SeatsNotice from './SeatsNotice'
import posterLpUrl from '../assets/poster-lp.webp'
import posterLpJpgUrl from '../assets/poster-lp.jpg'
import posterMainUrl from '../assets/poster-main.webp'
import storyVisualUrl from '../assets/story-visual.webp'
import storyVisualJpgUrl from '../assets/story-visual.jpg'

/**
 * 公演紹介ページ（ランディングページ・R39）。
 *
 * 面接での指摘（「初めて来た人が公演を知って、安心して予約できる入口が
 * ない」）を受けて追加した、お客様向けの入口ページ。従来は開くと即座に
 * 座席表（予約フロー）だったため、ポスターやSNSから初めて訪れた人が
 * 「どんな公演か・いくらか・どう予約するか」を知る場所がなかった。
 *
 * 構成: ヒーロー（ポスター＋キャッチ＋予約CTA）→ 初めての方へ（予約の
 * 3ステップ）→ あらすじ・見どころ → 公演情報 → 当日の流れ → 劇団に
 * ついて →（キャスト紹介・観客の声・アクセス: 劇団の実素材が投入された
 * ときだけ表示）→ よくある質問 → 最後の予約CTA。
 *
 * 文面は src/data/lpContent.ts に集約し、ここでは並べるだけにする。
 * 日時・料金・残席・締切は公演設定と在庫から都度引く（ヘッダーと同じ
 * 計算経路）ため、設定が変わっても LP 側の直しは要らない。
 * 予約フロー本体（AudienceBook）には一切手を入れていない。
 */
export default function LandingPage({
  perf,
  onBook,
  onLookup,
}: {
  perf: Performance
  /** 予約フローへ進む */
  onBook: () => void
  /** 予約確認へ進む */
  onLookup: () => void
}) {
  const { data } = useStore()
  const nowMs = useNow(10000)
  const available = totalAvailableSeats(data)
  const bookingClosed = isBookingClosed(data, new Date(nowMs))
  const showDeadline = data.bookingDeadline !== null && !bookingClosed
  const c = LP_CONTENT

  return (
    <div className="lp-flow">
      {/* ---------- ヒーロー ---------- */}
      <section className="card poster-card lp-hero" aria-labelledby="lp-hero-title">
        <div className="lp-hero-row">
          <a
            className="poster-link lp-hero-art"
            href={posterMainUrl}
            target="_blank"
            rel="noreferrer"
            aria-label="公演ポスターを大きく見る"
          >
            <picture>
              <source srcSet={posterLpUrl} type="image/webp" />
              <img
                src={posterLpJpgUrl}
                alt="劇団ツインリーブス オリジナルミュージカル『おとぎ話管理局』メインポスター"
                width={720}
                height={1032}
                fetchPriority="high"
              />
            </picture>
          </a>
          <div className="lp-hero-body">
            <p className="lp-genre">{c.genre}</p>
            <h1 className="lp-hero-title" id="lp-hero-title">
              {c.showTitle}
            </h1>
            <p className="lp-catch">{c.catchCopy}</p>
            <p className="lp-period">
              {c.periodLabel}
              <br />
              <span className="lp-hero-when">{formatPerformanceWhen(perf)}</span>
            </p>
            <p className="lp-hero-meta">
              会場：
              <span className="venue-phrase">戸塚区民文化センター</span>{' '}
              <span className="venue-phrase">さくらプラザ・ホール</span>
              <br />
              料金：
              {perf.ticketTypes.map((t, i) => (
                <span key={t.id}>
                  <span className="u-nowrap">
                    {t.name} {formatYen(t.price)}
                  </span>
                  {i < perf.ticketTypes.length - 1 && '／'}
                </span>
              ))}
              <span className="u-nowrap">（当日現金払い）</span>
              {' ／ '}
              <span className="u-nowrap">残り {available}席</span>
            </p>
            {showDeadline && (
              <p className="site-deadline" data-booking-deadline-display>
                予約締切：{formatMonthDayTime(data.bookingDeadline!)}まで
              </p>
            )}
            {bookingClosed ? (
              <p className="closed-notice" data-booking-closed>
                予約受付は終了しました。当日券は会場受付でお求めください。
              </p>
            ) : (
              <div className="lp-cta-row">
                <button
                  type="button"
                  className="btn btn-primary lp-cta-main"
                  data-lp-book-cta
                  onClick={onBook}
                >
                  座席を予約する
                </button>
                <button
                  type="button"
                  className="btn btn-ghost"
                  data-lp-lookup-cta
                  onClick={onLookup}
                >
                  予約確認はこちら
                </button>
              </div>
            )}
            <nav className="lp-nav" aria-label="ページ内メニュー">
              <a href="#lp-story">あらすじ</a>
              <a href="#lp-info">公演情報</a>
              <a href="#lp-flow">当日の流れ</a>
              <a href="#lp-faq">よくある質問</a>
            </nav>
          </div>
        </div>
      </section>

      {/* ---------- 初めての方へ ---------- */}
      <section className="card" aria-labelledby="lp-first-title">
        <h2 id="lp-first-title">初めての方へ ― 予約は3ステップ</h2>
        <ol className="lp-steps">
          <li className="lp-step">
            <span className="lp-step-num" aria-hidden="true">
              1
            </span>
            <h3 className="sub-h">ゾーンと人数を選ぶ</h3>
            <p>
              座席表でエリア（ゾーン）と人数を選んでお申し込みください。選んだゾーンの中で、並んだ席を自動でご用意します。
            </p>
          </li>
          <li className="lp-step">
            <span className="lp-step-num" aria-hidden="true">
              2
            </span>
            <h3 className="sub-h">予約番号を受け取る</h3>
            <p>
              お申し込みが完了すると、予約番号とQRコードが出ます。LINEやメールで控えを送っておくと、当日も安心です。
            </p>
          </li>
          <li className="lp-step">
            <span className="lp-step-num" aria-hidden="true">
              3
            </span>
            <h3 className="sub-h">当日、受付でお支払い</h3>
            <p>
              会場の受付で予約番号（またはQRコード）をお見せのうえ、チケット代金を現金でお支払いください。座席はその場で確定します。
            </p>
          </li>
        </ol>
      </section>

      {/* ---------- あらすじ・見どころ ---------- */}
      <section className="card" id="lp-story" aria-labelledby="lp-story-title">
        <h2 id="lp-story-title">あらすじ・見どころ</h2>
        <div className="lp-story-row">
          <div className="lp-story-text">
            {c.synopsis.map((paragraph, i) => (
              <p key={i}>{paragraph}</p>
            ))}
            <h3 className="sub-h">見どころ</h3>
            <ul className="lp-highlights">
              {c.highlights.map((h, i) => (
                <li key={i}>{h}</li>
              ))}
            </ul>
          </div>
          <figure className="lp-story-art">
            <picture>
              <source srcSet={storyVisualUrl} type="image/webp" />
              <img
                src={storyVisualJpgUrl}
                alt="開いた絵本の上に、おとぎ話の登場人物たちのシルエットが星空へ浮かぶイラスト"
                width={720}
                height={1033}
                loading="lazy"
              />
            </picture>
            <figcaption className="poster-caption">
              プログラム表紙イラスト
            </figcaption>
          </figure>
        </div>
      </section>

      {/* ---------- 公演情報 ---------- */}
      <section className="card" id="lp-info" aria-labelledby="lp-info-title">
        <h2 id="lp-info-title">公演情報</h2>
        <dl className="detail-list lp-info-list">
          <div>
            <dt>作品</dt>
            <dd>
              {c.showTitle}（{c.genre}）
            </dd>
          </div>
          <div>
            <dt>日時</dt>
            <dd>
              {formatPerformanceWhen(perf)}（開場 {perf.doorsOpen}）
            </dd>
          </div>
          <div>
            <dt>会場</dt>
            <dd>
              <span className="venue-phrase">戸塚区民文化センター</span>{' '}
              <span className="venue-phrase">さくらプラザ・ホール</span>
            </dd>
          </div>
          <div>
            <dt>料金</dt>
            <dd>
              {perf.ticketTypes.map((t, i) => (
                <span key={t.id}>
                  <span className="u-nowrap">
                    {t.name} {formatYen(t.price)}
                  </span>
                  {i < perf.ticketTypes.length - 1 && '／'}
                </span>
              ))}
              {perf.priceNote && <span>（{perf.priceNote}）</span>}
            </dd>
          </div>
          <div>
            <dt>お支払い</dt>
            <dd>当日、会場受付で現金でお支払いください（事前の手売りもございます）</dd>
          </div>
          <div>
            <dt>座席</dt>
            <dd>
              ゾーン（エリア）と人数を選ぶ方式です。
              <SeatsNotice />
              <br />
              車椅子席2席・親子室6席をご用意しています（お申し込みフォームの「座席の希望」でお選びください）。
            </dd>
          </div>
        </dl>
        {!bookingClosed && (
          <div className="btn-row">
            <button
              type="button"
              className="btn btn-primary"
              data-lp-book-cta
              onClick={onBook}
            >
              座席を予約する
            </button>
          </div>
        )}
      </section>

      {/* ---------- 当日の流れ ---------- */}
      <section className="card" id="lp-flow" aria-labelledby="lp-flow-title">
        <h2 id="lp-flow-title">当日の流れ</h2>
        <ol className="lp-flow-list">
          <li>
            <span className="lp-flow-when">{perf.doorsOpen} 開場</span>
            会場の受付で、予約番号またはQRコードをお見せください。
          </li>
          <li>
            <span className="lp-flow-when">お支払い</span>
            チケット代金を現金でお支払いください。座席は受付で確定し、ご案内します。
          </li>
          <li>
            <span className="lp-flow-when">{perf.time} 開演</span>
            『{c.showTitle}』の世界をお楽しみください♪
          </li>
        </ol>
        <p className="muted small">
          混雑を避けるため、開演時間に余裕を持ってお越しください。
        </p>
      </section>

      {/* ---------- 劇団について ---------- */}
      <section className="card" aria-labelledby="lp-about-title">
        <h2 id="lp-about-title">劇団ツインリーブスについて</h2>
        {c.aboutParagraphs.map((paragraph, i) => (
          <p key={i}>{paragraph}</p>
        ))}
        {c.history.length > 0 && (
          <>
            <h3 className="sub-h">劇団の歩み</h3>
            <ul className="lp-history-list">
              {c.history.map((entry, i) => (
                <li key={i}>
                  <span className="lp-history-year">{entry.year}</span>
                  {entry.text}
                </li>
              ))}
            </ul>
          </>
        )}
        {c.pastProductions.length > 0 && (
          <>
            <h3 className="sub-h">これまでの公演</h3>
            <ul className="lp-highlights">
              {c.pastProductions.map((title, i) => (
                <li key={i}>{title}</li>
              ))}
            </ul>
          </>
        )}
      </section>

      {/* ---------- キャスト紹介（実素材が入ったときだけ表示） ---------- */}
      {c.cast.length > 0 && (
        <section className="card" aria-labelledby="lp-cast-title">
          <h2 id="lp-cast-title">キャスト紹介</h2>
          <ul className="lp-cast-list">
            {c.cast.map((member, i) => (
              <li key={i} className="lp-cast-item">
                <p className="lp-cast-head">
                  <span className="lp-cast-role">{member.role}</span>
                  <span className="lp-cast-name">{member.name}</span>
                </p>
                <p className="lp-cast-comment">{member.comment}</p>
              </li>
            ))}
          </ul>
        </section>
      )}

      {/* ---------- 観客の声（実素材が入ったときだけ表示） ---------- */}
      {c.testimonials.length > 0 && (
        <section className="card" aria-labelledby="lp-voices-title">
          <h2 id="lp-voices-title">観客の声</h2>
          {c.testimonials.map((t, i) => (
            <blockquote key={i} className="lp-quote">
              <p>{t.quote}</p>
              <footer className="muted small">{t.attribution}</footer>
            </blockquote>
          ))}
        </section>
      )}

      {/* ---------- アクセス（実素材が入ったときだけ表示） ---------- */}
      {c.venueAccess.length > 0 && (
        <section className="card" aria-labelledby="lp-access-title">
          <h2 id="lp-access-title">会場アクセス</h2>
          {c.venueAccess.map((line, i) => (
            <p key={i}>{line}</p>
          ))}
        </section>
      )}

      {/* ---------- よくある質問 ---------- */}
      <section className="card" id="lp-faq" aria-labelledby="lp-faq-title">
        <h2 id="lp-faq-title">よくある質問</h2>
        {c.faq.map((entry, i) => (
          <details key={i} className="lp-faq-item">
            <summary>{entry.question}</summary>
            <p>{entry.answer}</p>
          </details>
        ))}
      </section>

      {/* ---------- 最後の予約CTA ---------- */}
      {!bookingClosed && (
        <section className="card lp-final-cta" aria-labelledby="lp-final-title">
          <h2 id="lp-final-title">ご予約はこちらから</h2>
          <p className="muted">
            {formatPerformanceWhen(perf)}／残り {available}席。
            スマートフォンからそのままお申し込みいただけます。
          </p>
          <div className="btn-row lp-final-btns">
            <button
              type="button"
              className="btn btn-primary"
              data-lp-book-cta
              onClick={onBook}
            >
              座席を予約する
            </button>
            <button
              type="button"
              className="btn btn-ghost"
              data-lp-lookup-cta
              onClick={onLookup}
            >
              予約確認はこちら
            </button>
          </div>
        </section>
      )}
    </div>
  )
}
