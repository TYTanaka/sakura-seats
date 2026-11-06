import { describe, expect, it } from 'vitest'
import {
  accessNeedsSummary,
  cancelReservation,
  createReservation,
  createWaitlistEntry,
  createZoneReservation,
  emptyData,
  normalizeAccessNeeds,
  normalizeAppData,
  refundChecklist,
  removeWaitlistEntry,
  setCheckedIn,
  setPaid,
  setRefunded,
  totals,
  uncancelReservation,
  type AppData,
} from './logic'
import {
  canPickSeatForReservation,
  manualAssignmentError,
  planAssignmentFor,
  planListCheckIn,
  planReservationAssignment,
  specialSeatTakeWarning,
  zoneUncancelBlock,
  ZONE_SEAT_IDS,
} from './zones'
import { refundChecklistToCsv, reservationsToCsv } from './csv'
import {
  CloudApi,
  mapReservationRow,
  mapStaffData,
  type RpcClient,
} from './cloud'

const ALL_IDS: string[] = []

function zoneBooking(
  data: AppData,
  zone: string,
  party: number,
  accessNeeds?: ('wheelchair' | 'parentRoom')[],
): { data: AppData; id: string } {
  const result = createZoneReservation(data, {
    zone,
    typeIds: Array.from({ length: party }, () => 'adult'),
    name: 'テスト',
    phone: '09000000000',
    note: '',
    accessNeeds,
  })
  return { data: result.data, id: result.reservation.id }
}

function seatBooking(data: AppData, seatIds: string[]): { data: AppData; id: string } {
  const result = createReservation(data, {
    seats: seatIds.map((seatId) => ({ seatId, typeId: 'adult' })),
    name: 'テスト',
    phone: '09000000000',
    note: '',
    source: 'online',
  })
  return { data: result.data, id: result.reservation.id }
}

/* ---------------- H1: 希望の保持・正規化 ---------------- */

describe('R38: 座席の希望（車椅子席・親子室）', () => {
  it('normalizeAccessNeeds は既知の種別だけを重複なしで返す', () => {
    expect(normalizeAccessNeeds(['wheelchair', 'wheelchair', 'bogus'])).toEqual([
      'wheelchair',
    ])
    expect(normalizeAccessNeeds('wheelchair')).toEqual([])
    expect(normalizeAccessNeeds(null)).toEqual([])
    expect(accessNeedsSummary(['wheelchair', 'parentRoom'])).toBe('車椅子席・親子室')
    expect(accessNeedsSummary(undefined)).toBe('')
  })

  it('ゾーン予約で希望が保持され、正規化（保存データの読込）でも残る', () => {
    const { data, id } = zoneBooking(emptyData(), 'A', 2, ['wheelchair'])
    const res = data.reservations.find((r) => r.id === id)!
    expect(res.accessNeeds).toEqual(['wheelchair'])
    const reloaded = normalizeAppData(JSON.parse(JSON.stringify(data)))!
    expect(reloaded.reservations[0].accessNeeds).toEqual(['wheelchair'])
  })

  it('希望なしの予約には accessNeeds が付かない', () => {
    const { data } = zoneBooking(emptyData(), 'A', 1)
    expect(data.reservations[0].accessNeeds).toBeUndefined()
  })
})

/* ---------------- H1: 希望→割当の経路 ---------------- */

describe('R38: 希望がある予約への専用席の割当', () => {
  it('車椅子希望の2名は、車椅子席1＋ゾーン席1で割り当たる', () => {
    const plan = planAssignmentFor(emptyData(), 'A', 2, ['wheelchair'])
    expect(plan).not.toBeNull()
    expect(plan![0]).toMatch(/^WC-/)
    expect(ZONE_SEAT_IDS.A).toContain(plan![1])
  })

  it('親子室希望の3名は、親子室3席で割り当たる', () => {
    const plan = planAssignmentFor(emptyData(), 'C', 3, ['parentRoom'])
    expect(plan).toHaveLength(3)
    expect(plan!.every((s) => s.startsWith('OYAKO-'))).toBe(true)
  })

  it('希望がなければ従来どおりゾーン席だけが割り当たる', () => {
    const plan = planAssignmentFor(emptyData(), 'A', 2)
    expect(plan).toHaveLength(2)
    expect(plan!.every((s) => ZONE_SEAT_IDS.A.includes(s))).toBe(true)
  })

  it('車椅子席が埋まっていれば、足りない分はゾーン席で補う', () => {
    const taken = seatBooking(emptyData(), ['WC-L', 'WC-R'])
    const plan = planAssignmentFor(taken.data, 'A', 2, ['wheelchair'])
    expect(plan).toHaveLength(2)
    expect(plan!.every((s) => ZONE_SEAT_IDS.A.includes(s))).toBe(true)
  })

  it('予約経由の計画（planReservationAssignment / planListCheckIn）でも専用席が先に来る', () => {
    const { data, id } = zoneBooking(emptyData(), 'B', 2, ['parentRoom'])
    const res = data.reservations.find((r) => r.id === id)!
    const plan = planReservationAssignment(data, res)
    expect(plan).not.toBeNull()
    expect(plan!.filter((s) => s.startsWith('OYAKO-'))).toHaveLength(2)
    const listPlan = planListCheckIn(data, res)
    expect(listPlan.kind).toBe('assign')
    if (listPlan.kind === 'assign') {
      expect(listPlan.seatIds.some((s) => s.startsWith('OYAKO-'))).toBe(true)
    }
  })

  it('手動指定: 希望した種別の専用席は許可され、希望なし・別種別は拒否される', () => {
    const withNeed = zoneBooking(emptyData(), 'A', 1, ['wheelchair'])
    const resNeed = withNeed.data.reservations[0]
    expect(manualAssignmentError(withNeed.data, resNeed, ['WC-L'])).toBeNull()
    expect(canPickSeatForReservation(withNeed.data, resNeed, 'WC-L')).toBe(true)
    // 希望していない種別（親子室）は割り当てられない
    expect(manualAssignmentError(withNeed.data, resNeed, ['OYAKO-1'])).toContain('親子室')
    expect(canPickSeatForReservation(withNeed.data, resNeed, 'OYAKO-1')).toBe(false)

    const noNeed = zoneBooking(emptyData(), 'A', 1)
    const resPlain = noNeed.data.reservations[0]
    expect(manualAssignmentError(noNeed.data, resPlain, ['WC-L'])).toContain('車椅子席')
    expect(canPickSeatForReservation(noNeed.data, resPlain, 'WC-L')).toBe(false)
    // ゾーン内の席は従来どおり選べる
    expect(canPickSeatForReservation(noNeed.data, resPlain, ZONE_SEAT_IDS.A[0])).toBe(true)
  })

  it('専用席の枯渇警告: 希望のある未割当予約が残り、最後の専用席を取ると警告する', () => {
    const needy = zoneBooking(emptyData(), 'A', 1, ['wheelchair'])
    const warning = specialSeatTakeWarning(needy.data, ['WC-L', 'WC-R'])
    expect(warning).toContain(needy.id)
    // 1席だけなら、もう1席残るので警告しない
    expect(specialSeatTakeWarning(needy.data, ['WC-L'])).toBeNull()
    // 希望のある予約がなければ警告しない
    expect(specialSeatTakeWarning(emptyData(), ['WC-L', 'WC-R'])).toBeNull()
  })
})

/* ---------------- M1: キャンセル取り消しのオーバーセル防止 ---------------- */

describe('R38: キャンセル取り消しのゾーン容量判定（M1）', () => {
  it('ゾーンが満杯（ホールドで定員到達）なら未割当ゾーン予約の復活を拒否する', () => {
    // ゾーンIは14席。8名＋6名の未割当ホールドで定員に到達させる
    let data = emptyData()
    data = zoneBooking(data, 'I', 8).data
    data = zoneBooking(data, 'I', 6).data
    const extra = zoneBooking(data, 'I', 1)
    data = cancelReservation(extra.data, extra.id)
    const target = data.reservations.find((r) => r.id === extra.id)!
    expect(zoneUncancelBlock(data, target)).toBe('ZONE_FULL')
  })

  it('残席があれば復活でき、席割当済みの取り消しは対象外', () => {
    let data = emptyData()
    data = zoneBooking(data, 'I', 8).data
    const extra = zoneBooking(data, 'I', 2)
    data = cancelReservation(extra.data, extra.id)
    const target = data.reservations.find((r) => r.id === extra.id)!
    expect(zoneUncancelBlock(data, target)).toBeNull()
    // 実際に復活できることも確認する（席チェック側の既存経路）
    expect(uncancelReservation(data, extra.id).result).toBe('OK')

    // 席割当済みの予約は席側のチェック（SEAT_TAKEN）の領分で、容量判定はしない
    const seated = seatBooking(emptyData(), [ZONE_SEAT_IDS.A[0]])
    const cancelled = cancelReservation(seated.data, seated.id)
    const seatedTarget = cancelled.reservations[0]
    expect(zoneUncancelBlock(cancelled, seatedTarget)).toBeNull()
  })
})

/* ---------------- M3: 返金チェックリストと返金記録 ---------------- */

describe('R38: 返金済みの記録とチェックリスト（M3）', () => {
  it('setRefunded で記録・取消ができ、refundedAt が連動する', () => {
    const { data, id } = seatBooking(emptyData(), [ZONE_SEAT_IDS.A[0]])
    const paid = setPaid(data, id, true)
    const refunded = setRefunded(paid, id, true)
    expect(refunded.reservations[0].refunded).toBe(true)
    expect(refunded.reservations[0].refundedAt).toBeTruthy()
    const undone = setRefunded(refunded, id, false)
    expect(undone.reservations[0].refunded).toBe(false)
    expect(undone.reservations[0].refundedAt).toBeNull()
  })

  it('チェックリストは支払済みだけ（キャンセル済みの支払済みも含む）', () => {
    let data = emptyData()
    const a = seatBooking(data, [ZONE_SEAT_IDS.A[0]])
    data = setPaid(a.data, a.id, true)
    const b = seatBooking(data, [ZONE_SEAT_IDS.A[1]])
    data = setPaid(b.data, b.id, true)
    data = cancelReservation(data, b.id) // キャンセル済みでも支払済みなら返金対象
    const c = seatBooking(data, [ZONE_SEAT_IDS.A[2]]) // 未払いは対象外
    data = c.data
    const list = refundChecklist(data)
    expect(list.map((r) => r.id)).toEqual([a.id, b.id])
  })

  it('集計に未返金・返金済みの件数が入る', () => {
    let data = emptyData()
    const a = seatBooking(data, [ZONE_SEAT_IDS.A[0]])
    data = setPaid(a.data, a.id, true)
    const b = seatBooking(data, [ZONE_SEAT_IDS.A[1]])
    data = setPaid(b.data, b.id, true)
    data = setRefunded(data, b.id, true)
    const t = totals(data, ALL_IDS)
    expect(t.refundDueCount).toBe(1)
    expect(t.refundDueAmount).toBe(2000)
    expect(t.refundedCount).toBe(1)
  })
})

/* ---------------- 担当者記録 ---------------- */

describe('R38: 受付・支払いの担当者記録', () => {
  it('setPaid / setCheckedIn で担当者が記録され、戻すと消える', () => {
    const { data, id } = seatBooking(emptyData(), [ZONE_SEAT_IDS.A[0]])
    let next = setPaid(data, id, true, '田中')
    expect(next.reservations[0].paidBy).toBe('田中')
    next = setCheckedIn(next, id, true, '佐藤')
    expect(next.reservations[0].checkedInBy).toBe('佐藤')
    next = setPaid(next, id, false, '田中')
    expect(next.reservations[0].paidBy).toBeUndefined()
    next = setCheckedIn(next, id, false, '佐藤')
    expect(next.reservations[0].checkedInBy).toBeUndefined()
  })

  it('担当者別内訳: 受付件数と受取額が担当者ごとに集計される', () => {
    let data = emptyData()
    const a = seatBooking(data, [ZONE_SEAT_IDS.A[0]])
    data = setCheckedIn(setPaid(a.data, a.id, true, '田中'), a.id, true, '田中')
    const b = seatBooking(data, [ZONE_SEAT_IDS.A[1]])
    data = setPaid(b.data, b.id, true, '佐藤')
    const t = totals(data, ALL_IDS)
    const tanaka = t.byOperator.find((o) => o.operator === '田中')!
    expect(tanaka.checkedInCount).toBe(1)
    expect(tanaka.receivedCount).toBe(1)
    expect(tanaka.receivedAmount).toBe(2000)
    const sato = t.byOperator.find((o) => o.operator === '佐藤')!
    expect(sato.checkedInCount).toBe(0)
    expect(sato.receivedAmount).toBe(2000)
  })
})

/* ---------------- キャンセル待ち ---------------- */

describe('R38: キャンセル待ち登録', () => {
  it('登録で WL 番号が採番され、取り下げで消える', () => {
    const first = createWaitlistEntry(emptyData(), {
      zone: 'A',
      partySize: 2,
      name: '山田',
      phone: '09000000000',
    })
    expect(first.entry.id).toBe('WL-0001')
    expect(first.entry.zone).toBe('A')
    const second = createWaitlistEntry(first.data, {
      zone: null,
      partySize: 1,
      name: '鈴木',
      phone: '08000000000',
    })
    expect(second.entry.id).toBe('WL-0002')
    const removed = removeWaitlistEntry(second.data, 'WL-0001')
    expect(removed.waitlist.map((w) => w.id)).toEqual(['WL-0002'])
    // 保存データの読込でも待ち一覧が残る
    const reloaded = normalizeAppData(JSON.parse(JSON.stringify(second.data)))!
    expect(reloaded.waitlist).toHaveLength(2)
  })
})

/* ---------------- CSV: 希望・備考列と返金リスト ---------------- */

describe('R38: CSV の希望・備考列と返金チェックリスト', () => {
  it('予約CSVに希望と備考が入る', () => {
    const { data } = zoneBooking(emptyData(), 'A', 1, ['parentRoom'])
    const csv = reservationsToCsv(data.reservations)
    expect(csv).toContain('親子室')
  })

  it('返金チェックリストCSVは支払済みだけを返金状態つきで出す', () => {
    let data = emptyData()
    const a = seatBooking(data, [ZONE_SEAT_IDS.A[0]])
    data = setPaid(a.data, a.id, true)
    const b = seatBooking(data, [ZONE_SEAT_IDS.A[1]])
    data = b.data // 未払い
    const csv = refundChecklistToCsv(data)
    expect(csv).toContain('返金')
    expect(csv).toContain(a.id)
    expect(csv).toContain('未返金')
    expect(csv).not.toContain(b.id)
  })
})

/* ---------------- クラウド層: マッピングと RPC ---------------- */

function mockClient(
  handler: (fn: string, args: Record<string, unknown>) => unknown,
) {
  const calls: { fn: string; args: Record<string, unknown> }[] = []
  const client: RpcClient = {
    rpc: async (fn, args) => {
      calls.push({ fn, args })
      const out = handler(fn, args) as
        | { data?: unknown; error?: { message: string } | null }
        | undefined
      return { data: out?.data ?? null, error: out?.error ?? null }
    },
  }
  return { client, calls }
}

describe('R38: クラウドのマッピングとRPC', () => {
  it('mapReservationRow が希望・返金・担当者を取り込む', () => {
    const res = mapReservationRow({
      id: 'uuid-1',
      code: 'SK-0001',
      name: '山田',
      phone: '090',
      items: [],
      amount: 0,
      kind: 'online',
      paid: true,
      checkedIn: true,
      status: 'active',
      createdAt: '2026-11-01T00:00:00.000Z',
      accessNeeds: ['wheelchair', 'bogus'],
      refunded: true,
      refundedAt: '2026-11-02T00:00:00.000Z',
      checkedInBy: '田中',
      paidBy: '佐藤',
    })
    expect(res.accessNeeds).toEqual(['wheelchair'])
    expect(res.refunded).toBe(true)
    expect(res.refundedAt).toBe('2026-11-02T00:00:00.000Z')
    expect(res.checkedInBy).toBe('田中')
    expect(res.paidBy).toBe('佐藤')
  })

  it('mapStaffData がキャンセル待ちを取り込み、無い場合は空になる', () => {
    const withWait = mapStaffData({
      config: {},
      reservations: [],
      waitlist: [
        {
          id: 'WL-0001',
          zone: 'A',
          partySize: 2,
          name: '山田',
          phone: '09000000000',
          createdAt: '2026-11-01T00:00:00.000Z',
        },
      ],
    })
    expect(withWait.waitlist).toHaveLength(1)
    expect(withWait.waitlist[0].id).toBe('WL-0001')
    expect(mapStaffData({ config: {}, reservations: [] }).waitlist).toEqual([])
  })

  it('staffUncancelReservation は ZONE_FULL をそのまま返す（M1）', async () => {
    const { client } = mockClient(() => ({
      data: { ok: false, result: 'ZONE_FULL' },
    }))
    const api = new CloudApi(client)
    await expect(api.staffUncancelReservation('1234', 'SK-0001')).resolves.toBe(
      'ZONE_FULL',
    )
  })

  it('bookZone は希望があるときだけ p_access_needs を送る', async () => {
    const { client, calls } = mockClient(() => ({
      data: { code: 'SK-0001', amount: 2000 },
    }))
    const api = new CloudApi(client)
    await api.bookZone({
      name: '山田',
      phone: '090',
      note: '',
      zone: 'A',
      typeIds: ['adult'],
      accessNeeds: ['wheelchair'],
    })
    expect(calls[0].args.p_access_needs).toEqual(['wheelchair'])
    await api.bookZone({
      name: '山田',
      phone: '090',
      note: '',
      zone: 'A',
      typeIds: ['adult'],
    })
    expect('p_access_needs' in calls[1].args).toBe(false)
  })

  it('staffAssignAndPay は旧DB（関数なし）で担当者なしに落として再試行する', async () => {
    let count = 0
    const { client, calls } = mockClient(() => {
      count++
      if (count === 1) {
        return {
          error: {
            message:
              'Could not find the function public.staff_assign_and_pay in the schema cache',
          },
        }
      }
      return { data: { ok: true } }
    })
    const api = new CloudApi(client)
    await api.staffAssignAndPay('1234', 'uuid-1', ['1F-1-6'], false, '田中')
    expect(calls).toHaveLength(2)
    expect(calls[0].args.p_operator).toBe('田中')
    expect('p_operator' in calls[1].args).toBe(false)
  })

  it('addWaitlist は採番されたコードを返す', async () => {
    const { client, calls } = mockClient(() => ({ data: { code: 'WL-0007' } }))
    const api = new CloudApi(client)
    await expect(
      api.addWaitlist({ name: '山田', phone: '09000000000', zone: null, partySize: 2 }),
    ).resolves.toEqual({ code: 'WL-0007' })
    expect(calls[0].fn).toBe('add_waitlist')
  })

  it('返金記録は旧DBでは r38 の案内文面で失敗する', async () => {
    const { client } = mockClient(() => ({
      error: {
        message:
          'Could not find the function public.staff_update_reservation in the schema cache',
      },
    }))
    const api = new CloudApi(client)
    await expect(
      api.staffUpdateReservation('1234', 'uuid-1', {
        paid: true,
        checkedIn: false,
        status: 'active',
        refunded: true,
      }),
    ).rejects.toThrow('migration_sakura_r38')
  })
})
