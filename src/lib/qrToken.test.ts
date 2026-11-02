import { describe, expect, it } from 'vitest'
import {
  encodeQrPayload,
  generateQrToken,
  isQrToken,
  parseQrPayload,
} from './qrToken'

describe('QRトークンの生成', () => {
  it('22文字の base64url（128bit）で、推測不能な値が毎回変わる', () => {
    const a = generateQrToken()
    const b = generateQrToken()
    expect(isQrToken(a)).toBe(true)
    expect(a).toHaveLength(22)
    expect(a).not.toBe(b)
  })

  it('isQrToken は形式外を弾く', () => {
    expect(isQrToken('SK-0001')).toBe(false)
    expect(isQrToken('short')).toBe(false)
    expect(isQrToken('AAAAAAAAAAAAAAAAAAAAA=')).toBe(false) // パディングは含めない
    expect(isQrToken('AAAAAAAAAAAAAAAAAAAAA+')).toBe(false) // base64url 以外の文字
    expect(isQrToken(null)).toBe(false)
    expect(isQrToken(undefined)).toBe(false)
    expect(isQrToken(123)).toBe(false)
  })
})

describe('parseQrPayload（読み取り文字列の分類）', () => {
  it('新形式: sk1: + トークン → token（大文字小文字は保持する）', () => {
    const token = generateQrToken()
    expect(parseQrPayload(encodeQrPayload(token))).toEqual({ kind: 'token', token })
    // 前後の空白は許容する
    expect(parseQrPayload(`  ${encodeQrPayload(token)} `)).toEqual({
      kind: 'token',
      token,
    })
  })

  it('旧形式: 予約番号そのもの → legacy（番号は大文字化）', () => {
    expect(parseQrPayload('SK-0001')).toEqual({ kind: 'legacy', code: 'SK-0001' })
    expect(parseQrPayload('sk-0042')).toEqual({ kind: 'legacy', code: 'SK-0042' })
  })

  it('それ以外は invalid（偽造・改ざん・無関係なQR）', () => {
    expect(parseQrPayload('')).toEqual({ kind: 'invalid' })
    expect(parseQrPayload('https://example.com/')).toEqual({ kind: 'invalid' })
    // 接頭辞はあるがトークン形式でない
    expect(parseQrPayload('sk1:SK-0001')).toEqual({ kind: 'invalid' })
    expect(parseQrPayload('sk1:short')).toEqual({ kind: 'invalid' })
    // トークンの1文字改ざんは「形式は正しいが一致しない」ため token として
    // 分類され、検証側（サーバ/端末内照合）で NOT_FOUND になる
    const token = generateQrToken()
    const tampered = (token[0] === 'A' ? 'B' : 'A') + token.slice(1)
    expect(parseQrPayload(encodeQrPayload(tampered))).toEqual({
      kind: 'token',
      token: tampered,
    })
  })
})
