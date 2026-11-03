import { describe, expect, it, vi } from 'vitest'
import {
  clearReceiptStatusCache,
  lookupReceiptCancelled,
  type ReceiptCancelledLookup,
} from './receiptStatus'

const deferred = <T,>() => {
  let resolve!: (v: T) => void
  const promise = new Promise<T>((r) => {
    resolve = r
  })
  return { promise, resolve }
}

describe('lookupReceiptCancelled（R26・C-1R: 控え状態照会の共有キャッシュ）', () => {
  it('同じ予約番号＋電話では照会を1回だけ発行し、遅れて購読しても結果が届く', async () => {
    clearReceiptStatusCache()
    const d = deferred<{ cancelled: boolean } | null>()
    const lookup = vi.fn<ReceiptCancelledLookup>(() => d.promise)

    // effect の1回目（cleanup で購読解除される想定でも Promise は残る）
    const p1 = lookupReceiptCancelled(lookup, 'SK-0001', '09011112222')
    // effect の再実行が同じ Promise を購読し直す
    const p2 = lookupReceiptCancelled(lookup, 'SK-0001', '09011112222')
    expect(p1).toBe(p2)
    expect(lookup).toHaveBeenCalledTimes(1)

    d.resolve({ cancelled: true })
    await expect(p1).resolves.toBe(true)
    await expect(p2).resolves.toBe(true)

    // 完了後もキャッシュが効き、再発行しない
    await expect(
      lookupReceiptCancelled(lookup, 'SK-0001', '09011112222'),
    ).resolves.toBe(true)
    expect(lookup).toHaveBeenCalledTimes(1)
  })

  it('キャンセルでない結果もそのまま返す', async () => {
    clearReceiptStatusCache()
    const lookup = vi.fn<ReceiptCancelledLookup>(async () => ({ cancelled: false }))
    await expect(
      lookupReceiptCancelled(lookup, 'SK-0002', '09011112222'),
    ).resolves.toBe(false)
    expect(lookup).toHaveBeenCalledTimes(1)
  })

  it('失敗したら null（不明）になり、次回は再試行できる', async () => {
    clearReceiptStatusCache()
    const lookup = vi
      .fn<ReceiptCancelledLookup>()
      .mockRejectedValueOnce(new Error('network'))
      .mockResolvedValueOnce({ cancelled: true })

    await expect(
      lookupReceiptCancelled(lookup, 'SK-0003', '09011112222'),
    ).resolves.toBeNull()
    // 「不明」はキャッシュに残らないので、購読し直せば再試行される
    await expect(
      lookupReceiptCancelled(lookup, 'SK-0003', '09011112222'),
    ).resolves.toBe(true)
    expect(lookup).toHaveBeenCalledTimes(2)
  })

  it('見つからない（null応答）場合も null で、再試行できる', async () => {
    clearReceiptStatusCache()
    const lookup = vi
      .fn<ReceiptCancelledLookup>()
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ cancelled: false })

    await expect(
      lookupReceiptCancelled(lookup, 'SK-0004', '09011112222'),
    ).resolves.toBeNull()
    await expect(
      lookupReceiptCancelled(lookup, 'SK-0004', '09011112222'),
    ).resolves.toBe(false)
    expect(lookup).toHaveBeenCalledTimes(2)
  })

  it('予約番号が違えば別々に照会する', async () => {
    clearReceiptStatusCache()
    const lookup = vi.fn<ReceiptCancelledLookup>(async () => ({ cancelled: false }))
    await lookupReceiptCancelled(lookup, 'SK-0005', '09011112222')
    await lookupReceiptCancelled(lookup, 'SK-0006', '09011112222')
    expect(lookup).toHaveBeenCalledTimes(2)
  })
})
