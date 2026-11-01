import { describe, expect, it } from 'vitest'
import { decodeQrWithJsQr, reservationQrDataUrl } from './qr'

/**
 * QR のラウンドトリップ検証（生成 → ピクセル化 → 同じデコーダで読み取り）。
 * vitest は node 環境で ImageData が無いため、PNG をピュアJSでデコードして
 * RGBA ピクセルを取り出す小さなヘルパーを自前で持つ（zlib は node:zlib）。
 */
import { inflateSync } from 'node:zlib'

function decodePngRgba(png: Buffer): { data: Uint8ClampedArray; width: number; height: number } {
  // PNG チャンク走査
  let offset = 8
  let width = 0
  let height = 0
  let bitDepth = 0
  let colorType = 0
  const idat: Buffer[] = []
  while (offset < png.length) {
    const len = png.readUInt32BE(offset)
    const type = png.toString('ascii', offset + 4, offset + 8)
    const body = png.subarray(offset + 8, offset + 8 + len)
    if (type === 'IHDR') {
      width = body.readUInt32BE(0)
      height = body.readUInt32BE(4)
      bitDepth = body[8]
      colorType = body[9]
    } else if (type === 'IDAT') {
      idat.push(Buffer.from(body))
    }
    offset += 12 + len
  }
  if (bitDepth !== 8 || (colorType !== 6 && colorType !== 2)) {
    throw new Error(`未対応のPNG形式: bitDepth=${bitDepth} colorType=${colorType}`)
  }
  const bpp = colorType === 6 ? 4 : 3
  const raw = inflateSync(Buffer.concat(idat))
  const stride = width * bpp
  const out = new Uint8ClampedArray(width * height * 4)
  const prev = new Uint8Array(stride)
  let p = 0
  for (let y = 0; y < height; y++) {
    const filter = raw[p++]
    const line = raw.subarray(p, p + stride)
    p += stride
    const cur = new Uint8Array(stride)
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? cur[x - bpp] : 0
      const b = prev[x]
      const c = x >= bpp ? prev[x - bpp] : 0
      let v = line[x]
      if (filter === 1) v = (v + a) & 0xff
      else if (filter === 2) v = (v + b) & 0xff
      else if (filter === 3) v = (v + ((a + b) >> 1)) & 0xff
      else if (filter === 4) {
        const pa = Math.abs(b - c)
        const pb = Math.abs(a - c)
        const pc = Math.abs(a + b - 2 * c)
        const pr = pa <= pb && pa <= pc ? a : pb <= pc ? b : c
        v = (v + pr) & 0xff
      }
      cur[x] = v
    }
    for (let x = 0; x < width; x++) {
      const si = x * bpp
      const di = (y * width + x) * 4
      out[di] = cur[si]
      out[di + 1] = cur[si + 1]
      out[di + 2] = cur[si + 2]
      out[di + 3] = bpp === 4 ? cur[si + 3] : 255
    }
    prev.set(cur)
  }
  return { data: out, width, height }
}

describe('QR ラウンドトリップ', () => {
  it('生成したQRを jsQR で読み戻すと予約番号が一致する', async () => {
    const dataUrl = await reservationQrDataUrl('SK-0001')
    expect(dataUrl.startsWith('data:image/png')).toBe(true)
    const png = Buffer.from(dataUrl.split(',')[1], 'base64')
    const { data, width, height } = decodePngRgba(png)
    const imageData = { data, width, height, colorSpace: 'srgb' } as ImageData
    const decoded = await decodeQrWithJsQr(imageData)
    expect(decoded).toBe('SK-0001')
  })
})
