import { describe, expect, it } from 'vitest'
import { isStaleRevision, nextRevision, parseRevision } from './revision'

describe('保存リビジョン（R5-1: 2タブ競合対策）', () => {
  it('保存済み文字列を解釈する', () => {
    expect(parseRevision('0')).toBe(0)
    expect(parseRevision('7')).toBe(7)
    expect(parseRevision(' 12 ')).toBe(12)
  })

  it('未保存・壊れた値は 0（旧形式のデータも 0 扱い）', () => {
    expect(parseRevision(null)).toBe(0)
    expect(parseRevision('')).toBe(0)
    expect(parseRevision('abc')).toBe(0)
    expect(parseRevision('1.5')).toBe(0)
    expect(parseRevision('-3')).toBe(0)
  })

  it('次のリビジョンは +1', () => {
    expect(nextRevision(0)).toBe(1)
    expect(nextRevision(41)).toBe(42)
  })

  it('リビジョンがずれていたら他タブが先に保存した（stale）', () => {
    expect(isStaleRevision(3, 3)).toBe(false)
    expect(isStaleRevision(4, 3)).toBe(true)
    expect(isStaleRevision(0, 5)).toBe(true)
  })
})
