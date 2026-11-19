const test = require('node:test')
const assert = require('node:assert/strict')
const { parseItemId, parsePaymentBody } = require('../src/kazuLedgerParse.js')

test('parseItemId: 合法格式', () => {
  assert.deepEqual(parseItemId('rp:abc'), { type: 'rp', id: 'abc' })
  assert.deepEqual(parseItemId('ur:xyz'), { type: 'ur', id: 'xyz' })
  assert.deepEqual(parseItemId('sched:L1:parking:2026-11-01'), { type: 'sched', leaseId: 'L1', kind: 'parking', period: '2026-11-01' })
})

test('parseItemId: 不合法回 null', () => {
  assert.equal(parseItemId('sched:L1:car:2026-11-01'), null)
  assert.equal(parseItemId('sched:L1:rent:2026-13-01'), null)
  assert.equal(parseItemId('xx:1'), null)
  assert.equal(parseItemId(''), null)
  assert.equal(parseItemId(null), null)
})

const today = '2026-11-19'

test('parsePaymentBody: itemId 形式', () => {
  const r = parsePaymentBody({ itemId: 'rp:a', paidAmount: 15000, paidDate: '2026-11-16' }, today)
  assert.equal(r.ok, true)
  assert.deepEqual(r.value, { itemId: 'rp:a', paidAmount: 15000, paidDate: '2026-11-16' })
})

test('parsePaymentBody: paidAmount 不合法', () => {
  const mk = (paidAmount) => parsePaymentBody({ itemId: 'rp:a', paidAmount, paidDate: '2026-11-16' }, today)
  assert.equal(mk('15000').ok, false)
  assert.equal(mk(-1).ok, false)
  assert.equal(mk(1.5).ok, false)
  assert.equal(mk(0).ok, true)
})

test('parsePaymentBody: paidDate 驗證', () => {
  const mk = (paidDate) => parsePaymentBody({ itemId: 'rp:a', paidAmount: 100, paidDate }, today)
  assert.equal(mk('2026-11-31').ok, false)
  assert.equal(mk('2026-11-21').ok, false)
  assert.equal(mk('2026-11-20').ok, true)
})

test('parsePaymentBody: leaseId+kind+period 形式', () => {
  const r = parsePaymentBody({ leaseId: 'L1', kind: 'parking', period: '2026-11-01', paidAmount: 2000, paidDate: '2026-11-18' }, today)
  assert.equal(r.ok, true)
  assert.equal(r.value.itemId, 'sched:L1:parking:2026-11-01')
  const bad = parsePaymentBody({ leaseId: 'L1', kind: 'car', period: '2026-11-01', paidAmount: 2000, paidDate: '2026-11-18' }, today)
  assert.equal(bad.ok, false)
})

test('parsePaymentBody: 兩種都沒給', () => {
  assert.equal(parsePaymentBody({ paidAmount: 100, paidDate: '2026-11-16' }, today).ok, false)
})
