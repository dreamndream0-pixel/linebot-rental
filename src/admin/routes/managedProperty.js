// src/admin/routes/managedProperty.js — 包租代管系統
const express = require('express')
const router = express.Router()
const prisma = require('../../db')
const { resolveRole } = require('../helpers')
const { getClientForLease, pushToLeaseTenant, rentReminderFlex, utilReminderFlex, rentReceiptFlex, utilReceiptFlex, settleReceiptFlex, buildPayInfo } = require('../../leaseReminder')
const { importTaipowerBills } = require('../../utilityBillImport')
const { findLineTenant } = require('../../tenantStore')

// 權限過濾：super 看全部，房東只看自己的
function ownFilter(auth) {
  return auth.role === 'super' ? {} : { landlordId: auth.landlordId }
}

// Ragic 同步權限：super 一律可用；房東需在「功能模組」被授權 ragic
async function hasRagicFeature(auth) {
  if (!auth) return false
  if (auth.role === 'super') return true
  if (!auth.landlordId) return false
  try {
    const rows = await prisma.$queryRawUnsafe(`SELECT features FROM landlords WHERE id = $1`, auth.landlordId)
    const f = rows[0] && rows[0].features ? JSON.parse(rows[0].features) : {}
    return f.ragic === true
  } catch (_) { return false }
}

function addMonths(date, months) {
  const d = new Date(date)
  const day = d.getDate()
  d.setMonth(d.getMonth() + months)
  if (d.getDate() !== day) d.setDate(0)
  return d
}

function cycleMonths(cycle) {
  return { BIMONTHLY: 2, QUARTERLY: 3, SEMIANNUAL: 6, YEARLY: 12 }[cycle] || 1
}

function fixedDueDate(periodStart, payDay) {
  const year = periodStart.getFullYear()
  const month = periodStart.getMonth()
  const day = Math.min(payDay || periodStart.getDate(), new Date(year, month + 1, 0).getDate())
  let due = new Date(year, month, day)
  if (due < periodStart) {
    const nextYear = addMonths(periodStart, 1).getFullYear()
    const nextMonth = addMonths(periodStart, 1).getMonth()
    due = new Date(nextYear, nextMonth, Math.min(payDay || periodStart.getDate(), new Date(nextYear, nextMonth + 1, 0).getDate()))
  }
  return due
}

function ymd(d) {
  return d ? new Date(d).toISOString().slice(0, 10) : null
}

function startOfDay(d) {
  const x = new Date(d)
  x.setHours(0, 0, 0, 0)
  return x
}

function safeParse(s) {
  try { return JSON.parse(s) } catch { return null }
}

// 決定顯示於繳費卡片的「收款帳戶」（戶名／銀行／帳號 結構）：
// 以委託物業的屋主匯款銀行＋帳號為主（房東委託該物業指定的收款帳戶）；
// 若該物業未填，才退用房東共用的匯款資訊（rentPayInfo）。
async function resolvePayInfo(managedProperty) {
  if (!managedProperty) return null
  const bank = (managedProperty.ownerBankName || '').trim()
  const acct = (managedProperty.ownerBank || '').trim()
  let fallback = null
  if (!bank && !acct && managedProperty.landlordId) {
    try {
      const ll = await prisma.landlord.findUnique({ where: { id: managedProperty.landlordId }, select: { rentPayInfo: true } })
      fallback = ll && ll.rentPayInfo
    } catch (e) { console.error('讀取房東匯款資訊失敗:', e.message) }
  }
  return buildPayInfo(managedProperty, fallback)
}

async function getOwnedLease(auth, leaseId) {
  const lease = await prisma.lease.findUnique({
    where: { id: leaseId },
    include: { managedProperty: true },
  })
  if (!lease) return null
  if (auth.role !== 'super' && lease.managedProperty.landlordId !== auth.landlordId) return false
  return lease
}

// 折扣後的實際月租金（FIXED=折固定金額；PERCENT=折%數；都不可低於 0）
function effectiveRent(lease) {
  const rent = lease.rent || 0
  if (lease.discountType === 'FIXED') return Math.max(0, rent - (lease.discountValue || 0))
  if (lease.discountType === 'PERCENT') return Math.max(0, Math.round(rent * (1 - (lease.discountValue || 0) / 100)))
  return rent
}

function buildRentSchedule(lease, rentPayments) {
  if (!lease.leaseStart) return []
  const months = cycleMonths(lease.paymentCycle)
  const start = new Date(lease.leaseStart)
  const leaseEnd = lease.leaseEnd ? new Date(lease.leaseEnd) : addMonths(start, 12)
  const payDay = lease.rentPayDay || start.getDate()
  const rows = []
  // 已儲存的期別（含未收款的「僅修改金額/應繳日」覆寫）：都列入明細；
  // 已繳者鎖定，未繳者維持可編輯。
  const stored = (rentPayments || [])
    .slice()
    .sort((a, b) => new Date(a.periodStart) - new Date(b.periodStart))
  stored.forEach((p, i) => {
    const paidAmt = p.paidAmount || 0
    rows.push({
      id: p.id,
      index: i + 1,
      label: `${ymd(p.periodStart)}~${ymd(p.periodEnd)}`,
      periodStart: p.periodStart,
      periodEnd: p.periodEnd,
      amount: p.amount,
      dueDate: p.dueDate,
      paidAmount: paidAmt,
      paidDate: p.paidDate,
      payMethod: p.payMethod,
      receiptUrl: p.receiptUrl,
      note: p.note,
      settled: !!p.settled,
      locked: paidAmt > 0,   // 只有已繳才鎖定；未繳覆寫仍可編輯
      // 已結清（含折扣時實收<應繳）視為無欠款；否則以應繳−已繳計算
      unpaid: p.settled ? 0 : Math.max(0, (p.amount || 0) - paidAmt),
    })
  })

  const lastStoredEnd = stored.reduce((max, p) => {
    const t = new Date(p.periodEnd).getTime()
    return t > max ? t : max
  }, 0)
  let periodStart = lastStoredEnd ? new Date(lastStoredEnd + 86400000) : new Date(start)
  if (periodStart < start) periodStart = new Date(start)
  let idx = 1
  while (periodStart <= leaseEnd && idx <= 120) {
    const nextStart = addMonths(periodStart, months)
    const periodEnd = new Date(Math.min(addMonths(periodStart, months).getTime() - 86400000, leaseEnd.getTime()))
    // 預設應繳日期：期別起始日前 3 天（CONTRACT_START 模式維持＝期別起始日）
    const due = lease.paymentDueMode === 'CONTRACT_START'
      ? new Date(periodStart)
      : new Date(new Date(periodStart).getTime() - 3 * 86400000)
    // 有停車費的合約：租金明細每期金額 ＝（折後租金 ＋ 停車費）× 期數
    const parking = lease.parkingFee || 0
    const amount = (effectiveRent(lease) + parking) * months
    rows.push({
      id: null,
      index: rows.length + 1,
      label: parking > 0
        ? `${ymd(periodStart)}~${ymd(periodEnd)}（含停車費 ${parking.toLocaleString()}）`
        : `${ymd(periodStart)}~${ymd(periodEnd)}`,
      periodStart,
      periodEnd,
      amount,
      dueDate: due,
      paidAmount: 0,
      paidDate: null,
      payMethod: null,
      receiptUrl: null,
      note: parking > 0 ? `含停車費 ${parking.toLocaleString()}/月` : null,
      parkingFee: parking,
      locked: false,
      unpaid: amount,
    })
    periodStart = nextStart
    idx++
  }
  return rows
}

function nextUnpaidRentRow(lease, today = new Date()) {
  // 取「最早一筆未繳」期別（含已逾期未繳）：逾期未繳者其應繳日為過去日期，
  // daysToRent 會是負數，前端顯示「逾期 N 天」；繳清後才會換到下一期，
  // 藉此讓逾期租客留在「即將繳費」分類，直到繳費為止。
  return buildRentSchedule(lease, lease.rentPayments || [])
    .filter(r => (r.unpaid || 0) > 0 && r.dueDate)
    .sort((a, b) => new Date(a.dueDate) - new Date(b.dueDate))[0] || null
}

function assertPeriod(period) {
  return typeof period === 'string' && /^\d{4}-\d{2}$/.test(period)
}

function periodEndDate(period) {
  const [year, month] = period.split('-').map(Number)
  return new Date(year, month, 1)
}

function calculateOwnerPayout(mp, records) {
  const grossRent = records.filter(r => r.type === 'INCOME').reduce((s, r) => s + r.amount, 0)
  const expenses = records.filter(r => r.type === 'EXPENSE').reduce((s, r) => s + r.amount, 0)
  let mgmtFee = 0
  let payoutAmount = 0

  if (mp.manageType === 'SUBLEASE') {
    mgmtFee = 0
    payoutAmount = grossRent - expenses
  } else {
    if (mp.feeType === 'FIXED') mgmtFee = mp.feeFixed
    else if (mp.feeType === 'PERCENT') mgmtFee = Math.round(grossRent * mp.feePercent / 100)
    payoutAmount = grossRent - mgmtFee - expenses
  }

  return { grossRent, expenses, mgmtFee, payoutAmount }
}

// ── 委託物業列表 ──────────────────────────────────────────────
router.get('/admin/api/managed', async (req, res) => {
  const auth = await resolveRole(req.query.key)
  if (!auth) return res.status(401).json({ error: 'unauthorized' })

  try {
    const items = await prisma.managedProperty.findMany({
      where: ownFilter(auth),
      orderBy: { createdAt: 'desc' },
      include: {
        _count: { select: { incomes: true, payouts: true } },
      },
    })
    res.json(items)
  } catch (e) {
    console.error('委託物業列表失敗:', e.message)
    res.status(500).json({ error: e.message })
  }
})

// ── 單一委託物業詳情（含收支與撥款） ──────────────────────────
router.get('/admin/api/managed/:id', async (req, res) => {
  const auth = await resolveRole(req.query.key)
  if (!auth) return res.status(401).json({ error: 'unauthorized' })

  try {
    const item = await prisma.managedProperty.findUnique({
      where: { id: req.params.id },
      include: {
        incomes: { orderBy: { recordDate: 'desc' } },
        payouts: {
          orderBy: { period: 'desc' },
          include: { records: { orderBy: { recordDate: 'asc' } } },
        },
      },
    })
    if (!item) return res.status(404).json({ error: 'not found' })
    if (auth.role !== 'super' && item.landlordId !== auth.landlordId) {
      return res.status(403).json({ error: 'forbidden' })
    }
    res.json(item)
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

// ── 新增委託物業 ──────────────────────────────────────────────
router.post('/admin/api/managed', express.json(), async (req, res) => {
  const auth = await resolveRole(req.query.key)
  if (!auth) return res.status(401).json({ error: 'unauthorized' })

  const b = req.body
  if (!b.ownerName || !b.title) {
    return res.status(400).json({ error: '屋主姓名與物業名稱為必填' })
  }

  // 房東只能建在自己名下；super 可指定 landlordId（預設自己若無則需傳）
  const landlordId = auth.role === 'super' ? (b.landlordId || auth.landlordId) : auth.landlordId
  if (!landlordId) return res.status(400).json({ error: '缺少 landlordId' })

  try {
    const item = await prisma.managedProperty.create({
      data: {
        landlordId,
        ownerName: b.ownerName,
        ownerPhone: b.ownerPhone || null,
        ownerEmail: b.ownerEmail || null,
        ownerBankName: b.ownerBankName || null,
        ownerBank: b.ownerBank || null,
        title: b.title,
        address: b.address || '',
        roomCount: parseInt(b.roomCount) || 1,
        manageType: ['TRUST', 'SUBLEASE', 'HYBRID'].includes(b.manageType) ? b.manageType : 'TRUST',
        contractStart: b.contractStart ? new Date(b.contractStart) : null,
        contractEnd: b.contractEnd ? new Date(b.contractEnd) : null,
        feePercent: parseFloat(b.feePercent) || 0,
        leaseCost: parseInt(b.leaseCost) || 0,
        subleaseFeeType: ['HALF_MONTH', 'ONE_MONTH', 'OTHER'].includes(b.subleaseFeeType) ? b.subleaseFeeType : null,
        subleaseFeeOther: parseInt(b.subleaseFeeOther) || 0,
        note: b.note || null,
      },
    })
    res.json(item)
  } catch (e) {
    console.error('新增委託物業失敗:', e.message)
    res.status(500).json({ error: e.message })
  }
})

// ── 編輯委託物業 ──────────────────────────────────────────────
router.post('/admin/api/managed/:id', express.json(), async (req, res) => {
  const auth = await resolveRole(req.query.key)
  if (!auth) return res.status(401).json({ error: 'unauthorized' })

  try {
    const existing = await prisma.managedProperty.findUnique({ where: { id: req.params.id } })
    if (!existing) return res.status(404).json({ error: 'not found' })
    if (auth.role !== 'super' && existing.landlordId !== auth.landlordId) {
      return res.status(403).json({ error: 'forbidden' })
    }

    const b = req.body
    const data = {}
    const strFields = ['ownerName', 'ownerPhone', 'ownerEmail', 'ownerBankName', 'ownerBank', 'title', 'address', 'note', 'status']
    strFields.forEach(f => { if (b[f] !== undefined) data[f] = b[f] || null })
    if (b.roomCount !== undefined) data.roomCount = parseInt(b.roomCount) || 1
    if (b.manageType !== undefined) data.manageType = ['TRUST', 'SUBLEASE', 'HYBRID'].includes(b.manageType) ? b.manageType : 'TRUST'
    if (b.contractStart !== undefined) data.contractStart = b.contractStart ? new Date(b.contractStart) : null
    if (b.contractEnd !== undefined) data.contractEnd = b.contractEnd ? new Date(b.contractEnd) : null
    if (b.feePercent !== undefined) data.feePercent = parseFloat(b.feePercent) || 0
    if (b.leaseCost !== undefined) data.leaseCost = parseInt(b.leaseCost) || 0
    if (b.subleaseFeeType !== undefined) data.subleaseFeeType = ['HALF_MONTH', 'ONE_MONTH', 'OTHER'].includes(b.subleaseFeeType) ? b.subleaseFeeType : null
    if (b.subleaseFeeOther !== undefined) data.subleaseFeeOther = parseInt(b.subleaseFeeOther) || 0

    const item = await prisma.managedProperty.update({ where: { id: req.params.id }, data })
    res.json(item)
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

// ── 刪除委託物業 ──────────────────────────────────────────────
router.delete('/admin/api/managed/:id', async (req, res) => {
  const auth = await resolveRole(req.query.key)
  if (!auth) return res.status(401).json({ error: 'unauthorized' })

  try {
    const existing = await prisma.managedProperty.findUnique({ where: { id: req.params.id } })
    if (!existing) return res.status(404).json({ error: 'not found' })
    if (auth.role !== 'super' && existing.landlordId !== auth.landlordId) {
      return res.status(403).json({ error: 'forbidden' })
    }
    await prisma.managedProperty.delete({ where: { id: req.params.id } })
    res.json({ ok: true })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

// ── 新增收支記錄 ──────────────────────────────────────────────
router.post('/admin/api/managed/:id/record', express.json(), async (req, res) => {
  const auth = await resolveRole(req.query.key)
  if (!auth) return res.status(401).json({ error: 'unauthorized' })

  try {
    const mp = await prisma.managedProperty.findUnique({ where: { id: req.params.id } })
    if (!mp) return res.status(404).json({ error: 'not found' })
    if (auth.role !== 'super' && mp.landlordId !== auth.landlordId) {
      return res.status(403).json({ error: 'forbidden' })
    }

    const b = req.body
    if (!b.amount) return res.status(400).json({ error: '金額為必填' })
    let leaseId = b.leaseId || null
    if (leaseId) {
      const lease = await prisma.lease.findUnique({ where: { id: leaseId }, select: { managedPropertyId: true } })
      if (!lease || lease.managedPropertyId !== req.params.id) {
        return res.status(400).json({ error: '租約不屬於此委託物業' })
      }
    }

    const record = await prisma.managementRecord.create({
      data: {
        managedPropertyId: req.params.id,
        leaseId,
        type: b.type === 'EXPENSE' ? 'EXPENSE' : 'INCOME',
        category: b.category || 'RENT',
        amount: parseInt(b.amount) || 0,
        recordDate: b.recordDate ? new Date(b.recordDate) : new Date(),
        description: b.description || null,
      },
    })
    res.json(record)
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

// ── 刪除收支記錄 ──────────────────────────────────────────────
router.delete('/admin/api/managed/record/:recordId', async (req, res) => {
  const auth = await resolveRole(req.query.key)
  if (!auth) return res.status(401).json({ error: 'unauthorized' })

  try {
    const record = await prisma.managementRecord.findUnique({
      where: { id: req.params.recordId },
      include: { managedProperty: true },
    })
    if (!record) return res.status(404).json({ error: 'not found' })
    if (auth.role !== 'super' && record.managedProperty.landlordId !== auth.landlordId) {
      return res.status(403).json({ error: 'forbidden' })
    }
    if (record.payoutId) return res.status(400).json({ error: '此收支已結算到撥款單，不能直接刪除' })
    await prisma.managementRecord.delete({ where: { id: req.params.recordId } })
    res.json({ ok: true })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

// ── 預覽某帳期可結算的屋主撥款 ────────────────────────────────
router.post('/admin/api/managed/:id/payout-preview', express.json(), async (req, res) => {
  const auth = await resolveRole(req.query.key)
  if (!auth) return res.status(401).json({ error: 'unauthorized' })

  const period = req.body.period
  if (!assertPeriod(period)) return res.status(400).json({ error: '帳期格式須為 YYYY-MM' })

  try {
    const mp = await prisma.managedProperty.findUnique({ where: { id: req.params.id } })
    if (!mp) return res.status(404).json({ error: 'not found' })
    if (auth.role !== 'super' && mp.landlordId !== auth.landlordId) {
      return res.status(403).json({ error: 'forbidden' })
    }

    const existing = await prisma.ownerPayout.findUnique({
      where: { managedPropertyId_period: { managedPropertyId: req.params.id, period } },
      include: { records: { orderBy: { recordDate: 'asc' } } },
    })
    if (existing?.status === 'PAID') {
      return res.status(400).json({ error: '此帳期已付款，不能重新計算；新收支請放到下一期結算' })
    }

    const end = periodEndDate(period)
    const records = await prisma.managementRecord.findMany({
      where: {
        managedPropertyId: req.params.id,
        recordDate: { lt: end },
        OR: existing ? [{ payoutId: null }, { payoutId: existing.id }] : [{ payoutId: null }],
      },
      orderBy: { recordDate: 'asc' },
    })
    res.json({ period, existingPayoutId: existing?.id || null, ...calculateOwnerPayout(mp, records), records })
  } catch (e) {
    console.error('預覽撥款失敗:', e.message)
    res.status(500).json({ error: e.message })
  }
})

// ── 確認建立某帳期的屋主撥款 ────────────────────────────────
// 只結算尚未綁定 payoutId 的收支；確認後會把本次明細鎖定到撥款單
router.post('/admin/api/managed/:id/payout', express.json(), async (req, res) => {
  const auth = await resolveRole(req.query.key)
  if (!auth) return res.status(401).json({ error: 'unauthorized' })

  const period = req.body.period  // 'YYYY-MM'
  if (!assertPeriod(period)) {
    return res.status(400).json({ error: '帳期格式須為 YYYY-MM' })
  }

  try {
    const mp = await prisma.managedProperty.findUnique({ where: { id: req.params.id } })
    if (!mp) return res.status(404).json({ error: 'not found' })
    if (auth.role !== 'super' && mp.landlordId !== auth.landlordId) {
      return res.status(403).json({ error: 'forbidden' })
    }

    const existing = await prisma.ownerPayout.findUnique({
      where: { managedPropertyId_period: { managedPropertyId: req.params.id, period } },
      include: { records: true },
    })
    if (existing?.status === 'PAID') {
      return res.status(400).json({ error: '此帳期已付款，不能重新計算；新收支請放到下一期結算' })
    }

    const end = periodEndDate(period)
    const records = await prisma.managementRecord.findMany({
      where: {
        managedPropertyId: req.params.id,
        recordDate: { lt: end },
        OR: existing ? [{ payoutId: null }, { payoutId: existing.id }] : [{ payoutId: null }],
      },
      orderBy: { recordDate: 'asc' },
    })
    const { grossRent, expenses, mgmtFee, payoutAmount } = calculateOwnerPayout(mp, records)
    if (!records.length) return res.status(400).json({ error: '目前沒有可結算的收支明細' })

    const payout = await prisma.$transaction(async tx => {
      let saved
      if (existing) {
        await tx.managementRecord.updateMany({ where: { payoutId: existing.id }, data: { payoutId: null } })
        saved = await tx.ownerPayout.update({
          where: { id: existing.id },
          data: { grossRent, mgmtFee, expenses, payoutAmount },
        })
      } else {
        saved = await tx.ownerPayout.create({
          data: { managedPropertyId: req.params.id, period, grossRent, mgmtFee, expenses, payoutAmount },
        })
      }
      if (records.length) {
        await tx.managementRecord.updateMany({
          where: { id: { in: records.map(r => r.id) } },
          data: { payoutId: saved.id },
        })
      }
      return tx.ownerPayout.findUnique({
        where: { id: saved.id },
        include: { records: { orderBy: { recordDate: 'asc' } } },
      })
    })
    res.json(payout)
  } catch (e) {
    console.error('計算撥款失敗:', e.message)
    res.status(500).json({ error: e.message })
  }
})

// ── 標記撥款為已付/未付 ───────────────────────────────────────
router.post('/admin/api/managed/payout/:payoutId/status', express.json(), async (req, res) => {
  const auth = await resolveRole(req.query.key)
  if (!auth) return res.status(401).json({ error: 'unauthorized' })

  try {
    const payout = await prisma.ownerPayout.findUnique({
      where: { id: req.params.payoutId },
      include: { managedProperty: true },
    })
    if (!payout) return res.status(404).json({ error: 'not found' })
    if (auth.role !== 'super' && payout.managedProperty.landlordId !== auth.landlordId) {
      return res.status(403).json({ error: 'forbidden' })
    }

    const paid = req.body.status === 'PAID'
    const updated = await prisma.ownerPayout.update({
      where: { id: req.params.payoutId },
      data: { status: paid ? 'PAID' : 'PENDING', paidDate: paid ? new Date() : null },
    })
    res.json(updated)
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

// ── 報表：整體收支總覽 ────────────────────────────────────────
router.get('/admin/api/managed-report', async (req, res) => {
  const auth = await resolveRole(req.query.key)
  if (!auth) return res.status(401).json({ error: 'unauthorized' })

  try {
    // ── 期間 ──
    const range = req.query.range || 'all'
    const now = new Date()
    const y = now.getFullYear(), mo = now.getMonth()
    let start = null, end = null
    if (range === 'thisMonth') { start = new Date(y, mo, 1); end = new Date(y, mo + 1, 0, 23, 59, 59, 999) }
    else if (range === 'lastMonth') { start = new Date(y, mo - 1, 1); end = new Date(y, mo, 0, 23, 59, 59, 999) }
    else if (range === 'thisQuarter') { const q = Math.floor(mo / 3); start = new Date(y, q * 3, 1); end = new Date(y, q * 3 + 3, 0, 23, 59, 59, 999) }
    else if (range === 'thisYear') { start = new Date(y, 0, 1); end = new Date(y, 11, 31, 23, 59, 59, 999) }
    else if (range === 'custom') {
      if (req.query.from) start = startOfDay(req.query.from)
      if (req.query.to) { end = startOfDay(req.query.to); end.setHours(23, 59, 59, 999) }
    }
    const asOf = end || now  // 未收以期末（或今天）為準

    // ── 篩選選項（不受目前篩選影響，供下拉選單）──
    const allProps = await prisma.managedProperty.findMany({
      where: { ...ownFilter(auth), status: 'ACTIVE' },
      select: { id: true, title: true, ownerName: true },
      orderBy: { title: 'asc' },
    })
    const owners = [...new Set(allProps.map(p => p.ownerName).filter(Boolean))]

    // ── 套用篩選的物業 ──
    const where = { ...ownFilter(auth), status: 'ACTIVE' }
    if (req.query.propertyId) where.id = req.query.propertyId
    if (req.query.ownerName) where.ownerName = req.query.ownerName
    const dateWhere = (start || end) ? { recordDate: { ...(start ? { gte: start } : {}), ...(end ? { lte: end } : {}) } } : null
    const props = await prisma.managedProperty.findMany({
      where,
      include: {
        incomes: dateWhere ? { where: dateWhere } : true,
        payouts: true,
      },
    })
    const propIds = props.map(p => p.id)

    // ── 未收租金／未收水電（以期末為準）：抓合約與抄表 ──
    const leases = propIds.length ? await prisma.lease.findMany({
      where: { managedPropertyId: { in: propIds } },
      include: { rentPayments: true },
    }) : []
    const leaseIds = leases.map(l => l.id)
    const leaseById = {}; leases.forEach(l => { leaseById[l.id] = l })
    const propTitleById = {}; props.forEach(p => { propTitleById[p.id] = p.title })
    const leaseToProp = {}; leases.forEach(l => { leaseToProp[l.id] = l.managedPropertyId })
    const readings = leaseIds.length ? await prisma.utilityReading.findMany({ where: { leaseId: { in: leaseIds } } }) : []
    const unpaidRentByProp = {}, unpaidUtilByProp = {}
    const unpaidList = []  // 催收清單
    const todayStart = startOfDay(now)
    for (const l of leases) {
      let ur = 0
      try {
        const sched = buildRentSchedule(l, l.rentPayments)
        sched.filter(r => r.dueDate && startOfDay(r.dueDate) <= asOf && (r.unpaid || 0) > 0).forEach(r => {
          ur += r.unpaid
          unpaidList.push({
            propertyId: l.managedPropertyId, property: propTitleById[l.managedPropertyId] || '',
            tenant: l.tenantName, roomLabel: l.roomLabel, kind: 'RENT',
            amount: r.unpaid, dueDate: r.dueDate,
            overdueDays: Math.max(0, Math.floor((todayStart - startOfDay(r.dueDate)) / 86400000)),
          })
        })
      } catch (e) { /* 單筆排程異常不影響整體 */ }
      unpaidRentByProp[l.managedPropertyId] = (unpaidRentByProp[l.managedPropertyId] || 0) + ur
    }
    for (const rd of readings) {
      if (rd.endDate && startOfDay(rd.endDate) > asOf) continue
      const u = Math.max(0, (rd.amount || 0) - (rd.paidAmount || 0))
      if (u > 0) {
        const pid = leaseToProp[rd.leaseId]; const l = leaseById[rd.leaseId] || {}
        unpaidUtilByProp[pid] = (unpaidUtilByProp[pid] || 0) + u
        const due = rd.dueDate || rd.endDate
        unpaidList.push({
          propertyId: pid, property: propTitleById[pid] || '',
          tenant: l.tenantName, roomLabel: l.roomLabel, kind: 'UTILITY',
          amount: u, dueDate: due,
          overdueDays: due ? Math.max(0, Math.floor((todayStart - startOfDay(due)) / 86400000)) : 0,
        })
      }
    }
    unpaidList.sort((a, b) => new Date(a.dueDate || 0) - new Date(b.dueDate || 0))

    // ── 承租成本月數：固定期間＝期間月數（對齊今天）；全部＝各物業合約起日至今 ──
    const monthsBetween = (a, b) => {
      const A = new Date(a), B = new Date(b)
      return Math.max(1, (B.getFullYear() * 12 + B.getMonth()) - (A.getFullYear() * 12 + A.getMonth()) + 1)
    }
    const costEnd = new Date(Math.min((end || now).getTime(), now.getTime()))
    const fixedMonths = start ? monthsBetween(start, costEnd) : null

    // ── 逐物業彙總 ──
    let actualIncome = 0, expenseTotal = 0, mgmtFeeTotal = 0, paidOutTotal = 0, pendingPayout = 0
    let unpaidRentTotal = 0, unpaidUtilTotal = 0, profitTotal = 0, ownerCostTotal = 0
    const byProperty = props.map(p => {
      const income = p.incomes.filter(r => r.type === 'INCOME').reduce((s, r) => s + r.amount, 0)  // 期間實收
      const expense = p.incomes.filter(r => r.type === 'EXPENSE').reduce((s, r) => s + r.amount, 0)
      const mgmtFee = p.payouts.reduce((s, r) => s + r.mgmtFee, 0)
      const paidOut = p.payouts.filter(r => r.status === 'PAID').reduce((s, r) => s + r.payoutAmount, 0)
      const pending = p.payouts.filter(r => r.status === 'PENDING').reduce((s, r) => s + r.payoutAmount, 0)
      const unpaidRent = unpaidRentByProp[p.id] || 0
      const unpaidUtil = unpaidUtilByProp[p.id] || 0
      const isSublease = p.manageType !== 'TRUST'  // SUBLEASE / HYBRID 皆有承租成本
      // 承租成本＝每月付屋主 × 月數（固定期間用期間月數；全部用合約起日至今）
      const ownerMonths = fixedMonths != null ? fixedMonths : (p.contractStart ? monthsBetween(p.contractStart, now) : 1)
      const ownerCost = isSublease ? (p.leaseCost || 0) * ownerMonths : 0
      // 平台利潤：代管=管理費；包租=實收-承租成本-支出
      const profit = p.manageType === 'TRUST' ? mgmtFee : (income - ownerCost - expense)

      actualIncome += income; expenseTotal += expense; mgmtFeeTotal += mgmtFee
      paidOutTotal += paidOut; pendingPayout += pending
      unpaidRentTotal += unpaidRent; unpaidUtilTotal += unpaidUtil; profitTotal += profit; ownerCostTotal += ownerCost

      return {
        id: p.id, title: p.title, ownerName: p.ownerName, manageType: p.manageType,
        income, expense, mgmtFee, paidOut, pending, unpaidRent, unpaidUtil,
        unpaid: unpaidRent + unpaidUtil, ownerCost, leaseCost: p.leaseCost || 0, ownerMonths, profit,
      }
    })
    const netCashflow = actualIncome - expenseTotal - paidOutTotal

    // ── 收入分類（期間內，依 category）──
    const CAT_LABEL = { RENT: '租金', UTILITY: '水電', PARKING: '車位', REPAIR: '維修', OTHER: '其他' }
    const catMap = {}
    props.forEach(p => p.incomes.filter(r => r.type === 'INCOME').forEach(r => {
      const c = r.category || 'OTHER'
      catMap[c] = (catMap[c] || 0) + r.amount
    }))
    const incomeByCategory = Object.keys(catMap).map(k => ({ category: k, label: CAT_LABEL[k] || k, amount: catMap[k] }))
      .sort((a, b) => b.amount - a.amount)

    // ── 近 12 個月趨勢（實收 / 支出，依 recordDate 月份）──
    const trendStart = new Date(y, mo - 11, 1)
    const trendRecords = propIds.length ? await prisma.managementRecord.findMany({
      where: { managedPropertyId: { in: propIds }, recordDate: { gte: trendStart } },
      select: { type: true, amount: true, recordDate: true },
    }) : []
    const trendMap = {}
    for (let i = 0; i < 12; i++) {
      const d = new Date(y, mo - 11 + i, 1)
      trendMap[d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0')] = { income: 0, expense: 0 }
    }
    trendRecords.forEach(r => {
      const d = new Date(r.recordDate)
      const k = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0')
      if (trendMap[k]) { if (r.type === 'INCOME') trendMap[k].income += r.amount; else trendMap[k].expense += r.amount }
    })
    const trend = Object.keys(trendMap).sort().map(k => ({ month: k, income: trendMap[k].income, expense: trendMap[k].expense }))

    res.json({
      range, from: start, to: end,
      incomeByCategory,
      unpaidList: unpaidList.slice(0, 200),
      trend,
      filters: { owners, properties: allProps, ownerName: req.query.ownerName || '', propertyId: req.query.propertyId || '' },
      summary: {
        count: props.length,
        actualIncome, expense: expenseTotal, mgmtFee: mgmtFeeTotal,
        unpaidRent: unpaidRentTotal, unpaidUtil: unpaidUtilTotal, unpaidTotal: unpaidRentTotal + unpaidUtilTotal,
        ownerCost: ownerCostTotal,
        paidOut: paidOutTotal, pendingPayout, profit: profitTotal, netCashflow,
        // 相容舊欄位
        totalIncome: actualIncome, totalExpense: expenseTotal, totalMgmtFee: mgmtFeeTotal,
      },
      byProperty,
    })
  } catch (e) {
    console.error('報表失敗:', e.message)
    res.status(500).json({ error: e.message })
  }
})

// ── 從 Gmail 匯入台電電費帳單 → 建立為委託物業支出 ──
// 路由用連字號（managed-import-taipower）避免被 /admin/api/managed/:id 攔截
// apply=false：預覽（解析＋對應，不建立）；apply=true：建立支出（防重複）
router.post('/admin/api/managed-import-taipower', express.json(), async (req, res) => {
  const auth = await resolveRole(req.query.key)
  if (!auth) return res.status(401).json({ error: 'unauthorized' })
  try {
    const properties = await prisma.managedProperty.findMany({
      where: { ...ownFilter(auth), status: 'ACTIVE' },
      select: { id: true, title: true, address: true },
    })
    const apply = req.body && (req.body.apply === true || req.body.apply === 'true')
    const result = await importTaipowerBills({ properties, apply })
    res.json(result)
  } catch (e) {
    console.error('台電匯入失敗:', e.message)
    res.status(e.code === 'NO_CONFIG' ? 400 : 500).json({ error: e.message })
  }
})

// ── Bot 靜音名單管理（存 SiteSetting key=bot_muted_user_ids）──
async function readMutedList() {
  const row = await prisma.siteSetting.findUnique({ where: { key: 'bot_muted_user_ids' } })
  if (row && row.value) { try { return JSON.parse(row.value) } catch (_) {} }
  return []
}
router.get('/admin/api/bot-mute', async (req, res) => {
  const auth = await resolveRole(req.query.key)
  if (!auth) return res.status(401).json({ error: 'unauthorized' })
  try {
    const userIds = await readMutedList()
    // 帶入 LINE 頭像與名字（從 Tenant 檔；同一 userId 可能多列，取有資料者）
    const byUid = {}
    if (userIds.length) {
      const tenants = await prisma.tenant.findMany({
        where: { lineUserId: { in: userIds } },
        select: { lineUserId: true, name: true, customName: true, avatarUrl: true },
      })
      tenants.forEach(t => {
        const cur = byUid[t.lineUserId] || (byUid[t.lineUserId] = { name: '', avatar: '' })
        if (!cur.name && (t.customName || t.name)) cur.name = t.customName || t.name
        if (!cur.avatar && t.avatarUrl) cur.avatar = t.avatarUrl
      })
    }
    const list = userIds.map(u => ({ userId: u, name: (byUid[u] && byUid[u].name) || '', avatar: (byUid[u] && byUid[u].avatar) || '' }))
    res.json({ userIds, list })
  } catch (e) { res.status(500).json({ error: e.message }) }
})
router.post('/admin/api/bot-mute', express.json(), async (req, res) => {
  const auth = await resolveRole(req.query.key)
  if (!auth) return res.status(401).json({ error: 'unauthorized' })
  try {
    const b = req.body || {}
    let set = new Set((await readMutedList()).map(u => String(u).trim()).filter(Boolean))
    if (Array.isArray(b.userIds)) {
      set = new Set(b.userIds.map(u => String(u).trim()).filter(Boolean))  // 整批覆寫
    } else if (b.userId) {
      const uid = String(b.userId).trim()
      if (uid) { if (b.muted === false) set.delete(uid); else set.add(uid) }
    }
    const arr = [...set]
    await prisma.siteSetting.upsert({
      where: { key: 'bot_muted_user_ids' },
      update: { value: JSON.stringify(arr) },
      create: { key: 'bot_muted_user_ids', value: JSON.stringify(arr) },
    })
    res.json({ ok: true, userIds: arr })
  } catch (e) {
    console.error('更新靜音名單失敗:', e.message)
    res.status(500).json({ error: e.message })
  }
})

// ── 自動租金提醒模式（off／auto／confirm）──
// 權限控制：總管理員設定「全域預設」；一般房東設定「自己的」（只能改自己的）。
function rentReminderSettingKey(auth) {
  return auth.role === 'super' ? 'auto_rent_reminder_mode' : `rent_reminder_mode:${auth.landlordId}`
}
router.get('/admin/api/managed-rent-reminder-mode', async (req, res) => {
  const auth = await resolveRole(req.query.key)
  if (!auth) return res.status(401).json({ error: 'unauthorized' })
  if (auth.role !== 'super' && !auth.landlordId) return res.status(403).json({ error: 'forbidden' })
  try {
    const norm = v => (v === 'off' || v === 'confirm' || v === 'auto') ? v : null
    const own = await prisma.siteSetting.findUnique({ where: { key: rentReminderSettingKey(auth) } })
    let mode = norm(own && own.value)
    // 房東未自訂 → 顯示全域預設（僅供參考），實際仍以自己設定為主
    if (!mode && auth.role !== 'super') {
      const g = await prisma.siteSetting.findUnique({ where: { key: 'auto_rent_reminder_mode' } })
      mode = norm(g && g.value)
    }
    res.json({ ok: true, mode: mode || 'auto', scope: auth.role === 'super' ? 'global' : 'landlord' })
  } catch (e) { res.status(500).json({ error: e.message }) }
})
router.post('/admin/api/managed-rent-reminder-mode', express.json(), async (req, res) => {
  const auth = await resolveRole(req.query.key)
  if (!auth) return res.status(401).json({ error: 'unauthorized' })
  if (auth.role !== 'super' && !auth.landlordId) return res.status(403).json({ error: 'forbidden' })
  const mode = req.body && req.body.mode
  if (!['off', 'auto', 'confirm'].includes(mode)) return res.status(400).json({ error: 'mode 需為 off/auto/confirm' })
  try {
    const key = rentReminderSettingKey(auth)
    await prisma.siteSetting.upsert({ where: { key }, update: { value: mode }, create: { key, value: mode } })
    res.json({ ok: true, mode, scope: auth.role === 'super' ? 'global' : 'landlord' })
  } catch (e) { res.status(500).json({ error: e.message }) }
})

// ── 測試：立即發送一則「租金提醒待確認」給房東（僅總管理員）──
router.post('/admin/api/managed-rent-reminder-test', express.json(), async (req, res) => {
  const auth = await resolveRole(req.query.key)
  if (!auth) return res.status(401).json({ error: 'unauthorized' })
  if (auth.role !== 'super' && !auth.landlordId) return res.status(403).json({ error: 'forbidden' })
  try {
    const { sendRentReminderTest } = require('../../leaseReminder')
    // 房東只能測自己的；總管理員可指定或不限
    const scopeLandlordId = auth.role === 'super'
      ? (req.body && req.body.landlordId ? String(req.body.landlordId) : null)
      : auth.landlordId
    const result = await sendRentReminderTest(scopeLandlordId)
    if (!result.ok) return res.status(400).json(result)
    res.json(result)
  } catch (e) {
    console.error('租金提醒測試失敗:', e.message)
    res.status(500).json({ error: e.message })
  }
})

// ── LINE 群發：對選定租約批次推播（圖片＋文字）──
// 連字號路由避免被 /admin/api/managed/:id 攔截
router.post('/admin/api/managed-broadcast', express.json(), async (req, res) => {
  const auth = await resolveRole(req.query.key)
  if (!auth) return res.status(401).json({ error: 'unauthorized' })
  const b = req.body || {}
  const leaseIds = Array.isArray(b.leaseIds) ? b.leaseIds : []
  const text = (b.text || '').trim()
  const imageUrl = (b.imageUrl || '').trim()
  if (!leaseIds.length) return res.status(400).json({ error: '請選擇發送對象' })
  if (!text && !imageUrl) return res.status(400).json({ error: '請輸入文字或上傳圖片' })
  // 以 NDJSON 串流逐筆回報進度（前端顯示即時發送人數/百分比）
  res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8')
  res.setHeader('Cache-Control', 'no-cache')
  res.setHeader('X-Accel-Buffering', 'no')
  const send = (obj) => { try { res.write(JSON.stringify(obj) + '\n') } catch (_) {} }
  // 組訊息（圖片在前、文字在後）
  const messages = []
  if (imageUrl) messages.push({ type: 'image', originalContentUrl: imageUrl, previewImageUrl: imageUrl })
  if (text) messages.push({ type: 'text', text })
  try {
    const total = leaseIds.length
    send({ type: 'start', total })
    const results = []
    let sent = 0, failed = 0
    for (let i = 0; i < leaseIds.length; i++) {
      const id = leaseIds[i]
      const lease = await getOwnedLease(auth, id)
      if (!lease || lease === false) {
        failed++; results.push({ leaseId: id, ok: false, error: lease === false ? 'forbidden' : 'not found' })
      } else if (!lease.lineUserId) {
        failed++; results.push({ leaseId: id, tenant: lease.tenantName, room: lease.roomLabel, ok: false, error: '未綁定 LINE' })
      } else {
        try {
          const r = await pushToLeaseTenant(lease, messages)
          sent++; results.push({ leaseId: id, tenant: lease.tenantName, room: lease.roomLabel, ok: true, via: r.via })
        } catch (e) {
          failed++; results.push({ leaseId: id, tenant: lease.tenantName, room: lease.roomLabel, ok: false, error: e.message })
        }
      }
      send({ type: 'progress', current: i + 1, total, sent, failed })
    }
    send({ type: 'done', sent, failed, results })
    res.end()
  } catch (e) {
    console.error('LINE 群發失敗:', e.message)
    send({ type: 'done', sent: 0, failed: leaseIds.length, results: [], error: e.message })
    res.end()
  }
})

// ── 編輯委託物業的合約條款（押金、付款方式、合約文件） ──────────
router.post('/admin/api/managed/:id/contract', express.json(), async (req, res) => {
  const auth = await resolveRole(req.query.key)
  if (!auth) return res.status(401).json({ error: 'unauthorized' })

  try {
    const mp = await prisma.managedProperty.findUnique({ where: { id: req.params.id } })
    if (!mp) return res.status(404).json({ error: 'not found' })
    if (auth.role !== 'super' && mp.landlordId !== auth.landlordId) {
      return res.status(403).json({ error: 'forbidden' })
    }
    const b = req.body
    const data = {}
    if (b.deposit !== undefined) data.deposit = parseInt(b.deposit) || 0
    if (b.payDay !== undefined) data.payDay = b.payDay ? parseInt(b.payDay) : null
    if (b.payMethod !== undefined) data.payMethod = b.payMethod || null
    if (b.contractFile !== undefined) data.contractFile = b.contractFile || null
    const updated = await prisma.managedProperty.update({ where: { id: req.params.id }, data })
    res.json(updated)
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

// ── 租賃合約：列出某物業的所有租約 ────────────────────────────
router.get('/admin/api/managed/:id/leases', async (req, res) => {
  const auth = await resolveRole(req.query.key)
  if (!auth) return res.status(401).json({ error: 'unauthorized' })
  try {
    const mp = await prisma.managedProperty.findUnique({ where: { id: req.params.id } })
    if (!mp) return res.status(404).json({ error: 'not found' })
    if (auth.role !== 'super' && mp.landlordId !== auth.landlordId) {
      return res.status(403).json({ error: 'forbidden' })
    }
    const leases = await prisma.lease.findMany({
      where: { managedPropertyId: req.params.id },
    })
    // 依房號文字升冪排序（數字自然排序：21-2 在 21-10 之前）
    leases.sort((a, b) => String(a.roomLabel || '').localeCompare(String(b.roomLabel || ''), 'zh-Hant', { numeric: true }))
    res.json(leases)
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

// ── 新增/編輯租賃合約 ─────────────────────────────────────────
router.post('/admin/api/managed/:id/lease', express.json(), async (req, res) => {
  const auth = await resolveRole(req.query.key)
  if (!auth) return res.status(401).json({ error: 'unauthorized' })
  try {
    const mp = await prisma.managedProperty.findUnique({ where: { id: req.params.id } })
    if (!mp) return res.status(404).json({ error: 'not found' })
    if (auth.role !== 'super' && mp.landlordId !== auth.landlordId) {
      return res.status(403).json({ error: 'forbidden' })
    }
    const b = req.body
    if (!b.tenantName) return res.status(400).json({ error: '承租人姓名為必填' })
    if (b.leaseId) {
      const existingLease = await prisma.lease.findUnique({
        where: { id: b.leaseId },
        select: { managedPropertyId: true },
      })
      if (!existingLease || existingLease.managedPropertyId !== req.params.id) {
        return res.status(403).json({ error: 'forbidden' })
      }
    }

    const data = {
      tenantName: b.tenantName,
      tenantPhone: b.tenantPhone || null,
      tenantIdNo: b.tenantIdNo || null,
      roomLabel: b.roomLabel || null,
      rent: parseInt(b.rent) || 0,
      discountType: ['NONE', 'FIXED', 'PERCENT'].includes(b.discountType) ? b.discountType : 'NONE',
      discountValue: parseFloat(b.discountValue) || 0,
      deposit: parseInt(b.deposit) || 0,
      prepaidUtility: parseInt(b.prepaidUtility) || 0,
      payDay: b.payDay ? parseInt(b.payDay) : null,
      payMethod: b.payMethod || null,
      leaseStart: b.leaseStart ? new Date(b.leaseStart) : null,
      leaseEnd: b.leaseEnd ? new Date(b.leaseEnd) : null,
      contractFile: b.contractFile || null,
      status: b.status || 'ACTIVE',
      note: b.note || null,
      // 房源連結
      propertyId: b.propertyId || null,
      // LINE 綁定
      lineTenantId: b.lineTenantId || null,
      lineUserId: b.lineUserId || null,
      // 繳費提醒
      rentPayDay: b.rentPayDay ? parseInt(b.rentPayDay) : 5,
      paymentCycle: ['MONTHLY','BIMONTHLY','QUARTERLY','SEMIANNUAL','YEARLY'].includes(b.paymentCycle) ? b.paymentCycle : 'MONTHLY',
      paymentDueMode: ['FIXED_DAY','CONTRACT_START'].includes(b.paymentDueMode) ? b.paymentDueMode : 'FIXED_DAY',
      rentRemindOn: b.rentRemindOn !== false && b.rentRemindOn !== 'false',
      utilPayDay: b.utilPayDay ? parseInt(b.utilPayDay) : null,
      utilRemindOn: b.utilRemindOn === true || b.utilRemindOn === 'true',
      utilAmount: parseInt(b.utilAmount) || 0,
      // 水電費率模式 + 電表
      utilMode: b.utilMode === 'METER' ? 'METER' : 'FIXED',
      meterReadDate: b.meterReadDate ? new Date(b.meterReadDate) : null,
      meterCurrent: parseInt(b.meterCurrent) || 0,
      meterNext: parseInt(b.meterNext) || 0,
      meterRate: parseFloat(b.meterRate) || 0,
      meterInitial: parseInt(b.meterInitial) || 0,
      parkingSpotId: b.parkingSpotId || null,
      parkingSpace: b.parkingSpace || null,
      parkingFee: parseInt(b.parkingFee) || 0,
      vehiclePlate: b.vehiclePlate || null,
    }

    let lease
    if (b.leaseId) {
      lease = await prisma.lease.update({ where: { id: b.leaseId }, data })
    } else {
      lease = await prisma.lease.create({ data: { ...data, managedPropertyId: req.params.id } })
    }
    // 以合約為準，同步門鎖房間的 userId（房號比對；無對應則不動）
    try { await require('../../smartlock').syncLockRoomsFromLeases(mp.landlordId) } catch (e) { console.error('門鎖同步失敗:', e.message) }
    res.json(lease)
  } catch (e) {
    console.error('租約儲存失敗:', e.message)
    res.status(500).json({ error: e.message })
  }
})

// ── 刪除租賃合約 ──────────────────────────────────────────────
router.delete('/admin/api/managed/lease/:leaseId', async (req, res) => {
  const auth = await resolveRole(req.query.key)
  if (!auth) return res.status(401).json({ error: 'unauthorized' })
  try {
    const lease = await prisma.lease.findUnique({
      where: { id: req.params.leaseId },
      include: { managedProperty: true },
    })
    if (!lease) return res.status(404).json({ error: 'not found' })
    if (auth.role !== 'super' && lease.managedProperty.landlordId !== auth.landlordId) {
      return res.status(403).json({ error: 'forbidden' })
    }
    await prisma.lease.delete({ where: { id: req.params.leaseId } })
    res.json({ ok: true })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

// ── 到期提醒：列出即將到期的合約（委託 + 租約，預設 30 天內） ──
router.get('/admin/api/managed-expiring', async (req, res) => {
  const auth = await resolveRole(req.query.key)
  if (!auth) return res.status(401).json({ error: 'unauthorized' })
  const days = parseInt(req.query.days) || 30
  const now = new Date()
  const limit = new Date(now.getTime() + days * 86400000)

  try {
    // 即將到期的委託合約
    const managedExpiring = await prisma.managedProperty.findMany({
      where: {
        ...ownFilter(auth),
        status: 'ACTIVE',
        contractEnd: { gte: now, lte: limit },
      },
      select: { id: true, title: true, ownerName: true, contractEnd: true },
    })

    // 即將到期的租約
    const leaseWhere = {
      status: 'ACTIVE',
      leaseEnd: { gte: now, lte: limit },
    }
    if (auth.role !== 'super') {
      leaseWhere.managedProperty = { landlordId: auth.landlordId }
    }
    const leasesExpiring = await prisma.lease.findMany({
      where: leaseWhere,
      include: { managedProperty: { select: { title: true } } },
    })

    res.json({
      managed: managedExpiring.map(m => ({
        type: '委託合約', id: m.id, title: m.title,
        who: m.ownerName, endDate: m.contractEnd,
      })),
      leases: leasesExpiring.map(l => ({
        type: '租約', id: l.id, title: l.managedProperty.title,
        who: l.tenantName, room: l.roomLabel, endDate: l.leaseEnd,
      })),
    })
  } catch (e) {
    console.error('到期提醒失敗:', e.message)
    res.status(500).json({ error: e.message })
  }
})

// ── 取得可綁定的租客清單（已加 Bot 的 LINE 用戶） ──────────────
router.get('/admin/api/managed-tenants', async (req, res) => {
  const auth = await resolveRole(req.query.key)
  if (!auth) return res.status(401).json({ error: 'unauthorized' })
  try {
    const where = {}
    if (auth.role !== 'super') where.landlordId = auth.landlordId
    const tenants = await prisma.tenant.findMany({
      where,
      select: { id: true, name: true, customName: true, lineUserId: true, phone: true },
      orderBy: { createdAt: 'desc' },
      take: 200,
    })
    res.json(tenants.map(t => ({
      id: t.id,
      lineUserId: t.lineUserId,
      label: (t.customName || t.name || '未命名') + (t.phone ? ' (' + t.phone + ')' : ''),
    })))
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

// ── 取得可連結的房源清單 ──────────────────────────────────────
router.get('/admin/api/managed-properties-list', async (req, res) => {
  const auth = await resolveRole(req.query.key)
  if (!auth) return res.status(401).json({ error: 'unauthorized' })
  try {
    const where = { deletedAt: null }
    if (auth.role !== 'super') where.ownerId = auth.landlordId
    const props = await prisma.property.findMany({
      where,
      select: { id: true, title: true, city: true, district: true },
      orderBy: { createdAt: 'desc' },
      take: 300,
    })
    res.json(props.map(p => ({
      id: p.id,
      label: p.title + (p.city ? ' · ' + p.city + (p.district || '') : ''),
    })))
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

// ── 代管清單（所有租約，依狀態分組，含下期收租日） ─────────────
router.get('/admin/api/managed-leases', async (req, res) => {
  const auth = await resolveRole(req.query.key)
  if (!auth) return res.status(401).json({ error: 'unauthorized' })
  try {
    const where = {}
    if (auth.role !== 'super') {
      where.managedProperty = { landlordId: auth.landlordId }
    }
    const leases = await prisma.lease.findMany({
      where,
      include: {
        managedProperty: { select: { id: true, title: true, ownerName: true } },
        rentPayments: { orderBy: { periodStart: 'asc' } },
      },
      orderBy: { leaseEnd: 'asc' },
    })

    const now = new Date()
    const today = startOfDay(now)
    const rentDueLimit = startOfDay(now)
    rentDueLimit.setDate(rentDueLimit.getDate() + 30)  // 即將繳費：一個月內
    const result = leases.map(l => {
      // 單筆計算失敗（例如租金排程資料異常）也不整個清單掛掉，退回最基本欄位。
      let computedStatus = l.status
      let daysToEnd = null
      let nextRentDate = null
      let daysToRent = null
      let nextRentAmount = null
      try {
        if (l.leaseEnd) {
          daysToEnd = Math.ceil((new Date(l.leaseEnd) - now) / 86400000)
          if (l.status === 'ACTIVE') {
            if (daysToEnd < 0) computedStatus = 'EXPIRED'
            else if (daysToEnd <= 30) computedStatus = 'EXPIRING'
          }
        }
        // 用租金明細排程計算下一筆未繳租金，避免繳費週期/合約起日/已繳紀錄算錯。
        const nextRent = l.status === 'ACTIVE' ? nextUnpaidRentRow(l, now) : null
        if (nextRent) {
          nextRentDate = nextRent.dueDate
          nextRentAmount = nextRent.amount
          daysToRent = Math.ceil((startOfDay(nextRentDate) - today) / 86400000)
        }
      } catch (e) {
        console.error('代管清單單筆計算失敗:', l.id, e.message)
      }
      return {
        id: l.id,
        tenantName: l.tenantName,
        roomLabel: l.roomLabel,
        rent: l.rent,
        paymentCycle: l.paymentCycle,
        paymentDueMode: l.paymentDueMode,
        leaseStart: l.leaseStart,
        leaseEnd: l.leaseEnd,
        daysToEnd,
        status: computedStatus,
        propertyId: l.propertyId,
        lineUserId: l.lineUserId,
        lineTenantId: l.lineTenantId,
        lineImported: !!l.lineUserId,
        lineLinked: !!l.lineTenantId,
        lineBound: !!l.lineUserId,
        rentPayDay: l.rentPayDay,
        nextRentDate,
        nextRentAmount,
        daysToRent,
        managedTitle: l.managedProperty ? l.managedProperty.title : '未連結物業',
        managedId: l.managedProperty ? l.managedProperty.id : '',
        ownerName: l.managedProperty ? l.managedProperty.ownerName : '（未填房東）',
        // 結算資訊
        settledAt: l.settledAt,
        earlyTerminated: !!l.earlyTerminated,
        endedAt: l.endedAt,
        settleRefund: l.settleRefund,
      }
    })

    // 合約期間內（含即將到期）＝承租中
    const inPeriod = r => r.status === 'ACTIVE' || r.status === 'EXPIRING'
    res.json({
      overview: result.filter(r => r.status !== 'ENDED'),          // 總覽：所有未結束合約
      active: result.filter(inPeriod),                              // 承租中：合約期間內（含即將到期）
      rentDueSoon: result.filter(r => inPeriod(r) && r.nextRentDate && startOfDay(r.nextRentDate) <= rentDueLimit),
      expiring: result.filter(r => r.status === 'EXPIRING'),        // 即將到期：30 天內到期
      expired: result.filter(r => r.status === 'EXPIRED' || r.status === 'ENDED'), // 已到期（含已結算）
    })
  } catch (e) {
    console.error('代管清單失敗:', e.message)
    res.status(500).json({ error: e.message })
  }
})

// ── 批次設定所有合約的預收電費 ────────────────────────────────
router.post('/admin/api/managed/leases/bulk-prepaid', express.json(), async (req, res) => {
  const auth = await resolveRole(req.query.key)
  if (!auth) return res.status(401).json({ error: 'unauthorized' })
  try {
    const amount = parseInt(req.body.amount)
    if (isNaN(amount) || amount < 0) return res.status(400).json({ error: '金額不正確' })
    const where = {}
    if (auth.role !== 'super') {
      const props = await prisma.managedProperty.findMany({ where: { landlordId: auth.landlordId }, select: { id: true } })
      where.managedPropertyId = { in: props.map(p => p.id) }
    }
    // 只覆蓋尚未設定（=0）的合約，避免蓋掉已手動填過的
    if (req.body.onlyEmpty === true || req.body.onlyEmpty === 'true') where.prepaidUtility = 0
    const r = await prisma.lease.updateMany({ where, data: { prepaidUtility: amount } })
    res.json({ count: r.count, amount })
  } catch (e) {
    console.error('批次設定預收電費失敗:', e.message)
    res.status(500).json({ error: e.message })
  }
})

router.get('/admin/api/managed/lease/:leaseId/billing', async (req, res) => {
  const auth = await resolveRole(req.query.key)
  if (!auth) return res.status(401).json({ error: 'unauthorized' })
  try {
    const lease = await getOwnedLease(auth, req.params.leaseId)
    if (!lease) return res.status(lease === false ? 403 : 404).json({ error: lease === false ? 'forbidden' : 'not found' })
    const [records, utilityReadings, rentPayments] = await Promise.all([
      prisma.managementRecord.findMany({ where: { managedPropertyId: lease.managedPropertyId, OR: [{ leaseId: lease.id }, { leaseId: null }] }, orderBy: { recordDate: 'asc' } }),
      prisma.utilityReading.findMany({ where: { leaseId: lease.id }, orderBy: { endDate: 'desc' } }),
      prisma.rentPayment.findMany({ where: { leaseId: lease.id }, orderBy: { periodStart: 'asc' } }),
    ])
    const rentSchedule = buildRentSchedule(lease, rentPayments)
    // 一併回傳收支記錄，前端就不必再打較重的 /managed/:id（大幅加快對帳開啟）
    res.json({ lease, rentSchedule, utilityReadings, records })
  } catch (e) {
    console.error('租約帳務載入失敗:', e.message)
    res.status(500).json({ error: e.message })
  }
})

// ── 合約結算：預覽（押金、預收電費、建議扣除項目） ──────────────
router.get('/admin/api/managed/lease/:leaseId/settle-preview', async (req, res) => {
  const auth = await resolveRole(req.query.key)
  if (!auth) return res.status(401).json({ error: 'unauthorized' })
  try {
    const lease = await getOwnedLease(auth, req.params.leaseId)
    if (!lease) return res.status(lease === false ? 403 : 404).json({ error: lease === false ? 'forbidden' : 'not found' })
    const [utilityReadings, rentPayments] = await Promise.all([
      prisma.utilityReading.findMany({ where: { leaseId: lease.id } }),
      prisma.rentPayment.findMany({ where: { leaseId: lease.id } }),
    ])
    // 結算基準日：以送出的日期或今天為準
    const settleDate = req.query.date ? startOfDay(req.query.date) : startOfDay(new Date())
    // 未收電費：所有抄表未繳部分
    const unpaidUtility = utilityReadings.reduce((s, r) => s + Math.max(0, (r.amount || 0) - (r.paidAmount || 0)), 0)
    // 未收租金：已開始（期別起日 <= 結算日）的期別，應繳−已繳
    const rentSchedule = buildRentSchedule(lease, rentPayments)
    const unpaidRent = rentSchedule
      .filter(r => r.periodStart && startOfDay(r.periodStart) <= settleDate)
      .reduce((s, r) => s + Math.max(0, r.unpaid || 0), 0)
    const suggestedDeductions = []
    if (unpaidUtility > 0) suggestedDeductions.push({ name: '未收電費', amount: unpaidUtility })
    if (unpaidRent > 0) suggestedDeductions.push({ name: '未收租金', amount: unpaidRent })
    // 最新一期抄表（結算最終抄表的起點；續約新約電表初值）
    const latestReading = utilityReadings
      .filter(r => r.endDate)
      .sort((a, b) => new Date(b.endDate) - new Date(a.endDate))[0]
    const lastMeterDegree = latestReading ? (latestReading.endDegree || 0)
      : (lease.meterNext || lease.meterCurrent || lease.meterInitial || 0)
    // 上期抄表日期（作為本期起算日）：最近抄表迄日 → 合約抄表日 → 合約起日
    const lastMeterDate = latestReading ? latestReading.endDate
      : (lease.meterReadDate || lease.leaseStart || null)
    // 按日退租金用：折後月租、已繳租金到期日（已繳期別中最遠的迄日）
    const monthlyRent = effectiveRent(lease)
    const paidThroughDate = rentPayments
      .filter(p => (p.paidAmount || 0) > 0 && p.periodEnd)
      .reduce((max, p) => (!max || new Date(p.periodEnd) > new Date(max)) ? p.periodEnd : max, null)
    res.json({
      deposit: lease.deposit || 0,
      prepaidUtility: lease.prepaidUtility || 0,
      unpaidUtility,
      unpaidRent,
      monthlyRent,
      paidThroughDate,
      suggestedDeductions,
      // 合約日期（結束日預設用原合約迄日；續約起訖預設）
      leaseStart: lease.leaseStart,
      leaseEnd: lease.leaseEnd,
      // 電費抄表計算用
      lastMeterDegree,
      lastMeterDate,
      meterRate: lease.meterRate || 0,
      meterMode: lease.utilMode || 'FIXED',
      // 若已結算，回傳既有結算資料供編輯
      settled: !!lease.settledAt,
      settledAt: lease.settledAt,
      earlyTerminated: !!lease.earlyTerminated,
      endedAt: lease.endedAt,
      settleDeposit: lease.settleDeposit,
      settlePrepaid: lease.settlePrepaid,
      settleDeductions: lease.settleDeductions ? safeParse(lease.settleDeductions) : null,
      settleRefund: lease.settleRefund,
      settleNote: lease.settleNote,
    })
  } catch (e) {
    console.error('結算預覽失敗:', e.message)
    res.status(500).json({ error: e.message })
  }
})

// ── 合約結算：儲存（結清並結束合約） ──────────────────────────
router.post('/admin/api/managed/lease/:leaseId/settle', express.json(), async (req, res) => {
  const auth = await resolveRole(req.query.key)
  if (!auth) return res.status(401).json({ error: 'unauthorized' })
  try {
    const lease = await getOwnedLease(auth, req.params.leaseId)
    if (!lease) return res.status(lease === false ? 403 : 404).json({ error: lease === false ? 'forbidden' : 'not found' })
    const b = req.body
    const deposit = parseInt(b.deposit) || 0
    const prepaid = parseInt(b.prepaid) || 0
    const deductions = Array.isArray(b.deductions)
      ? b.deductions
          .map(d => ({ name: String(d.name || '').trim(), amount: parseInt(d.amount) || 0 }))
          .filter(d => d.name || d.amount)
      : []
    const deductTotal = deductions.reduce((s, d) => s + (d.amount || 0), 0)
    // 退還房客金額 ＝ 押金 ＋ 預收費用 − 應扣費用（可為負，負值＝房客應補繳）
    const refund = deposit + prepaid - deductTotal
    const settledAt = b.settledAt ? new Date(b.settledAt) : new Date()
    const lease2 = await prisma.lease.update({
      where: { id: lease.id },
      data: {
        status: 'ENDED',
        settledAt,
        endedAt: b.endedAt ? new Date(b.endedAt) : settledAt,
        earlyTerminated: b.earlyTerminated === true || b.earlyTerminated === 'true',
        settleDeposit: deposit,
        settlePrepaid: prepaid,
        settleDeductions: JSON.stringify(deductions),
        settleRefund: refund,
        settleNote: b.note || null,
      },
    })
    // 若在結算頁直接抄表 → 記錄一筆電費明細（已從押金扣抵，標記為已繳避免後續列為未收）
    try {
      const mr = b.meterReading
      if (mr && mr.endDegree != null && String(mr.endDegree) !== '') {
        const startDegree = parseInt(mr.startDegree) || 0
        const endDegree = parseInt(mr.endDegree) || 0
        const usedDegree = Math.max(0, endDegree - startDegree)
        const rate = parseFloat(mr.rate) || lease.meterRate || 0
        const amount = Math.round(usedDegree * rate)
        await prisma.utilityReading.create({
          data: {
            leaseId: lease.id,
            startDate: mr.startDate ? new Date(mr.startDate) : null,
            startDegree,
            endDate: mr.readDate ? new Date(mr.readDate) : settledAt,
            endDegree,
            usedDegree,
            rate,
            amount,
            paidAmount: amount,
            paidDate: settledAt,
            note: '結算抄表（押金扣抵）',
          },
        })
      }
    } catch (e) { console.error('結算抄表記錄失敗:', e.message) }
    // 合約結束→門鎖自動解除綁定（清除該房間 userId）
    try { await require('../../smartlock').syncLockRoomsFromLeases(lease.managedProperty.landlordId) } catch (e) { console.error('門鎖同步失敗:', e.message) }
    res.json({ ...lease2, refund, deductTotal })
  } catch (e) {
    console.error('合約結算失敗:', e.message)
    res.status(500).json({ error: e.message })
  }
})

// ── 合約續約：結束舊約並開一份延續的新約（不計退款、電表度數延續） ──
router.post('/admin/api/managed/lease/:leaseId/renew', express.json(), async (req, res) => {
  const auth = await resolveRole(req.query.key)
  if (!auth) return res.status(401).json({ error: 'unauthorized' })
  try {
    const lease = await getOwnedLease(auth, req.params.leaseId)
    if (!lease) return res.status(lease === false ? 403 : 404).json({ error: lease === false ? 'forbidden' : 'not found' })
    const b = req.body
    const newStart = b.newStart ? new Date(b.newStart) : (lease.leaseEnd ? new Date(new Date(lease.leaseEnd).getTime() + 86400000) : new Date())
    const newEnd = b.newEnd ? new Date(b.newEnd) : null
    // 電表度數延續上期：以最新抄表迄止度數為新約初值
    const readings = await prisma.utilityReading.findMany({ where: { leaseId: lease.id }, orderBy: { endDate: 'desc' }, take: 1 })
    const carryDegree = readings.length ? (readings[0].endDegree || 0) : (lease.meterNext || lease.meterCurrent || lease.meterInitial || 0)

    // 1) 建立新約：沿用舊約各項費用設定，日期延續、電表度數延續、結算欄位清空
    const newLease = await prisma.lease.create({
      data: {
        managedPropertyId: lease.managedPropertyId,
        tenantName: lease.tenantName,
        tenantPhone: lease.tenantPhone,
        tenantIdNo: lease.tenantIdNo,
        roomLabel: lease.roomLabel,
        rent: lease.rent,
        discountType: lease.discountType,
        discountValue: lease.discountValue,
        deposit: lease.deposit,
        prepaidUtility: lease.prepaidUtility,
        payDay: lease.payDay,
        payMethod: lease.payMethod,
        paymentCycle: lease.paymentCycle,
        paymentDueMode: lease.paymentDueMode,
        leaseStart: newStart,
        leaseEnd: newEnd,
        contractFile: lease.contractFile,
        status: 'ACTIVE',
        note: lease.note,
        propertyId: lease.propertyId,
        lineTenantId: lease.lineTenantId,
        lineUserId: lease.lineUserId,
        rentPayDay: lease.rentPayDay,
        rentRemindOn: lease.rentRemindOn,
        utilPayDay: lease.utilPayDay,
        utilRemindOn: lease.utilRemindOn,
        utilAmount: lease.utilAmount,
        utilMode: lease.utilMode,
        meterRate: lease.meterRate,
        // 電表度數延續：新約初值＝上期迄止度數
        meterInitial: carryDegree,
        meterCurrent: carryDegree,
        meterNext: carryDegree,
        parkingSpotId: lease.parkingSpotId,
        parkingSpace: lease.parkingSpace,
        parkingFee: lease.parkingFee,
        vehiclePlate: lease.vehiclePlate,
      },
    })

    // 2) 結束舊約（續約，不計退款）；結束日以原合約迄日為主
    await prisma.lease.update({
      where: { id: lease.id },
      data: {
        status: 'ENDED',
        settledAt: new Date(),
        endedAt: lease.leaseEnd ? new Date(lease.leaseEnd) : newStart,
        earlyTerminated: false,
        settleNote: (b.note ? (b.note + ' ') : '') + '續約（轉入新約 ' + newLease.id + '）',
      },
    })

    // 3) 門鎖：把綁定舊約的房間改指向新約 → 房客延續門鎖權限
    try {
      const sl = require('../../smartlock')
      await sl.repointLockLease(lease.managedProperty.landlordId, lease.id, newLease.id)
      await sl.syncLockRoomsFromLeases(lease.managedProperty.landlordId)
    } catch (e) { console.error('門鎖續約轉移失敗:', e.message) }

    res.json({ ok: true, oldLeaseId: lease.id, newLease })
  } catch (e) {
    console.error('合約續約失敗:', e.message)
    res.status(500).json({ error: e.message })
  }
})

router.post('/admin/api/managed/lease/:leaseId/payment', express.json(), async (req, res) => {
  const auth = await resolveRole(req.query.key)
  if (!auth) return res.status(401).json({ error: 'unauthorized' })
  try {
    const lease = await getOwnedLease(auth, req.params.leaseId)
    if (!lease) return res.status(lease === false ? 403 : 404).json({ error: lease === false ? 'forbidden' : 'not found' })
    const b = req.body
    const kind = b.kind === 'UTILITY' ? 'UTILITY' : 'RENT'
    const paidAmount = parseInt(b.paidAmount) || 0
    const paidDate = b.paidDate ? new Date(b.paidDate) : null
    const isPaid = paidAmount > 0 && !!paidDate
    // 水電：此列僅用於登記收款，仍需已繳金額與繳款日期
    if (kind === 'UTILITY' && !isPaid) return res.status(400).json({ error: '請輸入已繳金額與繳費日期' })

    if (kind === 'UTILITY') {
      const reading = await prisma.utilityReading.findFirst({ where: { id: b.utilityReadingId, leaseId: lease.id } })
      if (!reading) return res.status(404).json({ error: '找不到水電明細' })
      const updated = await prisma.utilityReading.update({
        where: { id: reading.id },
        data: {
          paidAmount,
          paidDate,
          payMethod: b.payMethod || null,
          receiptUrl: b.receiptUrl || null,
          note: b.note !== undefined ? (b.note || null) : reading.note,
        },
      })
      return res.json(updated)
    }

    const periodStart = b.periodStart ? startOfDay(b.periodStart) : null
    const periodEnd = b.periodEnd ? startOfDay(b.periodEnd) : null
    const dueDate = b.dueDate ? startOfDay(b.dueDate) : null
    const amount = parseInt(b.amount) || paidAmount
    if (!periodStart || !periodEnd || !dueDate) return res.status(400).json({ error: '缺少租金期別資料' })

    let existing = b.rentPaymentId ? await prisma.rentPayment.findFirst({ where: { id: b.rentPaymentId, leaseId: lease.id } }) : null
    if (!existing) {
      existing = await prisma.rentPayment.findFirst({
        where: { leaseId: lease.id, periodStart, dueDate },
      })
    }

    let recordId = existing?.recordId || null
    // 只有實際收款才建立／更新收入記錄；未收款時僅儲存期別/金額/應繳日的修改
    if (isPaid) {
      const recordData = {
        managedPropertyId: lease.managedPropertyId,
        leaseId: lease.id,
        type: 'INCOME',
        category: 'RENT',
        amount: paidAmount,
        recordDate: paidDate,
        description: `租金 ${ymd(periodStart)}~${ymd(periodEnd)} ${b.payMethod ? `(${b.payMethod})` : ''}`.trim(),
      }
      if (recordId) {
        await prisma.managementRecord.update({ where: { id: recordId }, data: recordData })
      } else {
        const record = await prisma.managementRecord.create({ data: recordData })
        recordId = record.id
      }
    }

    const data = {
      recordId,
      periodStart,
      periodEnd,
      dueDate,
      amount,
      paidAmount,
      paidDate,
      payMethod: b.payMethod || null,
      receiptUrl: b.receiptUrl || null,
      note: b.note || null,
    }
    const payment = existing
      ? await prisma.rentPayment.update({ where: { id: existing.id }, data })
      : await prisma.rentPayment.create({ data: { leaseId: lease.id, ...data } })
    res.json(payment)
  } catch (e) {
    console.error('更新繳費狀態失敗:', e.message)
    res.status(500).json({ error: e.message })
  }
})

router.post('/admin/api/managed/lease/:leaseId/utility-reading', express.json(), async (req, res) => {
  const auth = await resolveRole(req.query.key)
  if (!auth) return res.status(401).json({ error: 'unauthorized' })
  try {
    const lease = await getOwnedLease(auth, req.params.leaseId)
    if (!lease) return res.status(lease === false ? 403 : 404).json({ error: lease === false ? 'forbidden' : 'not found' })
    const b = req.body
    const startDegree = parseInt(b.startDegree) || 0
    const endDegree = parseInt(b.endDegree) || 0
    const usedDegree = Math.max(0, endDegree - startDegree)
    const rate = parseFloat(b.rate) || lease.meterRate || 0
    const amount = Math.round(usedDegree * rate)
    const reading = await prisma.utilityReading.create({
      data: {
        leaseId: lease.id,
        startDate: b.startDate ? new Date(b.startDate) : null,
        startDegree,
        endDate: b.endDate ? new Date(b.endDate) : new Date(),
        endDegree,
        usedDegree,
        rate,
        amount,
        dueDate: b.dueDate ? new Date(b.dueDate) : null,
        note: b.note || null,
      },
    })
    if (amount > 0) {
      await prisma.managementRecord.create({
        data: {
          managedPropertyId: lease.managedPropertyId,
          leaseId: lease.id,
          type: 'INCOME',
          category: 'UTILITY',
          amount,
          recordDate: reading.dueDate || reading.endDate,
          description: `電費 ${startDegree}→${endDegree} 度，${usedDegree} 度 x ${rate} 元`,
        },
      })
    }
    res.json(reading)
  } catch (e) {
    console.error('新增抄表失敗:', e.message)
    res.status(500).json({ error: e.message })
  }
})

router.put('/admin/api/managed/lease/:leaseId/utility-reading/:readingId', express.json(), async (req, res) => {
  const auth = await resolveRole(req.query.key)
  if (!auth) return res.status(401).json({ error: 'unauthorized' })
  try {
    const lease = await getOwnedLease(auth, req.params.leaseId)
    if (!lease) return res.status(lease === false ? 403 : 404).json({ error: lease === false ? 'forbidden' : 'not found' })
    const reading = await prisma.utilityReading.findFirst({ where: { id: req.params.readingId, leaseId: lease.id } })
    if (!reading) return res.status(404).json({ error: '找不到水電明細' })
    const b = req.body
    const startDegree = parseInt(b.startDegree) || 0
    const endDegree = parseInt(b.endDegree) || 0
    const usedDegree = Math.max(0, endDegree - startDegree)
    const rate = parseFloat(b.rate) || 0
    const amount = Math.round(usedDegree * rate)
    const updated = await prisma.utilityReading.update({
      where: { id: reading.id },
      data: {
        startDate: b.startDate ? new Date(b.startDate) : reading.startDate,
        startDegree,
        endDate: b.endDate ? new Date(b.endDate) : reading.endDate,
        endDegree,
        usedDegree,
        rate,
        amount,
        dueDate: b.dueDate ? new Date(b.dueDate) : reading.dueDate,
        note: b.note !== undefined ? (b.note || null) : reading.note,
      },
    })
    try {
      const rec = await prisma.managementRecord.findFirst({
        where: { leaseId: lease.id, category: 'UTILITY', amount: reading.amount },
        orderBy: { recordDate: 'desc' }
      })
      if (rec) {
        await prisma.managementRecord.update({
          where: { id: rec.id },
          data: { amount, recordDate: updated.dueDate || updated.endDate, description: `電費 ${startDegree}→${endDegree} 度，${usedDegree} 度 x ${rate} 元` }
        })
      }
    } catch(_) {}
    res.json(updated)
  } catch (e) {
    console.error('更新抄表失敗:', e.message)
    res.status(500).json({ error: e.message })
  }
})

router.delete('/admin/api/managed/lease/:leaseId/rent-payment/:paymentId', async (req, res) => {
  const auth = await resolveRole(req.query.key)
  if (!auth) return res.status(401).json({ error: 'unauthorized' })
  try {
    const lease = await getOwnedLease(auth, req.params.leaseId)
    if (!lease) return res.status(lease === false ? 403 : 404).json({ error: lease === false ? 'forbidden' : 'not found' })
    const payment = await prisma.rentPayment.findFirst({ where: { id: req.params.paymentId, leaseId: lease.id } })
    if (!payment) return res.status(404).json({ error: '找不到租金記錄' })
    if (payment.recordId) {
      await prisma.managementRecord.deleteMany({ where: { id: payment.recordId } })
    }
    await prisma.rentPayment.delete({ where: { id: payment.id } })
    res.json({ ok: true })
  } catch (e) {
    console.error('刪除租金記錄失敗:', e.message)
    res.status(500).json({ error: e.message })
  }
})

router.delete('/admin/api/managed/lease/:leaseId/utility-reading/:readingId', async (req, res) => {
  const auth = await resolveRole(req.query.key)
  if (!auth) return res.status(401).json({ error: 'unauthorized' })
  try {
    const lease = await getOwnedLease(auth, req.params.leaseId)
    if (!lease) return res.status(lease === false ? 403 : 404).json({ error: lease === false ? 'forbidden' : 'not found' })
    const reading = await prisma.utilityReading.findFirst({ where: { id: req.params.readingId, leaseId: lease.id } })
    if (!reading) return res.status(404).json({ error: '找不到水電記錄' })
    try {
      const rec = await prisma.managementRecord.findFirst({
        where: { leaseId: lease.id, category: 'UTILITY', amount: reading.amount },
        orderBy: { recordDate: 'desc' }
      })
      if (rec) await prisma.managementRecord.delete({ where: { id: rec.id } })
    } catch(_) {}
    await prisma.utilityReading.delete({ where: { id: reading.id } })
    res.json({ ok: true })
  } catch (e) {
    console.error('刪除抄表記錄失敗:', e.message)
    res.status(500).json({ error: e.message })
  }
})

router.post('/admin/api/managed/lease/:leaseId/remind', express.json(), async (req, res) => {
  const auth = await resolveRole(req.query.key)
  if (!auth) return res.status(401).json({ error: 'unauthorized' })
  try {
    const lease = await getOwnedLease(auth, req.params.leaseId)
    if (!lease) return res.status(lease === false ? 403 : 404).json({ error: lease === false ? 'forbidden' : 'not found' })
    if (!lease.lineUserId) return res.status(400).json({ error: '此租約尚未綁定 LINE 租客（合約內 LINE userID 為空）' })
    const data = { ...lease, managedTitle: lease.managedProperty.title }
    // 收款帳戶：以「委託物業」設定的屋主匯款銀行＋帳號為主；若未填才退用房東共用匯款資訊
    try {
      data.rentPayInfo = await resolvePayInfo(lease.managedProperty)
    } catch (e) { console.error('讀取收款帳戶失敗:', e.message) }
    const kind = req.body.kind === 'UTILITY' ? 'UTILITY' : 'RENT'
    let message
    if (kind === 'UTILITY') {
      // 帶入該筆抄表明細（起算日/度數、結算日/度數、使用度數、金額、應繳日）
      if (req.body.readingId) {
        const reading = await prisma.utilityReading.findFirst({ where: { id: req.body.readingId, leaseId: lease.id } })
        if (reading) data.reading = reading
      }
      data.utilAmount = parseInt(req.body.amount) || (data.reading && data.reading.amount) || lease.utilAmount || 0
      // 繳費日以設定的應繳日期為準（具體日期，非每月固定號）
      data.dueDateStr = req.body.dueDate || null
      message = utilReminderFlex(data)
    } else {
      data.rent = parseInt(req.body.amount) || lease.rent || 0
      data.dueDateStr = req.body.dueDate || null  // 應繳日期以設定日期為準
      data.periodStartStr = req.body.periodStart || null
      data.periodEndStr = req.body.periodEnd || null
      // 若前端沒帶期間 → 以租金排程回算（對應應繳日，否則取最近未繳期）
      if (!data.periodStartStr || !data.periodEndStr) {
        try {
          const rps = await prisma.rentPayment.findMany({ where: { leaseId: lease.id } })
          const sched = buildRentSchedule(lease, rps)
          let row = null
          if (req.body.dueDate) {
            const dt = startOfDay(req.body.dueDate).getTime()
            row = sched.find(s => s.dueDate && startOfDay(s.dueDate).getTime() === dt)
          }
          if (!row) row = sched.find(s => (s.unpaid || 0) > 0) || sched[0]
          if (row) {
            data.periodStartStr = data.periodStartStr || ymd(row.periodStart)
            data.periodEndStr = data.periodEndStr || ymd(row.periodEnd)
          }
        } catch (e) { console.error('租金期間回算失敗:', e.message) }
      }
      message = rentReminderFlex(data)
    }
    // 預覽模式：只回傳卡片 Flex 內容供前端預覽，不實際推播
    if (req.body.preview) return res.json({ ok: true, preview: message })
    // 依序嘗試客服Bot→主Bot→系統Bot，任一成功即可（房客可能在客服 Bot 而非出租 Bot）
    const result = await pushToLeaseTenant(lease, message)
    res.json({ ok: true, via: result.via })
  } catch (e) {
    console.error('手動繳費提醒失敗:', e.message)
    res.status(500).json({ error: e.message })
  }
})

// ── 收款確認：登記收款後推播「已收款」明細給房客（目前支援租金）──
router.post('/admin/api/managed/lease/:leaseId/receipt', express.json(), async (req, res) => {
  const auth = await resolveRole(req.query.key)
  if (!auth) return res.status(401).json({ error: 'unauthorized' })
  try {
    const lease = await getOwnedLease(auth, req.params.leaseId)
    if (!lease) return res.status(lease === false ? 403 : 404).json({ error: lease === false ? 'forbidden' : 'not found' })
    if (!lease.lineUserId) return res.status(400).json({ error: '此租約尚未綁定 LINE 租客（合約內 LINE userID 為空）' })
    const b = req.body
    const data = { ...lease, managedTitle: lease.managedProperty.title }
    data.paidAmount = parseInt(b.paidAmount) || 0
    data.paidDateStr = b.paidDate || null
    data.payMethod = b.payMethod || lease.payMethod || null
    let message
    if (b.kind === 'UTILITY') {
      if (b.readingId) {
        const reading = await prisma.utilityReading.findFirst({ where: { id: b.readingId, leaseId: lease.id } })
        if (reading) data.reading = reading
      }
      message = utilReceiptFlex(data)
    } else {
      data.periodStartStr = b.periodStart || null
      data.periodEndStr = b.periodEnd || null
      message = rentReceiptFlex(data)
    }
    const result = await pushToLeaseTenant(lease, message)
    res.json({ ok: true, via: result.via })
  } catch (e) {
    console.error('收款確認推播失敗:', e.message)
    res.status(500).json({ error: e.message })
  }
})

// ── 結算明細：結算後推播結算明細（押金/預收/應扣/退款）給房客 ──
router.post('/admin/api/managed/lease/:leaseId/settle-notify', express.json(), async (req, res) => {
  const auth = await resolveRole(req.query.key)
  if (!auth) return res.status(401).json({ error: 'unauthorized' })
  try {
    const lease = await getOwnedLease(auth, req.params.leaseId)
    if (!lease) return res.status(lease === false ? 403 : 404).json({ error: lease === false ? 'forbidden' : 'not found' })
    if (!lease.settledAt) return res.status(400).json({ error: '此合約尚未結算，無法傳送結算明細' })
    const preview = req.body && req.body.preview
    if (!preview && !lease.lineUserId) return res.status(400).json({ error: '此租約尚未綁定 LINE 租客（合約內 LINE userID 為空）' })
    const data = {
      ...lease,
      managedTitle: lease.managedProperty.title,
      settleDeductions: lease.settleDeductions ? safeParse(lease.settleDeductions) : [],
    }
    // 帶入結算抄表的電費明細供卡片顯示計算方式：取最新一筆抄表，
    // 且其迄日接近結算日（結算當下建立的抄表），避免帶到很舊的月抄表。
    try {
      const latestReading = await prisma.utilityReading.findFirst({
        where: { leaseId: lease.id },
        orderBy: { endDate: 'desc' },
      })
      if (latestReading && latestReading.endDate && lease.settledAt) {
        const gapDays = (startOfDay(lease.settledAt) - startOfDay(latestReading.endDate)) / 86400000
        if (gapDays <= 7) data.reading = latestReading
      }
    } catch (e) { console.error('讀取結算電費明細失敗:', e.message) }
    const message = settleReceiptFlex(data)
    // 預覽模式：只回傳卡片內容，不實際推播
    if (preview) return res.json({ ok: true, preview: message })
    const result = await pushToLeaseTenant(lease, message)
    res.json({ ok: true, via: result.via })
  } catch (e) {
    console.error('結算明細推播失敗:', e.message)
    res.status(500).json({ error: e.message })
  }
})

// ── Ragic 同步 ────────────────────────────────────────────────────
// GET /admin/api/broker-key — 總管理員專用：取得仲介房東金鑰（用於介面切換）
const BROKER_LANDLORD_ID = process.env.BROKER_LANDLORD_ID || 'cmqbys4qr0004keruq1niq5xz'
router.get('/admin/api/broker-key', async (req, res) => {
  const auth = await resolveRole(req.query.key)
  if (!auth || auth.role !== 'super') return res.status(403).json({ error: 'forbidden' })
  const brokerKey = process.env.BROKER_ADMIN_KEY
  if (!brokerKey) return res.status(404).json({ error: '仲介金鑰未設定，請設定 BROKER_ADMIN_KEY 環境變數' })
  const landlord = await prisma.landlord.findUnique({
    where: { id: BROKER_LANDLORD_ID },
    select: { name: true }
  })
  res.json({ key: brokerKey, name: landlord?.name || '仲介房東' })
})

// POST /admin/api/ragic/sync?key=...
// 需在後台設定 RAGIC_API_KEY 環境變數，以及 RAGIC_FORM_URL（如 https://ap11.ragic.com/urbanite/表單名稱/1）
const RAGIC_PAYMENT_CYCLE = { '月繳':'MONTHLY','雙月繳':'BIMONTHLY','季繳':'QUARTERLY','半年繳':'SEMIANNUAL','年繳':'YEARLY' }
const RAGIC_BUILDING_TITLES = {
  '紅寶石|11':'紅寶石 11號','紅寶石|21':'紅寶石 21號','紅寶石|28':'紅寶石 28號',
  '致富讚|22':'致富讚 22號','青雲巷|25-21':'青雲巷 25-21號'
}
// 標題比對正規化：忽略空白（後台標題「紅寶石11號」「紅寶石 28號」空白不一致）
function normTitle(s) { return String(s || '').replace(/\s+/g, '') }
const RAGIC_LINE_USER_ID_FIELDS = [
  'LINE User ID', 'Line User ID', 'lineUserId', 'line userID', 'LINE_USER_ID',
  'LINE UID', 'LINE ID', 'LINE用戶ID', 'LINE 用戶 ID', 'LINE使用者ID', 'LINE 使用者 ID',
  'LINE租客ID', 'LINE 租客 ID', '租客LINE ID', '租客 LINE ID', '租客LINE User ID',
]

function normRagicKey(s) {
  return String(s || '').toLowerCase().replace(/[\s_:\-／/()（）\[\]【】]+/g, '')
}

function pickRagicValue(row, names) {
  for (const name of names) {
    const v = row[name]
    if (v !== undefined && v !== null && String(v).trim() !== '') return String(v).trim()
  }
  const wanted = new Set(names.map(normRagicKey))
  for (const [k, v] of Object.entries(row)) {
    if (v === undefined || v === null || String(v).trim() === '') continue
    if (wanted.has(normRagicKey(k))) return String(v).trim()
  }
  for (const [k, v] of Object.entries(row)) {
    if (v === undefined || v === null || String(v).trim() === '') continue
    const n = normRagicKey(k)
    if (n.includes('line') && (n.includes('userid') || n.includes('uid') || n.includes('用戶id') || n.includes('使用者id'))) {
      return String(v).trim()
    }
  }
  return null
}

async function findLeaseLineTenant(lineUserId, landlordId, cache) {
  if (!lineUserId) return null
  const cacheKey = `${landlordId || 'main'}:${lineUserId}`
  if (Object.prototype.hasOwnProperty.call(cache, cacheKey)) return cache[cacheKey]
  let tenant = landlordId ? await findLineTenant(lineUserId, landlordId) : null
  if (!tenant) {
    tenant = await prisma.tenant.findFirst({
      where: {
        lineUserId,
        OR: [
          landlordId ? { landlordId } : undefined,
          landlordId ? { source: landlordId } : undefined,
          { landlordId: null, source: 'main' },
        ].filter(Boolean),
      },
      orderBy: { createdAt: 'desc' },
    })
  }
  cache[cacheKey] = tenant || null
  return cache[cacheKey]
}

router.post('/admin/api/ragic/sync', async (req, res) => {
  const auth = await resolveRole(req.query.key)
  if (!(await hasRagicFeature(auth))) return res.status(403).json({ error: 'forbidden' })

  const apiKey = process.env.RAGIC_API_KEY
  const formUrl = process.env.RAGIC_FORM_URL
  if (!apiKey || !formUrl) return res.status(400).json({ error: 'RAGIC_API_KEY 或 RAGIC_FORM_URL 未設定' })

  // 串流回應（NDJSON）：邊處理邊回報進度
  res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8')
  res.setHeader('Cache-Control', 'no-cache')
  const send = (obj) => { try { res.write(JSON.stringify(obj) + '\n') } catch (_) {} }

  try {
    const reqUrl = `${formUrl}${formUrl.includes('?') ? '&' : '?'}api=&limit=1000`
    const resp = await fetch(reqUrl, { headers: { 'Content-Type': 'application/json', 'Authorization': 'Basic ' + apiKey } })
    const rawText = await resp.text()
    if (!resp.ok) {
      send({ type: 'done', ok: true, created: 0, updated: 0, total: 0, rawCount: 0, httpStatus: resp.status, rawText: rawText.slice(0, 600) })
      return res.end()
    }
    let data = null
    try { data = JSON.parse(rawText) } catch (_) {}
    const allObjs = data ? Object.values(data).filter(r => r && typeof r === 'object') : []
    const rows = allObjs.filter(r => r['承租狀態'] === '承租中')

    // 抓不到承租中資料時，回傳原始診斷（原始回應／欄位名／狀態值），方便定位問題
    if (rows.length === 0) {
      send({
        type: 'done', ok: true, created: 0, updated: 0, total: 0,
        rawCount: allObjs.length,
        topLevel: data && !Array.isArray(data) ? Object.keys(data).slice(0, 20) : (Array.isArray(data) ? '陣列(' + data.length + ')' : String(data)),
        rawText: allObjs.length === 0 ? rawText.slice(0, 600) : undefined,
        sampleFields: allObjs[0] ? Object.keys(allObjs[0]) : [],
        statusValues: [...new Set(allObjs.map(r => r['承租狀態']).filter(v => v !== undefined && v !== ''))].slice(0, 15),
        availableTitles: (await prisma.managedProperty.findMany({ select: { title: true } })).map(m => m.title),
      })
      return res.end()
    }

    // 清除舊版「合約同步」建立的摘要財務記錄（避免與租金/電費明細同步重複計算）
    try {
      await prisma.managementRecord.deleteMany({
        where: {
          OR: [
            { AND: [{ description: { startsWith: '[ragic:' } }, { description: { endsWith: ':rent]' } }] },
            { AND: [{ description: { startsWith: '[ragic:' } }, { description: { endsWith: ':util]' } }] },
          ],
        },
      })
    } catch (_) {}

    // 取得現有各棟 ID + 預載既有租約（避免每筆再查一次 lease）
    const mpList = await prisma.managedProperty.findMany({ select: { id: true, title: true, landlordId: true } })
    const mpByTitle = Object.fromEntries(mpList.map(m => [normTitle(m.title), m]))
    const leaseByRagic = {}
    ;(await prisma.lease.findMany({ select: { id: true, ragicId: true } }))
      .forEach(l => { if (l.ragicId) leaseByRagic[l.ragicId] = l })

    let created = 0, updated = 0
    let skipNoId = 0, skipNoBuilding = 0, skipNoProperty = 0
    let linkedLine = 0, rawLine = 0
    const unmatched = new Set()
    const lineTenantCache = {}
    const step = Math.max(1, Math.floor(rows.length / 100))
    send({ type: 'start', total: rows.length })
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i]
      if (i % step === 0 || i === rows.length - 1) send({ type: 'progress', current: i + 1, total: rows.length })
      const ragicId = row['合約編號']; if (!ragicId) { skipNoId++; continue }
      const buildingKey = `${row['社區名稱']}|${row['房屋號']}`
      const title = RAGIC_BUILDING_TITLES[buildingKey]
      if (!title) { skipNoBuilding++; unmatched.add(buildingKey); continue }
      const managedProperty = mpByTitle[normTitle(title)]
      if (!managedProperty) { skipNoProperty++; unmatched.add(buildingKey + ' → ' + title + '（後台無此委託物業）'); continue }
      const lineUserId = pickRagicValue(row, RAGIC_LINE_USER_ID_FIELDS)
      const lineTenant = lineUserId ? await findLeaseLineTenant(lineUserId, managedProperty.landlordId, lineTenantCache) : null
      if (lineUserId) rawLine++
      if (lineTenant) linkedLine++

      const data = {
        tenantName: row['承租人'] || '',
        roomLabel: row['套房編號'] || '',
        rent: parseInt(row['租金/月']) || 0,
        deposit: parseInt(row['押金/2月']) || 0,
        paymentCycle: RAGIC_PAYMENT_CYCLE[row['繳費方式']] || 'MONTHLY',
        lineUserId: lineUserId || null,
        lineTenantId: lineTenant ? lineTenant.id : null,
        meterRate: parseFloat(row['電費單價(/度)']) || 0,
        leaseStart: row['合約日期起日'] ? new Date(row['合約日期起日'].replace(/\//g,'-')) : null,
        leaseEnd: row['合約日期迄日'] ? new Date(row['合約日期迄日'].replace(/\//g,'-')) : null,
        contractFile: row['合約檔案'] || null,
        vehiclePlate: row['車牌'] || null,
        parkingSpotId: row['車位編號'] || null,
        parkingSpace: row['車格'] || null,
        parkingFee: parseInt(row['車位租金/月']) || 0,
        note: row['其他備註'] || null,
        managedPropertyId: managedProperty.id,
      }

      const existing = leaseByRagic[ragicId]
      if (existing) {
        await prisma.lease.update({ where: { id: existing.id }, data })
        updated++
      } else {
        const nl = await prisma.lease.create({ data: { ...data, ragicId, status: 'ACTIVE' } })
        leaseByRagic[ragicId] = nl
        created++
      }
      // 註：租金/電費的收支明細改由「租金同步」「電費同步」各自建立明細記錄，
      // 合約同步不再建立摘要財務記錄，避免與明細同步重複計算。
    }

    send({
      type: 'done', ok: true, created, updated, total: rows.length,
      skipNoId, skipNoBuilding, skipNoProperty, rawLine, linkedLine,
      unmatched: [...unmatched].slice(0, 30),
      availableTitles: mpList.map(m => m.title),
    })
    res.end()
  } catch (e) {
    console.error('Ragic 同步失敗:', e.message)
    send({ type: 'done', ok: false, error: e.message })
    res.end()
  }
})

// ── Ragic 電費明細同步 ─────────────────────────────────────────
// POST /admin/api/ragic/sync-utility?key=...
// 環境變數: RAGIC_UTILITY_FORM_URL（如 https://ap11.ragic.com/urbanite/電費明細/1）
router.post('/admin/api/ragic/sync-utility', async (req, res) => {
  const auth = await resolveRole(req.query.key)
  if (!(await hasRagicFeature(auth))) return res.status(403).json({ error: 'forbidden' })

  const apiKey = process.env.RAGIC_API_KEY
  const formUrl = process.env.RAGIC_UTILITY_FORM_URL
  if (!apiKey || !formUrl) return res.status(400).json({ error: 'RAGIC_API_KEY 或 RAGIC_UTILITY_FORM_URL 未設定' })

  res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8')
  res.setHeader('Cache-Control', 'no-cache')
  const send = (obj) => { try { res.write(JSON.stringify(obj) + '\n') } catch (_) {} }

  try {
    const resp = await fetch(`${formUrl}${formUrl.includes('?') ? '&' : '?'}api=&limit=2000`, {
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Basic ' + apiKey }
    })
    const rawText = await resp.text()
    if (!resp.ok) { send({ type: 'done', ok: false, error: `Ragic API 錯誤 ${resp.status}`, rawText: rawText.slice(0, 400) }); return res.end() }
    const data = JSON.parse(rawText)

    // Ragic 回傳格式: { "1": {欄位}, "2": {欄位}, ... }
    const rows = Object.values(data).filter(r => typeof r === 'object' && r['合約編號'])

    // 依合約編號分組並排序
    const byLease = {}
    for (const row of rows) {
      const ragicId = row['合約編號']
      if (!byLease[ragicId]) byLease[ragicId] = []
      byLease[ragicId].push(row)
    }
    for (const ragicId of Object.keys(byLease)) {
      byLease[ragicId].sort((a, b) => {
        const da = (a['電費起算日期'] || '').replace(/\//g, '-')
        const db = (b['電費起算日期'] || '').replace(/\//g, '-')
        return da.localeCompare(db)
      })
    }

    let readingCreated = 0, readingSkipped = 0, meterUpdated = 0

    // 預載對照表：租約（by ragicId）＋既有抄表（避免每筆再查）
    const leaseByRagic = {}
    ;(await prisma.lease.findMany({ select: { id: true, ragicId: true } }))
      .forEach(l => { if (l.ragicId) leaseByRagic[l.ragicId] = l })
    const readingKey = (leaseId, startDegree, startDate) => leaseId + '|' + startDegree + '|' + new Date(startDate).toISOString()
    const readingSet = new Set()
    ;(await prisma.utilityReading.findMany({ select: { leaseId: true, startDegree: true, startDate: true } }))
      .forEach(r => { readingSet.add(readingKey(r.leaseId, r.startDegree, r.startDate)) })

    const leaseGroups = Object.entries(byLease)
    const stepU = Math.max(1, Math.floor(leaseGroups.length / 100))
    send({ type: 'start', total: leaseGroups.length })
    let _gi = 0
    for (const [ragicId, leaseRows] of leaseGroups) {
      _gi++
      if (_gi % stepU === 0 || _gi === leaseGroups.length) send({ type: 'progress', current: _gi, total: leaseGroups.length })
      const leaseRes = leaseByRagic[ragicId]
      if (!leaseRes) continue
      const leaseId = leaseRes.id

      // 最初度數
      const firstRow = leaseRows[0]
      const meterInitial = parseInt(firstRow['上期度數']) || 0
      if (meterInitial > 0) {
        await prisma.lease.update({ where: { id: leaseId }, data: { meterInitial } })
        meterUpdated++
      }

      // 逐期匯入（有結算日期+本期度數就匯入）
      for (const row of leaseRows) {
        const startDate = (row['電費起算日期'] || '').replace(/\//g, '-') || null
        const startDegree = parseInt(row['上期度數']) || 0
        const endDate = (row['電費結算日期'] || '').replace(/\//g, '-') || null
        const endDegree = parseInt(row['本期度數']) || 0
        const usedDegree = parseInt(row['使用度數']) || 0
        const rate = parseFloat(row['電費單價(度)']) || 6
        const amount = parseInt(row['電費金額']) || 0
        const dueDate = (row['應繳納日期'] || '').replace(/\//g, '-') || null
        const paidAmount = parseInt(row['已繳款金額']) || 0
        const paidDate = (row['已繳款日期'] || '').replace(/\//g, '-') || null

        if (!endDate || !startDate || !endDegree) continue

        // 防重複（用預載的集合，不再逐筆查 DB）
        const rk = readingKey(leaseId, startDegree, startDate)
        if (readingSet.has(rk)) { readingSkipped++; continue }
        readingSet.add(rk)

        await prisma.utilityReading.create({
          data: {
            leaseId,
            startDate: new Date(startDate),
            startDegree,
            endDate: new Date(endDate),
            endDegree,
            usedDegree,
            rate,
            amount,
            dueDate: dueDate ? new Date(dueDate) : null,
            paidAmount,
            paidDate: paidDate ? new Date(paidDate) : null,
          }
        })
        readingCreated++
      }
    }

    send({ type: 'done', ok: true, readingCreated, readingSkipped, meterUpdated })
    res.end()
  } catch (e) {
    console.error('Ragic 電費同步失敗:', e.message)
    send({ type: 'done', ok: false, error: e.message })
    res.end()
  }
})

// POST /admin/api/ragic/sync-rent
// 環境變數: RAGIC_RENT_FORM_URL（如 https://ap11.ragic.com/urbanite/租金繳納明細/1）
router.post('/admin/api/ragic/sync-rent', async (req, res) => {
  const auth = await resolveRole(req.query.key)
  if (!(await hasRagicFeature(auth))) return res.status(403).json({ error: 'forbidden' })

  const apiKey = process.env.RAGIC_API_KEY
  const formUrl = process.env.RAGIC_RENT_FORM_URL
  if (!apiKey || !formUrl) return res.status(400).json({ error: 'RAGIC_API_KEY 或 RAGIC_RENT_FORM_URL 未設定' })

  // 民國年 "114/4/1" → Date
  function rocToDate(s) {
    if (!s || !s.trim()) return null
    const p = s.trim().split('/')
    if (p.length < 3) return null
    const y = parseInt(p[0]) + 1911, m = parseInt(p[1]), d = parseInt(p[2])
    if (isNaN(y) || isNaN(m) || isNaN(d)) return null
    return new Date(`${y}-${String(m).padStart(2,'0')}-${String(d).padStart(2,'0')}`)
  }

  // "114/4/1~114/9/30" 或 "114/4/1-114/9/30" → { start, end }
  function parsePeriod(desc) {
    const m = (desc || '').replace(/\n/g, ' ').match(/(\d{2,3})\/(\d{1,2})\/(\d{1,2})\s*[~\-]\s*(\d{2,3})\/(\d{1,2})\/(\d{1,2})/)
    if (!m) return null
    const start = rocToDate(`${m[1]}/${m[2]}/${m[3]}`)
    const end   = rocToDate(`${m[4]}/${m[5]}/${m[6]}`)
    return (start && end) ? { start, end } : null
  }

  res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8')
  res.setHeader('Cache-Control', 'no-cache')
  const send = (obj) => { try { res.write(JSON.stringify(obj) + '\n') } catch (_) {} }

  try {
    const resp = await fetch(`${formUrl}${formUrl.includes('?') ? '&' : '?'}api=&limit=2000`, {
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Basic ' + apiKey }
    })
    const rawText = await resp.text()
    if (!resp.ok) { send({ type: 'done', ok: false, error: `Ragic API 錯誤 ${resp.status}`, rawText: rawText.slice(0, 400) }); return res.end() }
    const data = JSON.parse(rawText)

    const rows = Object.values(data).filter(r => typeof r === 'object' && r['合約編號'])

    // 預載租約
    const allLeases = await prisma.lease.findMany({ select: { id: true, ragicId: true, managedPropertyId: true } })
    const leaseByRagic = {}; allLeases.forEach(l => { if (l.ragicId) leaseByRagic[l.ragicId] = l })

    // Ragic 為租金唯一來源：先清除這些租約中「非 Ragic 來源」的租金/車位收入與其繳款記錄
    // （手動在對帳頁儲存、或舊資料造成的重複，例如「租金 2026-…（匯款）」）
    const ragicLeaseIds = [...new Set(rows.map(r => (leaseByRagic[r['合約編號']] || {}).id).filter(Boolean))]
    let cleaned = 0
    if (ragicLeaseIds.length) {
      const manualRecs = await prisma.managementRecord.findMany({
        where: {
          leaseId: { in: ragicLeaseIds },
          type: 'INCOME',
          category: { in: ['RENT', 'PARKING'] },
          NOT: { description: { startsWith: '[ragic-rent:' } },
        },
        select: { id: true },
      })
      const manualIds = manualRecs.map(r => r.id)
      if (manualIds.length) {
        await prisma.rentPayment.deleteMany({ where: { recordId: { in: manualIds } } })
        const del = await prisma.managementRecord.deleteMany({ where: { id: { in: manualIds } } })
        cleaned = del.count || manualIds.length
      }
    }

    // 預載對照表（清理後）：把每筆繳款／收入記錄查詢降到迴圈前一次
    const leaseIds = allLeases.map(l => l.id)
    const payKey = (leaseId, periodStart, amount) => leaseId + '|' + new Date(periodStart).toISOString() + '|' + amount
    const paymentMap = {}
    ;(await prisma.rentPayment.findMany({ where: { leaseId: { in: leaseIds } } }))
      .forEach(p => { paymentMap[payKey(p.leaseId, p.periodStart, p.amount)] = p })
    const recordByDesc = {}
    ;(await prisma.managementRecord.findMany({ where: { description: { startsWith: '[ragic-rent:' } } }))
      .forEach(r => { recordByDesc[r.description] = r })

    let created = 0, updated = 0, skipped = 0
    const step = Math.max(1, Math.floor(rows.length / 100)) // 進度最多回報約 100 次，降低串流負擔

    send({ type: 'start', total: rows.length })
    for (let _i = 0; _i < rows.length; _i++) {
      const row = rows[_i]
      if (_i % step === 0 || _i === rows.length - 1) send({ type: 'progress', current: _i + 1, total: rows.length })
      const ragicId = row['合約編號']
      const lease = leaseByRagic[ragicId]
      if (!lease) { skipped++; continue }

      const desc      = row['說明'] || ''
      const isParking = /車位/.test(desc)
      const category  = isParking ? 'PARKING' : 'RENT'
      const period    = parsePeriod(desc)
      const dueDateRaw = (row['租金應繳日期'] || '').replace(/\//g, '-')
      if (!dueDateRaw) { skipped++; continue }
      const dueDate    = new Date(dueDateRaw)
      const periodStart = period ? period.start : dueDate
      const periodEnd   = period ? period.end   : dueDate
      const amount      = parseInt(row['應繳租金金額']) || 0
      const paidAmount  = parseInt(row['已繳金額']) || 0
      const paidDateRaw = (row['繳款日期'] || '').replace(/\//g, '-') || null
      const paidDate    = paidDateRaw ? new Date(paidDateRaw) : null
      const payMethod   = row['繳款方式'] || null
      const note        = [desc, row['備註']].filter(Boolean).join(' | ') || null
      const isPaid      = row['已收款'] === 'Yes'

      const existing = paymentMap[payKey(lease.id, periodStart, amount)]

      if (existing) {
        const descKey = `[ragic-rent:${ragicId}] ${desc}`
        if (isPaid && paidAmount > 0) {
          // 冪等校正：收入記錄以「已繳金額」實收為準（含折扣時實收<應繳），並標記已結清
          const rec = recordByDesc[descKey]
          if (rec) {
            if (rec.amount !== paidAmount) await prisma.managementRecord.update({ where: { id: rec.id }, data: { amount: paidAmount } })
          } else {
            await prisma.managementRecord.create({
              data: {
                managedPropertyId: lease.managedPropertyId,
                leaseId: lease.id,
                type: 'INCOME',
                category,
                amount: paidAmount,
                description: descKey,
                recordDate: paidDate || dueDate,
              }
            })
          }
          await prisma.rentPayment.update({
            where: { id: existing.id },
            data: { paidAmount, paidDate, payMethod, note, settled: true }
          })
          updated++
        } else {
          // 未收款：確保未標記已結清（收支不列入）
          if (existing.settled) await prisma.rentPayment.update({ where: { id: existing.id }, data: { settled: false } })
          skipped++
        }
        continue
      }

      // 新記錄：已付才建財務流水（收入以「已繳金額」實收為準）
      let recordId = null
      if (isPaid && paidAmount > 0) {
        const descKey = `[ragic-rent:${ragicId}] ${desc}`
        const rec = await prisma.managementRecord.create({
          data: {
            managedPropertyId: lease.managedPropertyId,
            leaseId: lease.id,
            type: 'INCOME',
            category,
            amount: paidAmount,
            description: descKey,
            recordDate: paidDate || dueDate,
          }
        })
        recordId = rec.id
        recordByDesc[descKey] = rec
      }

      const newPay = await prisma.rentPayment.create({
        data: {
          leaseId: lease.id,
          recordId,
          periodStart,
          periodEnd,
          dueDate,
          amount,
          paidAmount,
          paidDate,
          payMethod,
          note,
          settled: isPaid,
        }
      })
      paymentMap[payKey(lease.id, periodStart, amount)] = newPay
      created++
    }

    send({ type: 'done', ok: true, created, updated, skipped, cleaned })
    res.end()
  } catch (e) {
    console.error('Ragic 租金同步失敗:', e.message)
    send({ type: 'done', ok: false, error: e.message })
    res.end()
  }
})

module.exports = router
// 供自動繳費提醒排程（leaseReminder.js）重用租金排程計算
module.exports.buildRentSchedule = buildRentSchedule
