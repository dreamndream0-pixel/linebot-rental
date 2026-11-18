const test = require('node:test')
const assert = require('node:assert/strict')
const { checkKazuKey } = require('../src/kazuLedgerAuth')
const { buildPendingItems } = require('../src/rentSchedule')

const K = 'k'.repeat(40)

test('checkKazuKey', () => {
  assert.equal(checkKazuKey('Bearer ' + K, {}), 'disabled')
  assert.equal(checkKazuKey('Bearer ' + 'k'.repeat(31), { KAZU_LEDGER_KEY: 'k'.repeat(31) }), 'disabled')
  assert.equal(checkKazuKey('Bearer ' + K, { KAZU_LEDGER_KEY: K, ADMIN_KEY: K }), 'disabled')
  assert.equal(checkKazuKey('Bearer ' + K, { KAZU_LEDGER_KEY: K, BROKER_ADMIN_KEY: K }), 'disabled')
  assert.equal(checkKazuKey('Bearer ' + 'x'.repeat(40), { KAZU_LEDGER_KEY: K }), 'unauthorized')
  assert.equal(checkKazuKey(undefined, { KAZU_LEDGER_KEY: K }), 'unauthorized')
  assert.equal(checkKazuKey('Bearer ' + K, { KAZU_LEDGER_KEY: K }), 'ok')
})

const now = new Date('2026-11-18T03:00:00Z')

function mkLease(over) {
  return {
    id: 'L1',
    tenantName: '王小明',
    roomLabel: '401',
    status: 'ACTIVE',
    settledAt: null,
    leaseStart: new Date('2026-05-05T00:00:00Z'),
    leaseEnd: new Date('2027-05-04T00:00:00Z'),
    paymentCycle: 'MONTHLY',
    paymentDueMode: 'CONTRACT_START',
    rentPayDay: 5,
    rent: 10000,
    discountType: null,
    discountValue: 0,
    managedProperty: { id: 'M1', title: '測試物業', ownerName: '屋主' },
    ...over,
  }
}

function mkRp(over) {
  return {
    id: 'RP1',
    leaseId: 'L1',
    periodStart: new Date('2026-11-05T00:00:00Z'),
    periodEnd: new Date('2026-12-04T00:00:00Z'),
    amount: 10000,
    dueDate: new Date('2026-11-05T00:00:00Z'),
    paidAmount: 0,
    paidDate: null,
    payMethod: null,
    receiptUrl: null,
    note: null,
    settled: false,
    ...over,
  }
}

test('buildPendingItems: ACTIVE 合約未繳租金會列出', () => {
  const r = buildPendingItems([mkLease()], [mkRp()], [], now)
  const hit = r.rent.filter(x => x._ref.rentPaymentId === 'RP1')
  assert.equal(hit.length, 1)
  assert.ok(hit[0].amount > 0)
})

test('buildPendingItems: 已結算合約仍列出實際登記的未繳租金', () => {
  const lease = mkLease({ status: 'ENDED', settledAt: new Date('2026-11-10T00:00:00Z') })
  const r = buildPendingItems([lease], [mkRp({ id: 'RP2' })], [], now)
  const hit = r.rent.filter(x => x._ref.rentPaymentId === 'RP2')
  assert.equal(hit.length, 1)
  assert.ok(hit[0].amount > 0)
})

test('buildPendingItems: 水電以 amount − paidAmount 判斷', () => {
  const base = {
    leaseId: 'L1',
    startDate: new Date('2026-10-01T00:00:00Z'),
    endDate: new Date('2026-11-01T00:00:00Z'),
    dueDate: new Date('2026-11-10T00:00:00Z'),
    amount: 1200,
    note: null,
  }
  const readings = [
    { ...base, id: 'UR_PAID', paidAmount: 1200 },
    { ...base, id: 'UR_OPEN', paidAmount: 0 },
  ]
  const r = buildPendingItems([mkLease()], [], readings, now)
  assert.ok(!r.util.some(x => x._ref.utilityReadingId === 'UR_PAID'))
  const open = r.util.filter(x => x._ref.utilityReadingId === 'UR_OPEN')
  assert.equal(open.length, 1)
  assert.ok(open[0].amount > 0)
})
