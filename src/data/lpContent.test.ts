import { describe, expect, it } from 'vitest'
import { LP_CONTENT, pendingLpSlots, type LpContent } from './lpContent'

/**
 * R39: 公演紹介ページ（LP）の文面データの整合性。
 * - 確定情報（ポスター文言・作品名・時期）に基づく文面が揃っていること
 * - FAQ は質問・回答が対で欠けていないこと
 * - 劇団からの実素材待ちスロットは、空の間は pendingLpSlots に出続け、
 *   投入されれば消えること（捏造で埋めない運用をテストで固定する）
 */
describe('LP文面（確定情報の範囲）', () => {
  it('ポスター文言・作品名・時期が入っている', () => {
    expect(LP_CONTENT.catchCopy).toContain('おとぎ話の世界へ')
    expect(LP_CONTENT.showTitle).toBe('おとぎ話管理局')
    expect(LP_CONTENT.genre).toContain('ツインリーブス')
    expect(LP_CONTENT.periodLabel).toContain('2027年5月')
  })

  it('あらすじ・見どころ・劇団紹介が空でない', () => {
    expect(LP_CONTENT.synopsis.length).toBeGreaterThan(0)
    expect(LP_CONTENT.synopsis.every((p) => p.trim().length > 0)).toBe(true)
    expect(LP_CONTENT.highlights.length).toBeGreaterThan(0)
    expect(LP_CONTENT.highlights.every((h) => h.trim().length > 0)).toBe(true)
    expect(LP_CONTENT.aboutParagraphs.length).toBeGreaterThan(0)
  })

  it('FAQ は全件、質問と回答が対で入っている', () => {
    expect(LP_CONTENT.faq.length).toBeGreaterThanOrEqual(5)
    for (const entry of LP_CONTENT.faq) {
      expect(entry.question.trim().length).toBeGreaterThan(0)
      expect(entry.answer.trim().length).toBeGreaterThan(0)
    }
  })

  it('FAQ は予約の確定情報（現金・8名まで・車椅子席/親子室）と矛盾しない', () => {
    const all = LP_CONTENT.faq.map((f) => `${f.question}\n${f.answer}`).join('\n')
    expect(all).toContain('現金')
    expect(all).toContain('8名')
    expect(all).toContain('車椅子席2席')
    expect(all).toContain('親子室6席')
    expect(all).toContain('小学生以下')
  })
})

describe('pendingLpSlots（実素材待ちの管理）', () => {
  it('現状では劇団素材の5スロットがすべて未投入として出る', () => {
    const pending = pendingLpSlots()
    expect(pending).toContain('劇団の歴史（歩み）')
    expect(pending).toContain('過去の公演一覧')
    expect(pending).toContain('観客の声')
    expect(pending).toContain('キャスト紹介（名前・役名・一言）')
    expect(pending).toContain('会場アクセス（住所・交通案内）')
    expect(pending).toHaveLength(5)
  })

  it('投入したスロットは pending から消える', () => {
    const filled: LpContent = {
      ...LP_CONTENT,
      history: [{ year: '20XX年', text: 'テスト用の歩み' }],
      cast: [{ role: '役名', name: '氏名', comment: '一言' }],
    }
    const pending = pendingLpSlots(filled)
    expect(pending).not.toContain('劇団の歴史（歩み）')
    expect(pending).not.toContain('キャスト紹介（名前・役名・一言）')
    expect(pending).toHaveLength(3)
  })
})
