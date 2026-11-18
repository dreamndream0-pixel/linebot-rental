const test = require('node:test')
const assert = require('node:assert')
const { checkKazuKey, toKazuItems, filterKazuItems } = require('../src/kazuLedger')
const { buildPendingItems } = require('../src/rentSchedule')

const KEY = 'k'.repeat(32)

test('checkKazuKey', async (t) => {
  await t.test('沒設鑰匙 → disabled', () => {
    assert.strictEqual(checkKazuKey('Bearer ' + KEY, {}), 'disabled')
  })
  await t.test('31 字元 → disabled', () => {
    const short = 'k'.repeat(31)
    assert.strictEqual(checkKazuKey('Bearer ' + short, { KAZU_LEDGER_KEY: short }), 'disabled')
  })
  await t.test('等於 ADMIN_KEY → disabled', () => {
    assert.strictEqual(checkKazuKey('Bearer ' + KEY, { KAZU_LEDGER_KEY: KEY, ADMIN_KEY: KEY }), 'disabled')
  })
  await t.test('等於 BROKER_ADMIN_KEY → disabled', () => {
    assert.strictEqual(checkKazuKey('Bearer ' + KEY, { KAZU_LEDGER_KEY: KEY, BROKER_ADMIN_KEY: KEY }), 'disabled')
  })
  await t.test('錯鑰匙 → unauthorized', () => {
    assert.strictEqual(checkKazuKey('Bearer ' + 'x'.repeat(32), { KAZU_LEDGER_KEY: KEY, ADMIN_KEY: 'admin' }), 'unauthorized')
    assert.strictEqual(checkKazuKey('Bearer short', { KAZU_LEDGER_KEY: KEY }), 'unauthorized')
  })
  await t.test('沒帶 header → unauthorized', () => {
    assert.strictEqual(checkKazuKey(undefined, { KAZU_LEDGER_KEY: KEY }), 'unauthorized')
  })
  await t.test('正確 → ok', () => {
    assert.strictEqual(checkKazuKey('Bearer ' + KEY, { KAZU_LEDGER_KEY: KEY, ADMIN_KEY: 'admin' }), 'ok')
  })
})

test('buildPendingItems', async (t) => {
  const now = new Date('2026-11-18T03:00:00Z')
  const mp = { id: 'mp1', title: '測試物業', ownerName: '屋主' }
  const baseLease = {
    leaseStart: new Date('2026-11-01T00:00:00Z'),
    leaseEnd: new Date('2027-10-31T00:00:00Z'),
    paymentCycle: 'MONTHLY',
    rent: 10000,
    managedProperty: mp,
  }
  const leaseActive = { ...baseLease, id: 'L1', status: 'ACTIVE', tenantName: '甲', roomLabel: '401', settledAt: null }
  const leaseSettled = { ...baseLease, id: 'L2', status: 'ENDED', tenantName: '乙', roomLabel: '402', settledAt: new Date('2026-11-10T00:00:00Z') }
  const leasePending = { ...baseLease, id: 'L3', status: 'PENDING', tenantName: '丙', roomLabel: '403', settledAt: null }
  const rp = (id, leaseId) => ({
    id, leaseId, amount: 10000, paidAmount: 0, note: null,
    periodStart: new Date('2026-11-01T00:00:00Z'),
    periodEnd: new Date('2026-11-30T00:00:00Z'),
    dueDate: new Date('2026-11-05T00:00:00Z'),
  })

  await t.test('ACTIVE 合約有未繳租金 → 列出', () => {
    const { rent } = buildPendingItems([leaseActive], [rp('rp1', 'L1')], [], now)
    const hit = rent.find(r => r._ref.row.id === 'rp1')
    assert.ok(hit)
    assert.strictEqual(hit.amount, 10000)
    assert.strictEqual(hit.settled, false)
    assert.ok(hit.daysUntil < 0)
    assert.ok(toKazuItems({ rent, util: [] }).some(i => i.itemId === 'rp:rp1' && i.kind === 'rent'))
  })

  await t.test('已結算合約只列實際登記的未繳期別，settled=true', () => {
    const { rent } = buildPendingItems([leaseSettled], [rp('rp2', 'L2')], [], now)
    assert.strictEqual(rent.length, 1)
    assert.strictEqual(rent[0]._ref.row.id, 'rp2')
    assert.strictEqual(rent[0].settled, true)
    assert.strictEqual(rent[0].inactive, true)
  })

  await t.test('PENDING 合約不列（呼叫端已排除；此處不傳入時結果為空）', () => {
    const leases = [leasePending].filter(l => l.status !== 'PENDING')
    const { rent, util } = buildPendingItems(leases, [rp('rp3', 'L3')], [], now)
    assert.strictEqual(rent.length, 0)
    assert.strictEqual(util.length, 0)
  })

  await t.test('水電已繳清（1200/1200）不列；未繳者以 ur: 列出', () => {
    const paid = { id: 'u1', leaseId: 'L1', amount: 1200, paidAmount: 1200, endDate: new Date('2026-11-10T00:00:00Z') }
    const owing = { id: 'u2', leaseId: 'L1', amount: 1200, paidAmount: 200, startDate: new Date('2026-10-01T00:00:00Z'), endDate: new Date('2026-11-10T00:00:00Z') }
    const { util } = buildPendingItems([leaseActive], [], [paid, owing], now)
    assert.strictEqual(util.length, 1)
    const items = toKazuItems({ rent: [], util })
    assert.strictEqual(items[0].itemId, 'ur:u2')
    assert.strictEqual(items[0].kind, 'utility')
    assert.strictEqual(items[0].unpaid, 1000)
  })

  await t.test('filterKazuItems：days 保留逾期、room 包含比對', () => {
    const items = [
      { daysUntil: -5, roomLabel: '401' },
      { daysUntil: 3, roomLabel: '402' },
      { daysUntil: 30, roomLabel: '401' },
    ]
    assert.strictEqual(filterKazuItems(items, { days: 7 }).length, 2)
    assert.strictEqual(filterKazuItems(items, { room: '401' }).length, 2)
  })
})
