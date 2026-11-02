import { describe, expect, it } from 'vitest'
import {
  authBadgeLabel,
  googleDeniedMessage,
  mapAllowlist,
  mapWhoami,
  normalizeStaffEmail,
} from './staffAuth'

describe('mapWhoami', () => {
  it('ok と email を取り出す', () => {
    expect(mapWhoami({ ok: true, email: 'a@example.com' })).toEqual({
      ok: true,
      email: 'a@example.com',
    })
  })

  it('未ログイン（null 応答・email なし）は ok:false / email:null', () => {
    expect(mapWhoami(null)).toEqual({ ok: false, email: null })
    expect(mapWhoami({ ok: false })).toEqual({ ok: false, email: null })
    expect(mapWhoami({ ok: 'true', email: 42 })).toEqual({ ok: false, email: null })
  })
})

describe('mapAllowlist', () => {
  it('フラグとエントリを変換し、不正なエントリを落とす', () => {
    const list = mapAllowlist({
      passcodeLoginEnabled: true,
      entries: [
        { email: 'a@example.com', note: '受付', createdAt: '2026-11-02T00:00:00Z' },
        { email: 'b@example.com' },
        { note: 'email なし' },
        'garbage',
      ],
    })
    expect(list.passcodeLoginEnabled).toBe(true)
    expect(list.entries).toEqual([
      { email: 'a@example.com', note: '受付', createdAt: '2026-11-02T00:00:00Z' },
      { email: 'b@example.com', note: '', createdAt: null },
    ])
  })

  it('空応答はフラグ false・空リスト', () => {
    expect(mapAllowlist(null)).toEqual({ passcodeLoginEnabled: false, entries: [] })
    expect(mapAllowlist({})).toEqual({ passcodeLoginEnabled: false, entries: [] })
  })
})

describe('normalizeStaffEmail', () => {
  it('前後空白を取り、大文字を小文字化する', () => {
    expect(normalizeStaffEmail('  Staff@Example.COM ')).toBe('staff@example.com')
  })

  it('形式が不正なら null', () => {
    expect(normalizeStaffEmail('')).toBeNull()
    expect(normalizeStaffEmail('not-an-email')).toBeNull()
    expect(normalizeStaffEmail('a@b')).toBeNull()
    expect(normalizeStaffEmail('a b@example.com')).toBeNull()
    expect(normalizeStaffEmail('@example.com')).toBeNull()
  })
})

describe('googleDeniedMessage', () => {
  it('ログイン済みかつ許可外のときだけ案内を返す', () => {
    const msg = googleDeniedMessage('someone@example.com', false)
    expect(msg).toContain('someone@example.com')
    expect(msg).toContain('許可リスト')
  })

  it('未ログイン・判定前・許可済みでは null', () => {
    expect(googleDeniedMessage(null, false)).toBeNull()
    expect(googleDeniedMessage('a@example.com', null)).toBeNull()
    expect(googleDeniedMessage('a@example.com', true)).toBeNull()
  })
})

describe('authBadgeLabel', () => {
  it('Google入室のときだけメール付きラベル', () => {
    expect(authBadgeLabel('google', 'a@example.com')).toBe(
      'Googleログイン中：a@example.com',
    )
    expect(authBadgeLabel('passcode', 'a@example.com')).toBeNull()
    expect(authBadgeLabel('google', null)).toBeNull()
    expect(authBadgeLabel(null, null)).toBeNull()
  })
})
