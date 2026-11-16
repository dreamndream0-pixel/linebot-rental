// node --test test/  （Node 內建測試，不需額外依賴；以記憶體假資料庫取代 Prisma）
// 注意：假資料庫測不出資料庫鎖／併發行為，Serializable 併發需另在真實測試資料庫驗證。
const test = require('node:test')
const assert = require('node:assert/strict')
const path = require('path')
const express = require('express')

const KEY = 'k'.repeat(40)
process.env.ADMIN_KEY = 'admin-key-for-tests-0123456789abcdef'
process.env.KAZU_LEDGER_KEY = KEY

// ── 記憶體假資料庫 ─────────────────────────────────────────────
function match(r, where) {
  return Object.entries(where || {}).every(([k, v]) => {
    if (v && typeof v === 'object' && !(v instanceof Date)) {
      if ('in' in v) return v.in.includes(r[k])
      if ('gte' in v) return new Date(r[k]) >= new Date(v.gte)
      return true
    }
    return (r[k] ?? null) === (v ?? null)
  })
}
let seq = 0
function table() {
  const rows = []
  return {
    rows,
    findMany: async (a = {}) => rows.filter(r => match(r, a.where)),
    findFirst: async (a = {}) => rows.find(r => match(r, a.where)) || null,
    findUnique: async (a) => rows.find(r => match(r, a.where)) || null,
    create: async ({ data }) => { const r = { id: 'id' + (++seq), createdAt: new Date(), ...data }; rows.push(r); return r },
    update: async ({ where, data }) => { const r = rows.find(x => match(x, where)); Object.assign(r, data); return r },
    updateMany: async ({ where, data }) => { const m = rows.filter(r => match(r, where)); m.forEach(r => Object.assign(r, data)); return { count: m.length } },
  }
}
const db = {
  lease: table(), rentPayment: table(), utilityReading: table(), managementRecord: table(),
  auditLog: table(), reminderLog: table(), tenant: table(), landlord: table(),
}
db.$transaction = async (fn) => {
  const tables = Object.values(db).filter(t => t && t.rows)
  const snap = tables.map(t => t.rows.map(o => ({ ...o })))
  try { return await fn(db) } catch (e) {
    tables.forEach((t, i) => t.rows.splice(0, t.rows.length, ...snap[i]))
    throw e
  }
}
const dbPath = require.resolve(path.join('..', 'src', 'db'))
require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: db }

const kazu = require('../src/kazuLedger')
const { resolveRole } = require('../src/admin/helpers')
const { sendRentReminders } = require('../src/cron')

let server, base
test.before(async () => {
  const app = express()
  app.use('/api/kazu/ledger', kazu)
  await new Promise(r => { server = app.listen(0, r) })
  base = 'http://127.0.0.1:' + server.address().port
})
test.after(() => server.close())
test.beforeEach(() => {
  kazu._resetForTest()
  process.env.KAZU_LEDGER_KEY = KEY
  Object.values(db).forEach(t => t && t.rows && t.rows.splice(0))
  const now = new Date()
  db.lease.rows.push({
    id: 'lease1', status: 'ACTIVE', settledAt: null, managedPropertyId: 'mp1',
    managedProperty: { title: '青雲巷', landlordId: 'll1' },
    tenantName: '王小明', tenantPhone: '0912345678', tenantIdNo: 'A123456789', lineUserId: 'U' + 'a'.repeat(32),
    roomLabel: '4A', rent: 10000, paymentCycle: 'MONTHLY', paymentDueMode: 'CONTRACT_START',
    leaseStart: new Date(now.getFullYear(), now.getMonth(), 1),
    leaseEnd: new Date(now.getFullYear() + 1, now.getMonth(), 1), parkingFee: 0,
  })
})

const call = (p, opts = {}) => fetch(base + '/api/kazu/ledger' + p, {
  ...opts, headers: { Authorization: 'Bearer ' + KEY, 'Content-Type': 'application/json', ...(opts.headers || {}) },
})
const post = (body) => call('/payment', { method: 'POST', body: JSON.stringify(body) })
async function firstRent() {
  const j = await (await call('/pending')).json()
  return j.items.find(i => i.type === 'rent')
}

test('沒設鑰匙或長度不足 → 404（不退回 ADMIN_KEY）', async () => {
  delete process.env.KAZU_LEDGER_KEY
  assert.equal((await call('/pending')).status, 404)
  process.env.KAZU_LEDGER_KEY = 'short'
  assert.equal((await call('/pending', { headers: { Authorization: 'Bearer short' } })).status, 404)
  process.env.KAZU_LEDGER_KEY = KEY
  assert.equal((await call('/pending', { headers: { Authorization: 'Bearer ' + process.env.ADMIN_KEY } })).status, 401)
})

test('鑰匙與 ADMIN_KEY 相同 → 404', async () => {
  process.env.KAZU_LEDGER_KEY = process.env.ADMIN_KEY
  kazu._resetForTest()
  const r = await call('/pending', { headers: { Authorization: 'Bearer ' + process.env.ADMIN_KEY } })
  assert.equal(r.status, 404)
})

test('錯鑰匙或沒帶 → 401；網址參數不被接受', async () => {
  assert.equal((await call('/pending', { headers: { Authorization: 'Bearer wrong' } })).status, 401)
  assert.equal((await fetch(base + '/api/kazu/ledger/pending')).status, 401)
  assert.equal((await fetch(base + '/api/kazu/ledger/pending?key=' + KEY)).status, 401)
})

test('KAZU 鑰匙不是後台角色（resolveRole 不認）', async () => {
  assert.equal(await resolveRole(KEY), null)
  assert.equal(await resolveRole('SESSION:' + KEY), null)
})

test('pending：欄位白名單、不含個資、days/room 驗證', async () => {
  const j = await (await call('/pending')).json()
  assert.ok(j.items.length > 0)
  const allowed = ['itemId', 'leaseId', 'property', 'room', 'tenantName', 'type', 'periodStart', 'periodEnd', 'amount', 'dueDate', 'paidAmount', 'paidDate', 'status', 'statusLabel', 'overdue']
  for (const it of j.items) {
    assert.deepEqual(Object.keys(it).sort(), allowed.slice().sort())
    assert.match(it.dueDate, /^\d{4}-\d{2}-\d{2}$/)
  }
  assert.equal(JSON.stringify(j).includes('0912345678'), false)
  assert.equal(JSON.stringify(j).includes('A123456789'), false)
  assert.equal((await call('/pending?days=abc')).status, 400)
  assert.equal((await call('/pending?days=366')).status, 400)
  assert.equal((await (await call('/pending?room=9Z')).json()).items.length, 0)
  assert.ok((await (await call('/pending?room=4A')).json()).items.length > 0)
})

test('payment：推算期別首次落庫、寫收入帳與稽核，再送一次 409', async () => {
  const item = await firstRent()
  assert.match(item.itemId, /^gen:/)
  const r = await post({ itemId: item.itemId, paidAmount: 10000, paidDate: '2026-05-03', amount: 1, rent: 1 })
  assert.equal(r.status, 200)
  const body = await r.json()
  assert.match(body.itemId, /^rp:/)
  assert.equal(db.rentPayment.rows.length, 1)
  assert.equal(db.rentPayment.rows[0].amount, item.amount)       // 應繳金額不被改
  assert.equal(db.rentPayment.rows[0].paidAmount, 10000)
  assert.equal(db.managementRecord.rows.length, 1)
  assert.equal(db.managementRecord.rows[0].category, 'RENT')
  assert.equal(db.auditLog.rows.length, 1)
  assert.equal(JSON.parse(db.auditLog.rows[0].summary).source, 'kazu')

  const r2 = await post({ itemId: body.itemId, paidAmount: 5, paidDate: '2026-05-04' })
  assert.equal(r2.status, 409)
  assert.equal((await r2.json()).existing.paidAmount, 10000)
  const r3 = await post({ itemId: item.itemId, paidAmount: 5, paidDate: '2026-05-04' })
  assert.equal(r3.status, 409)
  assert.equal(db.rentPayment.rows[0].paidAmount, 10000)
  assert.equal(db.managementRecord.rows.length, 1)
})

test('payment：電費可寫入，部分已繳也回 409', async () => {
  const now = new Date()
  db.utilityReading.rows.push({ id: 'ur1', leaseId: 'lease1', endDate: now, dueDate: now, amount: 800, paidAmount: 0, paidDate: null })
  const r = await post({ itemId: 'ur:ur1', paidAmount: 800, paidDate: '2026-05-03' })
  assert.equal(r.status, 200)
  assert.equal(db.utilityReading.rows[0].amount, 800)
  assert.equal(db.managementRecord.rows[0].category, 'UTILITY')
  db.utilityReading.rows.push({ id: 'ur2', leaseId: 'lease1', endDate: now, dueDate: now, amount: 800, paidAmount: 300, paidDate: new Date() })
  assert.equal((await post({ itemId: 'ur:ur2', paidAmount: 800, paidDate: '2026-05-03' })).status, 409)
})

test('payment：嚴格驗證與隱藏／結算合約拒絕', async () => {
  const item = await firstRent()
  assert.equal((await post({ itemId: item.itemId, paidAmount: '100', paidDate: '2026-05-03' })).status, 400)
  assert.equal((await post({ itemId: item.itemId, paidAmount: 1.5, paidDate: '2026-05-03' })).status, 400)
  assert.equal((await post({ itemId: item.itemId, paidAmount: 100, paidDate: '2026-02-30' })).status, 400)
  assert.equal((await post({ paidAmount: 100, paidDate: '2026-05-03' })).status, 400)
  db.lease.rows[0].settledAt = new Date()
  assert.equal((await post({ itemId: item.itemId, paidAmount: 100, paidDate: '2026-05-03' })).status, 404)
})

test('payment：稽核寫入失敗 → 整筆回滾', async () => {
  const item = await firstRent()
  const orig = db.auditLog.create
  db.auditLog.create = async () => { throw new Error('audit down') }
  try {
    const r = await post({ itemId: item.itemId, paidAmount: 10000, paidDate: '2026-05-03' })
    assert.equal(r.status, 500)
  } finally { db.auditLog.create = orig }
  assert.equal(db.rentPayment.rows.length, 0)
  assert.equal(db.managementRecord.rows.length, 0)
})

test('reminders：只回白名單欄位', async () => {
  db.reminderLog.rows.push({ id: 'x', createdAt: new Date(), source: 'CRON_MONTHLY', recipient: 'TENANT', tenantId: 't1', tenantName: '王', period: '2026-05', success: false, error: 'bad U' + 'a'.repeat(32) })
  db.reminderLog.rows.push({ id: 'y', createdAt: new Date(Date.now() - 90 * 86400000), source: 'CRON_MONTHLY', success: true })
  const j = await (await call('/reminders')).json()
  assert.equal(j.reminders.length, 1)
  assert.equal('tenantId' in j.reminders[0], false)
  assert.equal(j.reminders[0].error.includes('U' + 'a'.repeat(32)), false)
})

test('限流：第 31 次回 429', async () => {
  let last
  for (let i = 0; i < 31; i++) last = await call('/reminders')
  assert.equal(last.status, 429)
})

test('cron：寫推播紀錄；寫紀錄失敗推播仍成功', async () => {
  db.tenant.findMany = async () => [{ id: 't1', name: '王', lineUserId: 'U1', rentDue: 5, property: { title: 'X', price: 1000 }, landlord: null }]
  let pushed = 0
  const client = { pushMessage: async () => { pushed++ } }
  await sendRentReminders(client)
  assert.equal(pushed, 1)
  assert.equal(db.reminderLog.rows.length, 1)
  assert.equal(db.reminderLog.rows[0].success, true)

  const orig = db.reminderLog.create
  db.reminderLog.create = async () => { throw new Error('db down') }
  try { await sendRentReminders(client) } finally { db.reminderLog.create = orig }
  assert.equal(pushed, 2)

  const failing = { pushMessage: async () => { throw new Error('LINE 500') } }
  await sendRentReminders(failing)
  assert.equal(db.reminderLog.rows.at(-1).success, false)
})
