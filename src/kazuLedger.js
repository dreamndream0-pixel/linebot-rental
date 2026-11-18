// src/kazuLedger.js — KAZU 對帳 API（唯讀；以 KAZU_LEDGER_KEY Bearer 鑰匙驗證）
const express = require('express')
const router = express.Router()
const { checkKazuKey } = require('./kazuLedgerAuth')
const { buildPendingItems, ymd } = require('./rentSchedule')

router.use((req, res, next) => {
  const r = checkKazuKey(req.headers.authorization, process.env)
  if (r === 'disabled') return res.status(404).json({ error: 'not found' })
  if (r === 'unauthorized') return res.status(401).json({ error: 'unauthorized' })
  next()
})

function toItem(it) {
  const ref = it._ref || {}
  let itemId
  if (ref.kind === 'utility') itemId = `ur:${ref.utilityReadingId}`
  else if (ref.rentPaymentId) itemId = `rp:${ref.rentPaymentId}`
  else itemId = `sched:${ref.leaseId}:${ref.kind}:${ymd(ref.periodStart)}`
  return {
    itemId,
    kind: ref.kind,
    period: ref.period,
    amountDue: ref.amountDue,
    paidAmount: ref.paidAmount,
    unpaid: it.amount,
    dueDate: it.dueDate,
    daysUntil: it.daysUntil,
    tenantName: it.tenantName,
    roomLabel: it.roomLabel,
    managedTitle: it.managedTitle,
    inactive: it.inactive,
    settled: it.settled,
  }
}

// GET /api/kazu/ledger/pending?days=&room=
router.get('/ledger/pending', async (req, res) => {
  try {
    let days = null
    if (req.query.days !== undefined && req.query.days !== '') {
      if (!/^\d+$/.test(String(req.query.days))) return res.status(400).json({ error: 'invalid days' })
      days = parseInt(req.query.days, 10)
      if (days < 0 || days > 365) return res.status(400).json({ error: 'invalid days' })
    }
    const room = String(req.query.room || '').trim()

    const prisma = require('./db')
    const leases = await prisma.lease.findMany({
      where: { status: { not: 'PENDING' } },
      include: { managedProperty: { select: { id: true, title: true, ownerName: true } } },
    })
    const leaseIds = leases.map(l => l.id)
    const [rentPayments, readings] = await Promise.all([
      leaseIds.length ? prisma.rentPayment.findMany({ where: { leaseId: { in: leaseIds } } }) : [],
      leaseIds.length ? prisma.utilityReading.findMany({ where: { leaseId: { in: leaseIds } } }) : [],
    ])
    const { rent, util } = buildPendingItems(leases, rentPayments, readings, new Date())
    let items = rent.concat(util)
    if (days !== null) items = items.filter(it => it.daysUntil <= days)
    if (room) items = items.filter(it => String(it.roomLabel || '').includes(room))
    items.sort((a, b) => new Date(a.dueDate) - new Date(b.dueDate))
    res.json({ items: items.map(toItem) })
  } catch (e) {
    console.error('KAZU 待繳清單失敗:', e.message)
    res.status(500).json({ error: 'internal error' })
  }
})

module.exports = router
