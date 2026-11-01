/**
 * QRコードの生成・読み取りユーティリティ。
 * 生成（qrcode）と読み取りフォールバック（jsQR）はどちらも重いので、
 * 呼び出し側が動的 import したときにだけ読み込まれる前提でここに置く。
 */

/** 予約番号を QR コードの data URL（PNG）にする */
export async function reservationQrDataUrl(code: string): Promise<string> {
  const QRCode = (await import('qrcode')).default
  return QRCode.toDataURL(code, {
    width: 264,
    margin: 2,
    errorCorrectionLevel: 'M',
  })
}

/** ImageData から QR を読み取る（jsQR）。読めなければ null */
export async function decodeQrWithJsQr(imageData: ImageData): Promise<string | null> {
  const jsQR = (await import('jsqr')).default
  const result = jsQR(imageData.data, imageData.width, imageData.height, {
    inversionAttempts: 'dontInvert',
  })
  return result?.data ? result.data : null
}

/* BarcodeDetector（Chrome / Android Chrome の標準API）の最小型定義。
   TS の DOM lib にはまだ含まれていないため、必要分だけ宣言する。 */
export interface BarcodeDetectorLike {
  detect: (source: ImageBitmapSource) => Promise<{ rawValue?: string }[]>
}

interface BarcodeDetectorConstructor {
  new (options?: { formats?: string[] }): BarcodeDetectorLike
  getSupportedFormats?: () => Promise<string[]>
}

/** BarcodeDetector が使える場合はそのインスタンスを、使えなければ null を返す */
export function createBarcodeDetector(): BarcodeDetectorLike | null {
  const ctor = (globalThis as { BarcodeDetector?: BarcodeDetectorConstructor })
    .BarcodeDetector
  if (!ctor) return null
  try {
    return new ctor({ formats: ['qr_code'] })
  } catch {
    return null
  }
}
