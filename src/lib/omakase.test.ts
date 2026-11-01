import { describe, expect, it } from 'vitest'
import {
  ALL_SEATS,
  PARENT_ROOM_SEATS,
  RECOMMENDED_SEAT_IDS,
  WHEELCHAIR_SEATS,
  seatById,
} from '../data/seats'
import { emptyData, setBlockedForSeats, type AppData } from './logic'
import {
  buildCandidateSets,
  classifySeats,
  countAvailableForPreference,
  summarizeSeatIds,
  type OmakaseCandidate,
} from './omakase'

const ALL_IDS = ALL_SEATS.map((s) => s.id)

/** 指定した席「以外」をすべて販売終了にして空席を絞る */
function onlyAvailable(availableIds: string[]): AppData {
  const keep = new Set(availableIds)
  return setBlockedForSeats(
    emptyData(),
    ALL_IDS.filter((id) => !keep.has(id)),
    true,
  )
}

function blockSeats(data: AppData, ids: string[]): AppData {
  return setBlockedForSeats(data, ids, true)
}

function allCandidates(sets: OmakaseCandidate[][]): OmakaseCandidate[] {
  return sets.flat()
}

describe('おまかせ割当: 基本', () => {
  it('空きホール・3名: 最初のセットは性格の異なる3候補で、筆頭は中央おすすめ', () => {
    const sets = buildCandidateSets(emptyData(), 3, 'any')
    expect(sets.length).toBeGreaterThan(0)
    const first = sets[0]
    expect(first).toHaveLength(3)
    // クラス多様性: 3候補とも別クラス
    expect(new Set(first.map((c) => c.areaClass)).size).toBe(3)
    // 筆頭は中央おすすめクラスで、全席がおすすめゾーン内
    expect(first[0].areaClass).toBe('center')
    expect(first[0].seatIds.every((id) => RECOMMENDED_SEAT_IDS.has(id))).toBe(true)
    // ラベルと理由が付いている
    for (const c of first) {
      expect(c.label.length).toBeGreaterThan(0)
      expect(c.reason.length).toBeGreaterThan(0)
      expect(c.summary.length).toBeGreaterThan(0)
      expect(c.split).toBe(false)
      expect(c.restricted).toBe(false)
    }
  })

  it('おすすめ優先: 空きホール・2名の筆頭候補はおすすめゾーン（1階中央5〜10列）', () => {
    const sets = buildCandidateSets(emptyData(), 2, 'any')
    const best = sets[0][0]
    expect(best.seatIds).toHaveLength(2)
    for (const id of best.seatIds) {
      const seat = seatById(id)!
      expect(seat.floor).toBe(1)
      expect(seat.block).toBe('center')
      expect(seat.row).toBeGreaterThanOrEqual(5)
      expect(seat.row).toBeLessThanOrEqual(10)
    }
  })

  it('通路を越えない: どの候補も同一ブロック内の連続番号だけからなる', () => {
    for (const size of [1, 2, 3, 4, 5, 8]) {
      const sets = buildCandidateSets(emptyData(), size, 'any')
      for (const cand of allCandidates(sets)) {
        for (const group of cand.groups) {
          const seats = group.map((id) => seatById(id)!)
          const first = seats[0]
          for (const s of seats) {
            expect(s.floor).toBe(first.floor)
            expect(s.row).toBe(first.row)
            expect(s.block).toBe(first.block)
            expect(s.kind).toBe(first.kind)
          }
          const numbers = seats
            .map((s) => s.number ?? 0)
            .sort((a, b) => a - b)
          for (let i = 1; i < numbers.length; i++) {
            expect(numbers[i]).toBe(numbers[i - 1] + 1)
          }
        }
      }
    }
  })

  it('車椅子席・親子室は人数・階希望によらず候補に含まれない', () => {
    const special = new Set([
      ...WHEELCHAIR_SEATS.map((s) => s.id),
      ...PARENT_ROOM_SEATS.map((s) => s.id),
    ])
    for (const size of [1, 2, 4, 8]) {
      for (const pref of ['any', 1, 2] as const) {
        const sets = buildCandidateSets(emptyData(), size, pref)
        for (const cand of allCandidates(sets)) {
          expect(cand.seatIds.some((id) => special.has(id))).toBe(false)
        }
      }
    }
  })

  it('階の希望: 1階指定は1階だけ、2階指定は2階だけから出す', () => {
    const sets1 = buildCandidateSets(emptyData(), 3, 1)
    expect(sets1[0].length).toBeGreaterThan(0)
    for (const cand of allCandidates(sets1)) {
      expect(cand.seatIds.every((id) => seatById(id)!.floor === 1)).toBe(true)
    }
    const sets2 = buildCandidateSets(emptyData(), 3, 2)
    expect(sets2[0].length).toBe(3)
    for (const cand of allCandidates(sets2)) {
      expect(cand.seatIds.every((id) => seatById(id)!.floor === 2)).toBe(true)
    }
    // 2階指定でもクラス多様性がある（前方/中段/後方など行ゾーンで分かれる）
    expect(new Set(sets2[0].map((c) => c.areaClass)).size).toBe(3)
  })
})

describe('おまかせ割当: 断片化回避', () => {
  it('1席だけ取り残す配置は選ばない（空席の連なりの端に寄せる）', () => {
    // 1階7列センター（6〜21番）だけを空け、6番を占有済みにして連なりを7〜21にする。
    // 2名なら 7・8番（左端寄せ）が正解で、8・9番（7番を1席残す）は選ばれない。
    const segment = ALL_SEATS.filter(
      (s) => s.floor === 1 && s.row === 7 && s.block === 'center',
    ).map((s) => s.id)
    let data = onlyAvailable(segment)
    data = blockSeats(data, ['1F-7-6'])
    const sets = buildCandidateSets(data, 2, 'any')
    expect(sets[0]).toHaveLength(1)
    expect(sets[0][0].seatIds).toEqual(['1F-7-7', '1F-7-8'])
  })

  it('右側に1席だけ残す配置も避ける', () => {
    // 連なり 6〜20（21番を占有）。2名は右端なら19・20。18・19（20番を残す）は避ける。
    // 左端6・7も左端寄せとして有効だが、中央寄り・おすすめ等の総合で筆頭は端寄せのどちらか。
    // 少なくとも筆頭候補が「片側に1席だけ残す」配置でないことを確認する。
    const segment = ALL_SEATS.filter(
      (s) => s.floor === 1 && s.row === 7 && s.block === 'center',
    ).map((s) => s.id)
    let data = onlyAvailable(segment)
    data = blockSeats(data, ['1F-7-21'])
    const sets = buildCandidateSets(data, 2, 'any')
    const best = sets[0][0]
    const nums = best.seatIds.map((id) => seatById(id).number ?? 0)
    const min = Math.min(...nums)
    const max = Math.max(...nums)
    // 連なりは 6〜20。左に残る席数 = min-6、右に残る席数 = 20-max。どちらも1であってはならない
    expect(min - 6).not.toBe(1)
    expect(20 - max).not.toBe(1)
  })
})

describe('おまかせ割当: セットの継続性', () => {
  it('「他の候補」セットは前のセットとブロックが重複しない', () => {
    const sets = buildCandidateSets(emptyData(), 2, 'any')
    expect(sets.length).toBeGreaterThanOrEqual(2)
    const seen = new Set<string>()
    for (const set of sets) {
      for (const cand of set) {
        const key = [...cand.seatIds].sort().join(',')
        expect(seen.has(key)).toBe(false)
        seen.add(key)
      }
    }
    // 2セット目は1セット目と内容が異なる
    const keyOf = (set: OmakaseCandidate[]) =>
      set.map((c) => c.seatIds.join(',')).join('|')
    expect(keyOf(sets[1])).not.toBe(keyOf(sets[0]))
  })
})

describe('おまかせ割当: 分割・売り切れ・見切れ', () => {
  it('連続ブロックが無い場合は2グループの分割候補を1つ出す', () => {
    // 7列と8列に2席ずつだけ空ける（4名の連続ブロックは存在しない）
    const data = onlyAvailable(['1F-7-12', '1F-7-13', '1F-8-12', '1F-8-13'])
    const sets = buildCandidateSets(data, 4, 'any')
    expect(sets).toHaveLength(1)
    expect(sets[0]).toHaveLength(1)
    const cand = sets[0][0]
    expect(cand.split).toBe(true)
    expect(cand.groups).toHaveLength(2)
    expect(cand.groups.map((g) => g.length).sort()).toEqual([2, 2])
    expect(new Set(cand.seatIds).size).toBe(4)
    expect(cand.reason).toContain('2か所に分かれる')
  })

  it('範囲内の空席が人数未満なら候補なし（売り切れ）', () => {
    const data = onlyAvailable(['1F-7-12', '1F-7-13'])
    expect(countAvailableForPreference(data, 'any')).toBe(2)
    expect(buildCandidateSets(data, 3, 'any')).toEqual([])
    // 階指定でも同様
    expect(buildCandidateSets(data, 1, 2)).toEqual([])
  })

  it('見切れ席は通常候補に出ない（通常席がある限り）', () => {
    const sets = buildCandidateSets(emptyData(), 4, 2)
    for (const cand of allCandidates(sets)) {
      expect(cand.restricted).toBe(false)
      expect(cand.seatIds.some((id) => seatById(id)!.restrictedView)).toBe(false)
    }
  })

  it('見切れ席を含むブロックしか残っていない場合のみ、明示ラベル付きで出す', () => {
    // 2階21列 左ブロック 3〜5番（3番が見切れ）だけを空ける。
    // 3名の窓は (3,4,5) しかなく、見切れ席を必ず含む。
    const data = onlyAvailable(['2F-21-3', '2F-21-4', '2F-21-5'])
    const sets = buildCandidateSets(data, 3, 'any')
    expect(sets.length).toBeGreaterThan(0)
    const cand = sets[0][0]
    expect(cand.restricted).toBe(true)
    expect(cand.seatIds).toContain('2F-21-3')
    expect(cand.reason).toContain('見切れ')
  })

  it('占有が進んだホールでも候補は実際に空いている席だけからなる', () => {
    // 中央おすすめゾーンを丸ごと占有 → 筆頭は別クラスになる
    const recommended = ALL_SEATS.filter((s) => RECOMMENDED_SEAT_IDS.has(s.id)).map(
      (s) => s.id,
    )
    const data = blockSeats(emptyData(), recommended)
    const sets = buildCandidateSets(data, 3, 'any')
    expect(sets[0][0].areaClass).not.toBe('center')
    for (const cand of allCandidates(sets)) {
      expect(cand.seatIds.some((id) => RECOMMENDED_SEAT_IDS.has(id))).toBe(false)
    }
  })
})

describe('classifySeats / summarizeSeatIds', () => {
  it('エリア分類', () => {
    expect(classifySeats(['1F-7-12'])).toBe('center')
    expect(classifySeats(['1F-2-12'])).toBe('front')
    expect(classifySeats(['1F-14-12'])).toBe('rear')
    expect(classifySeats(['1F-7-3'])).toBe('other')
    expect(classifySeats(['2F-21-12'])).toBe('floor2-front')
    expect(classifySeats(['2F-23-12'])).toBe('floor2-rear')
  })

  it('席要約は連続番号を範囲表記に圧縮する', () => {
    expect(summarizeSeatIds(['1F-7-12', '1F-7-13', '1F-7-14'])).toBe('1階 7列 12〜14番')
    expect(summarizeSeatIds(['1F-7-12'])).toBe('1階 7列 12番')
    expect(summarizeSeatIds(['1F-7-12', '1F-8-12'])).toBe('1階 7列 12番、1階 8列 12番')
  })
})
