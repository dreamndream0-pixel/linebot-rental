// src/kazuLedger.js — KAZU 對帳 API（待繳清單、登記收款；以 KAZU_LEDGER_KEY Bearer 鑰匙驗證）
const crypto = require('crypto')
const express = require('express')
const router = express.Router()
const { checkKazuKey } = require('./kazuLedgerAuth')
const { parseItemId, parsePaymentBody, KINDS } = require('./kazuLedgerParse')
const {
  buildPendingItems, buildLeaseRows, ymd, startOfDay,
  isParkingRentPayment, isHiddenRentPayment,
} = require('./rentSchedule')

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
    kind: KINDS.includes(ref.kind) ? ref.kind : 'rent',
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

// ── POST /api/kazu/ledger/payment：登記收款（不推播 LINE、不刪資料、不改金額／合約）──
function fail(status, body) {
  return Object.assign(new Error(body.error), { status, body })
}

function taipeiToday() {
  return new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10)
}

function loadLease(tx, id) {
  return tx.lease.findFirst({
    where: { id, status: { not: 'PENDING' } },
    include: { managedProperty: { select: { id: true, title: true, ownerName: true } } },
  })
}

// 回傳格式同 pending 的 toItem（含更新後 paidAmount）
function itemFromRow(lease, ref, dueDate, now = new Date()) {
  const dayDiff = Math.round((startOfDay(dueDate).getTime() - startOfDay(now).getTime()) / 86400000)
  return toItem({
    amount: Math.max(0, ref.amountDue - ref.paidAmount),
    dueDate,
    daysUntil: dayDiff,
    tenantName: lease.tenantName,
    roomLabel: lease.roomLabel,
    managedTitle: lease.managedProperty ? lease.managedProperty.title : '未連結物業',
    inactive: lease.status !== 'ACTIVE' || !!(lease.leaseEnd && new Date(lease.leaseEnd) < now),
    settled: !!lease.settledAt,
    _ref: { leaseId: lease.id, ...ref },
  })
}

function auditRow(tx, { itemId, leaseId, kind, paidAmount, paidDate, result }) {
  return tx.$executeRaw`
    INSERT INTO kazu_ledger_audit (id, item_id, lease_id, kind, paid_amount, paid_date, result)
    VALUES (${crypto.randomUUID()}, ${itemId}, ${leaseId}, ${kind}, ${paidAmount}::int, ${paidDate}, ${result})
  `
}

function alreadyPaid(paidAmount, paidDate, settled) {
  return fail(409, { error: 'already_paid', existing: { paidAmount: paidAmount || 0, paidDate: ymd(paidDate), settled: !!settled } })
}

async function payUtility(tx, lease, reading, { paidAmount, paidDate }) {
  if ((reading.paidAmount || 0) > 0 || reading.paidDate) throw alreadyPaid(reading.paidAmount, reading.paidDate, false)
  if ((reading.amount || 0) > 0 && paidAmount <= 0) throw fail(400, { error: 'paidAmount must be positive' })
  const date = new Date(`${paidDate}T00:00:00Z`)
  const marker = `[水電收款 ${reading.id}]`
  const description = [marker, '水電費', lease.tenantName || '', lease.roomLabel ? `(${lease.roomLabel})` : '']
    .filter(Boolean).join(' ').trim() + ' (KAZU)'
  const recordData = {
    managedPropertyId: lease.managedPropertyId,
    leaseId: lease.id,
    type: 'INCOME',
    category: 'UTILITY',
    amount: paidAmount,
    recordDate: date,
    description,
  }
  const existingRecord = await tx.managementRecord.findFirst({
    where: { managedPropertyId: lease.managedPropertyId, leaseId: lease.id, type: 'INCOME', category: 'UTILITY', description: { startsWith: marker } },
  })
  if (existingRecord) await tx.managementRecord.update({ where: { id: existingRecord.id }, data: recordData })
  else await tx.managementRecord.create({ data: recordData })
  const updated = await tx.utilityReading.update({ where: { id: reading.id }, data: { paidAmount, paidDate: date } })
  const itemId = `ur:${reading.id}`
  await auditRow(tx, { itemId, leaseId: lease.id, kind: 'utility', paidAmount, paidDate, result: 'ok' })
  return itemFromRow(lease, {
    kind: 'utility',
    utilityReadingId: reading.id,
    period: `${ymd(updated.startDate) || ''}~${ymd(updated.endDate) || ''}`,
    amountDue: updated.amount || 0,
    paidAmount: updated.paidAmount || 0,
  }, updated.dueDate || updated.endDate)
}

// payment = 既有 RentPayment；null 時以 row（排程期別）新建
async function payRent(tx, lease, kind, payment, row, { paidAmount, paidDate }) {
  if (payment && ((payment.paidAmount || 0) > 0 || payment.paidDate || payment.settled)) {
    throw alreadyPaid(payment.paidAmount, payment.paidDate, payment.settled)
  }
  if (paidAmount <= 0) throw fail(400, { error: 'paidAmount must be positive' })
  const src = payment || row
  const date = new Date(`${paidDate}T00:00:00Z`)
  const noun = kind === 'parking' ? '車位租金' : '租金'
  const record = await tx.managementRecord.create({
    data: {
      managedPropertyId: lease.managedPropertyId,
      leaseId: lease.id,
      type: 'INCOME',
      category: kind === 'parking' ? 'PARKING' : 'RENT',
      amount: paidAmount,
      recordDate: date,
      description: `${noun} ${ymd(src.periodStart)}~${ymd(src.periodEnd)} (KAZU)`,
    },
  })
  const saved = payment
    ? await tx.rentPayment.update({ where: { id: payment.id }, data: { paidAmount, paidDate: date, recordId: record.id } })
    : await tx.rentPayment.create({
      data: {
        leaseId: lease.id,
        recordId: record.id,
        periodStart: row.periodStart,
        periodEnd: row.periodEnd,
        dueDate: row.dueDate,
        amount: row.amount,
        paidAmount,
        paidDate: date,
        note: kind === 'parking' ? `汽車位租金${lease.parkingSpotId ? ` ${lease.parkingSpotId}` : ''}` : null,
      },
    })
  await auditRow(tx, {
    itemId: `rp:${saved.id}`, leaseId: lease.id, kind, paidAmount, paidDate, result: payment ? 'updated' : 'created',
  })
  return itemFromRow(lease, {
    kind,
    rentPaymentId: saved.id,
    periodStart: saved.periodStart,
    period: `${ymd(saved.periodStart)}~${ymd(saved.periodEnd)}`,
    amountDue: saved.amount || 0,
    paidAmount: saved.paidAmount || 0,
  }, saved.dueDate)
}

router.post('/ledger/payment', express.json(), async (req, res) => {
  const parsed = parsePaymentBody(req.body, taipeiToday())
  if (!parsed.ok) return res.status(400).json({ error: parsed.error })
  const pay = parsed.value
  const ref = parseItemId(pay.itemId)
  try {
    const prisma = require('./db')
    const item = await prisma.$transaction(async tx => {
      if (ref.type === 'ur') {
        const reading = await tx.utilityReading.findUnique({ where: { id: ref.id } })
        const lease = reading && await loadLease(tx, reading.leaseId)
        if (!lease) throw fail(404, { error: 'item_not_found' })
        return payUtility(tx, lease, reading, pay)
      }
      if (ref.type === 'rp') {
        const payment = await tx.rentPayment.findUnique({ where: { id: ref.id } })
        const lease = payment && !isHiddenRentPayment(payment) && await loadLease(tx, payment.leaseId)
        if (!lease) throw fail(404, { error: 'item_not_found' })
        return payRent(tx, lease, isParkingRentPayment(payment) ? 'parking' : 'rent', payment, null, pay)
      }
      // sched
      const lease = await loadLease(tx, ref.leaseId)
      if (!lease) throw fail(404, { error: 'item_not_found' })
      if (ref.kind === 'utility') {
        const readings = (await tx.utilityReading.findMany({ where: { leaseId: lease.id } }))
          .filter(r => ymd(r.endDate) === ref.period)
        const reading = readings.find(r => !((r.paidAmount || 0) > 0 || r.paidDate)) || readings[0]
        if (!reading) throw fail(404, { error: 'item_not_found' })
        return payUtility(tx, lease, reading, pay)
      }
      const payments = await tx.rentPayment.findMany({ where: { leaseId: lease.id } })
      const isParking = ref.kind === 'parking'
      const existing = payments.find(p => !isHiddenRentPayment(p) && isParkingRentPayment(p) === isParking && ymd(p.periodStart) === ref.period)
      if (existing) return payRent(tx, lease, ref.kind, existing, null, pay)
      const hit = buildLeaseRows(lease, payments).find(x => x.kind === ref.kind && !x.row.id && ymd(x.row.periodStart) === ref.period)
      if (!hit) throw fail(404, { error: 'item_not_found' })
      return payRent(tx, lease, ref.kind, null, hit.row, pay)
    })
    res.json({ ok: true, item })
  } catch (e) {
    if (e.status) return res.status(e.status).json(e.body)
    console.error('KAZU 登記收款失敗:', e.message)
    res.status(500).json({ error: 'internal error' })
  }
})

module.exports = router
