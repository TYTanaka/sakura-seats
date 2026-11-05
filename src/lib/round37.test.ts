import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { ALL_SEATS } from '../data/seats'
import {
  createReservation,
  emptyData,
  setCheckedIn,
  totals,
  type AppData,
} from './logic'
import {
  ASSET_CACHE,
  CURRENT_CACHES,
  PAGE_CACHE,
  SW_VERSION,
  classifySwRequest,
  isHashedAssetPath,
  swScriptUrl,
} from './swCore'
import { ZONE_SEAT_IDS, type ZoneId } from './zones'
import { buildZoneMapLayout, zoneAtPoint } from './zoneMap'

const ALL_IDS = ALL_SEATS.map((s) => s.id)

function seatsOf(seatIds: string[]) {
  return seatIds.map((seatId) => ({ seatId, typeId: 'adult' }))
}

/* ---------------- ゾーン単位のタップ判定（座席表の操作設計） ---------------- */

describe('R37: zoneAtPoint（座席表は提示用、タップはゾーン単位で受ける）', () => {
  const layout = buildZoneMapLayout(emptyData())
  const cellOf = (seatId: string) => layout.cells.find((c) => c.seatId === seatId)!

  it('各ゾーンの席の中心をタップすると、そのゾーンが返る', () => {
    for (const z of Object.keys(ZONE_SEAT_IDS) as ZoneId[]) {
      const seatId = ZONE_SEAT_IDS[z][0]
      const c = cellOf(seatId)
      expect(zoneAtPoint(layout, c.cx, c.cy)).toBe(z)
    }
  })

  it('席と席の間（寄せた位置）でも近い方のゾーンが返る', () => {
    // 中央ブロック 4列（ゾーンA）と5列（ゾーンB）の境目:
    // B の席中心から、最も近い A の席へ 25% 寄せた位置でも B のまま
    const bSeat = cellOf(ZONE_SEAT_IDS.B[0])
    const aSeat = layout.cells
      .filter((c) => c.zone === 'A')
      .reduce((p, c) =>
        Math.hypot(c.cx - bSeat.cx, c.cy - bSeat.cy) <
        Math.hypot(p.cx - bSeat.cx, p.cy - bSeat.cy)
          ? c
          : p,
      )
    const x = bSeat.cx + (aSeat.cx - bSeat.cx) * 0.25
    const y = bSeat.cy + (aSeat.cy - bSeat.cy) * 0.25
    expect(zoneAtPoint(layout, x, y)).toBe('B')
    // 逆に 75% 寄せれば A になる（境目は両ゾーンの中点）
    const x2 = bSeat.cx + (aSeat.cx - bSeat.cx) * 0.75
    const y2 = bSeat.cy + (aSeat.cy - bSeat.cy) * 0.75
    expect(zoneAtPoint(layout, x2, y2)).toBe('A')
  })

  it('車椅子席・親子室の上はゾーン選択にならない（null）', () => {
    const neutral = layout.cells.filter((c) => c.zone === null)
    expect(neutral.length).toBe(8)
    for (const c of neutral) {
      expect(zoneAtPoint(layout, c.cx, c.cy)).toBeNull()
    }
  })

  it('どの席からも遠い場所（舞台・余白）は null', () => {
    expect(zoneAtPoint(layout, 500, 0)).toBeNull()
    expect(zoneAtPoint(layout, 2, 1070)).toBeNull()
  })
})

/* ---------------- 集計: 当日販売の分離 ---------------- */

describe('R37: 集計で当日販売を「未受付」に混ぜない', () => {
  function dataWithDoorSale(): { data: AppData; doorId: string } {
    const r = createReservation(emptyData(), {
      seats: seatsOf(['1F-6-10', '1F-6-11']),
      name: '当日',
      phone: '',
      note: '',
      source: 'door',
    })
    return { data: r.data, doorId: r.reservation.id }
  }

  it('当日販売だけなら未受付は0で、doorSale に分離される', () => {
    const { data } = dataWithDoorSale()
    const t = totals(data, ALL_IDS)
    expect(t.notCheckedInCount).toBe(0)
    expect(t.notCheckedInPeople).toBe(0)
    expect(t.checkedInCount).toBe(0)
    expect(t.doorSaleCount).toBe(1)
    expect(t.doorSalePeople).toBe(2)
    // 予約数・支払済・売上の数え方は従来どおり（当日販売を含む）
    expect(t.reservationCount).toBe(1)
    expect(t.paidReservationCount).toBe(1)
    expect(t.salesTotal).toBe(4000)
  })

  it('当日販売を明示的に来場済みにしたら来場済み側で数える', () => {
    const { data, doorId } = dataWithDoorSale()
    const t = totals(setCheckedIn(data, doorId, true), ALL_IDS)
    expect(t.checkedInCount).toBe(1)
    expect(t.doorSaleCount).toBe(0)
    expect(t.notCheckedInCount).toBe(0)
  })
})

/* ---------------- Service Worker の判定 ---------------- */

describe('R37: Service Worker の判定（swCore）', () => {
  it('ハッシュ付きアセットの判定', () => {
    expect(isHashedAssetPath('/sakura-seats/assets/index-a1B2c3D4.js')).toBe(true)
    expect(isHashedAssetPath('/assets/index-a1B2c3D4.css')).toBe(true)
    expect(isHashedAssetPath('/assets/poster-hero.webp')).toBe(false)
    expect(isHashedAssetPath('/sakura-seats/index.html')).toBe(false)
    expect(isHashedAssetPath('/sakura-seats/sw.js')).toBe(false)
    expect(isHashedAssetPath('/sakura-seats/manifest.webmanifest')).toBe(false)
  })

  it('リクエストの振り分け: 遷移は network-first 側、アセットは cache-first 側', () => {
    expect(
      classifySwRequest({ method: 'GET', mode: 'navigate', sameOrigin: true, pathname: '/sakura-seats/' }),
    ).toBe('navigate')
    expect(
      classifySwRequest({ method: 'GET', mode: 'no-cors', sameOrigin: true, pathname: '/assets/index-a1B2c3D4.js' }),
    ).toBe('asset')
    // 外部（フォント・Supabase）と GET 以外は SW を介さない
    expect(
      classifySwRequest({ method: 'GET', mode: 'cors', sameOrigin: false, pathname: '/rest/v1/rpc/book' }),
    ).toBe('passthrough')
    expect(
      classifySwRequest({ method: 'POST', mode: 'cors', sameOrigin: true, pathname: '/sakura-seats/' }),
    ).toBe('passthrough')
    expect(
      classifySwRequest({ method: 'GET', mode: 'no-cors', sameOrigin: true, pathname: '/og-image.jpg' }),
    ).toBe('passthrough')
  })

  it('登録 URL は base に追随する', () => {
    expect(swScriptUrl('/sakura-seats/')).toBe('/sakura-seats/sw.js')
    expect(swScriptUrl('/')).toBe('/sw.js')
  })

  it('キャッシュ名は世代から一意に決まる', () => {
    expect(ASSET_CACHE).toBe(`${SW_VERSION}-assets`)
    expect(PAGE_CACHE).toBe(`${SW_VERSION}-pages`)
    expect(CURRENT_CACHES).toEqual([ASSET_CACHE, PAGE_CACHE])
  })

  it('public/sw.js が swCore の前提（世代・即時有効化・network-first）と一致する', () => {
    const sw = readFileSync(new URL('../../public/sw.js', import.meta.url), 'utf8')
    expect(sw).toContain(`const SW_VERSION = '${SW_VERSION}'`)
    // 古い版が居座らないための即時有効化
    expect(sw).toContain('skipWaiting()')
    expect(sw).toContain('clients.claim()')
    // 遷移は network-first（fetch を先に試す）
    expect(sw).toContain("request.mode === 'navigate'")
    expect(sw).toContain('await fetch(request)')
    // 世代外キャッシュの全削除
    expect(sw).toContain('caches.delete')
  })
})

/* ---------------- 初期ローディング表示 ---------------- */

describe('R37: index.html の初期ローディング表示', () => {
  it('#root の中にアプリ名＋読み込み中表示がインラインで入っている', () => {
    const html = readFileSync(new URL('../../index.html', import.meta.url), 'utf8')
    expect(html).toContain('boot-shell')
    expect(html).toContain('劇団ツインリーブス 公演予約')
    expect(html).toContain('読み込み中')
  })
})
