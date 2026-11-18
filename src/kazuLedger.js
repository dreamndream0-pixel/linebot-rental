// src/kazuLedger.js — KAZU 對帳 API（唯讀）：待繳費清單
// 以 Authorization: Bearer <KAZU_LEDGER_KEY> 驗證；鑰匙未設定／太短／與後台鑰匙相同時整組停用（404）。
const crypto = require('crypto')
const express = require('express')
const { buildPendingItems, ymd } = require('./rentSchedule')

const router = express.Router()

// 回傳 'disabled' | 'unauthorized' | 'ok'
function checkKazuKey(headerValue, env = process.env) {
  const key = env.KAZU_LEDGER_KEY
  if (!key || key.length < 32 || key === env.ADMIN_KEY || key === env.BROKER_ADMIN_KEY) return 'disabled'
  const m = /^Bearer\s+(.+)$/i.exec(String(headerValue || '').trim())
  if (!m) return 'unauthorized'
  const given = Buffer.from(m[1])
  const expected = Buffer.from(key)
  if (given.length !== expected.length) return 'unauthorized'
  return crypto.timingSafeEqual(given, expected) ? 'ok' : 'unauthorized'
}

// 把 buildPendingItems 的結果轉成 KAZU 回傳格式（不含電話、LINE userId、身分證等個資）
function toKazuItems({ rent, util }) {
  const items = []
  rent.forEach(it => {
    const row = it._ref.row
    const kind = it._ref.parking ? 'parking' : 'rent'
    items.push({
      itemId: row.id ? `rp:${row.id}` : `sched:${it.leaseId}:${kind}:${ymd(row.periodStart)}`,
      kind,
      period: `${ymd(row.periodStart)}~${ymd(row.periodEnd)}`,
      amountDue: row.amount || 0,
      paidAmount: row.paidAmount || 0,
      unpaid: it.amount,
      dueDate: it.dueDate,
      daysUntil: it.daysUntil,
      tenantName: it.tenantName,
      roomLabel: it.roomLabel,
      managedTitle: it.managedTitle,
      inactive: it.inactive,
      settled: it.settled,
    })
  })
  util.forEach(it => {
    const rd = it._ref.reading
    items.push({
      itemId: `ur:${rd.id}`,
      kind: 'utility',
      period: `${ymd(rd.startDate) || ''}~${ymd(rd.endDate)}`,
      amountDue: rd.amount || 0,
      paidAmount: rd.paidAmount || 0,
      unpaid: it.amount,
      dueDate: it.dueDate,
      daysUntil: it.daysUntil,
      tenantName: it.tenantName,
      roomLabel: it.roomLabel,
      managedTitle: it.managedTitle,
      inactive: it.inactive,
      settled: it.settled,
    })
  })
  return items.sort((a, b) => new Date(a.dueDate) - new Date(b.dueDate))
}

// days：只留 daysUntil <= days 的項目（逾期者 daysUntil 為負，一律保留）；room：roomLabel 包含比對
function filterKazuItems(items, { days, room } = {}) {
  let out = items
  if (days !== undefined && days !== null) out = out.filter(i => i.daysUntil <= days)
  if (room) out = out.filter(i => String(i.roomLabel || '').includes(room))
  return out
}

router.use((req, res, next) => {
  const status = checkKazuKey(req.headers.authorization, process.env)
  if (status === 'disabled') return res.status(404).json({ error: 'not found' })
  if (status === 'unauthorized') return res.status(401).json({ error: 'unauthorized' })
  next()
})

// 掛載於 /api/kazu → GET /api/kazu/ledger/pending?days=&room=
router.get('/ledger/pending', async (req, res) => {
  try {
    let days
    if (req.query.days !== undefined && req.query.days !== '') {
      days = Number(req.query.days)
      if (!Number.isInteger(days) || days < 0 || days > 365) return res.status(400).json({ error: 'days 需為 0–365 的整數' })
    }
    const room = String(req.query.room || '').trim()

    const prisma = require('./db')
    // 與後台 managed-pending（super 角色）相同：排除未生效（PENDING）合約
    const leases = await prisma.lease.findMany({
      where: { status: { not: 'PENDING' } },
      include: { managedProperty: { select: { id: true, title: true, ownerName: true } } },
    })
    const leaseIds = leases.map(l => l.id)
    const [rentPayments, readings] = await Promise.all([
      leaseIds.length ? prisma.rentPayment.findMany({ where: { leaseId: { in: leaseIds } } }) : [],
      leaseIds.length ? prisma.utilityReading.findMany({ where: { leaseId: { in: leaseIds } } }) : [],
    ])
    const items = filterKazuItems(toKazuItems(buildPendingItems(leases, rentPayments, readings, new Date())), { days, room })
    res.json({ items })
  } catch (e) {
    console.error('KAZU 待繳清單失敗:', e.message)
    res.status(500).json({ error: 'internal error' })
  }
})

module.exports = router
module.exports.checkKazuKey = checkKazuKey
module.exports.toKazuItems = toKazuItems
module.exports.filterKazuItems = filterKazuItems
