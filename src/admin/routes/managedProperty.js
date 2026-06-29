// src/admin/routes/managedProperty.js — 包租代管系統
const express = require('express')
const router = express.Router()
const prisma = require('../../db')
const { resolveRole } = require('../helpers')
const { getClientForLease, rentReminderFlex, utilReminderFlex } = require('../../leaseReminder')

// 權限過濾：super 看全部，房東只看自己的
function ownFilter(auth) {
  return auth.role === 'super' ? {} : { landlordId: auth.landlordId }
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
  const locked = (rentPayments || [])
    .filter(p => (p.paidAmount || 0) > 0)
    .sort((a, b) => new Date(a.periodStart) - new Date(b.periodStart))
  locked.forEach((p, i) => {
    rows.push({
      id: p.id,
      index: i + 1,
      label: `${ymd(p.periodStart)}~${ymd(p.periodEnd)}`,
      periodStart: p.periodStart,
      periodEnd: p.periodEnd,
      amount: p.amount,
      dueDate: p.dueDate,
      paidAmount: p.paidAmount,
      paidDate: p.paidDate,
      payMethod: p.payMethod,
      receiptUrl: p.receiptUrl,
      note: p.note,
      locked: true,
      unpaid: Math.max(0, (p.amount || 0) - (p.paidAmount || 0)),
    })
  })

  const lastLockedEnd = locked.reduce((max, p) => {
    const t = new Date(p.periodEnd).getTime()
    return t > max ? t : max
  }, 0)
  let periodStart = lastLockedEnd ? new Date(lastLockedEnd + 86400000) : new Date(start)
  if (periodStart < start) periodStart = new Date(start)
  let idx = 1
  while (periodStart <= leaseEnd && idx <= 120) {
    const nextStart = addMonths(periodStart, months)
    const periodEnd = new Date(Math.min(addMonths(periodStart, months).getTime() - 86400000, leaseEnd.getTime()))
    const due = lease.paymentDueMode === 'CONTRACT_START' ? new Date(periodStart) : fixedDueDate(periodStart, payDay)
    const amount = effectiveRent(lease) * months
    rows.push({
      id: null,
      index: rows.length + 1,
      label: `${ymd(periodStart)}~${ymd(periodEnd)}`,
      periodStart,
      periodEnd,
      amount,
      dueDate: due,
      paidAmount: 0,
      paidDate: null,
      payMethod: null,
      receiptUrl: null,
      note: null,
      locked: false,
      unpaid: amount,
    })
    periodStart = nextStart
    idx++
  }
  return rows
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
    const props = await prisma.managedProperty.findMany({
      where: { ...ownFilter(auth), status: 'ACTIVE' },
      include: {
        incomes: true,
        payouts: true,
      },
    })

    let totalIncome = 0, totalExpense = 0, totalMgmtFee = 0, totalPayout = 0, pendingPayout = 0
    const byProperty = props.map(p => {
      const income = p.incomes.filter(r => r.type === 'INCOME').reduce((s, r) => s + r.amount, 0)
      const expense = p.incomes.filter(r => r.type === 'EXPENSE').reduce((s, r) => s + r.amount, 0)
      const mgmtFee = p.payouts.reduce((s, r) => s + r.mgmtFee, 0)
      const payout = p.payouts.reduce((s, r) => s + r.payoutAmount, 0)
      const pending = p.payouts.filter(r => r.status === 'PENDING').reduce((s, r) => s + r.payoutAmount, 0)

      // 平台利潤：代管=管理費；包租=轉租收入-承租成本-支出
      const profit = p.manageType === 'TRUST'
        ? mgmtFee
        : (income - (p.leaseCost * Math.max(p.payouts.length, 1)) - expense)

      totalIncome += income
      totalExpense += expense
      totalMgmtFee += mgmtFee
      totalPayout += payout
      pendingPayout += pending

      return {
        id: p.id, title: p.title, ownerName: p.ownerName, manageType: p.manageType,
        income, expense, mgmtFee, payout, pending, profit,
      }
    })

    res.json({
      summary: { totalIncome, totalExpense, totalMgmtFee, totalPayout, pendingPayout, count: props.length },
      byProperty,
    })
  } catch (e) {
    console.error('報表失敗:', e.message)
    res.status(500).json({ error: e.message })
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
      orderBy: { createdAt: 'desc' },
    })
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
    }

    let lease
    if (b.leaseId) {
      lease = await prisma.lease.update({ where: { id: b.leaseId }, data })
    } else {
      lease = await prisma.lease.create({ data: { ...data, managedPropertyId: req.params.id } })
    }
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
      include: { managedProperty: { select: { id: true, title: true, ownerName: true } } },
      orderBy: { leaseEnd: 'asc' },
    })

    const now = new Date()
    const result = leases.map(l => {
      let computedStatus = l.status
      let daysToEnd = null
      if (l.leaseEnd) {
        daysToEnd = Math.ceil((new Date(l.leaseEnd) - now) / 86400000)
        if (l.status === 'ACTIVE') {
          if (daysToEnd < 0) computedStatus = 'EXPIRED'
          else if (daysToEnd <= 30) computedStatus = 'EXPIRING'
        }
      }
      // 計算下期收租日
      let nextRentDate = null
      if (l.status === 'ACTIVE' && l.rentPayDay) {
        const d = new Date(now.getFullYear(), now.getMonth(), l.rentPayDay)
        if (d < now) d.setMonth(d.getMonth() + 1)
        nextRentDate = d
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
        lineBound: !!l.lineUserId,
        rentPayDay: l.rentPayDay,
        nextRentDate,
        managedTitle: l.managedProperty.title,
        managedId: l.managedProperty.id,
        ownerName: l.managedProperty.ownerName,
      }
    })

    res.json({
      active: result.filter(r => r.status === 'ACTIVE'),
      expiring: result.filter(r => r.status === 'EXPIRING'),
      expired: result.filter(r => r.status === 'EXPIRED'),
      ended: result.filter(r => r.status === 'ENDED'),
    })
  } catch (e) {
    console.error('代管清單失敗:', e.message)
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
    res.json({ lease, rentSchedule, utilityReadings })
  } catch (e) {
    console.error('租約帳務載入失敗:', e.message)
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
    if (!paidAmount || !paidDate) return res.status(400).json({ error: '請輸入已繳金額與繳費日期' })

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

router.post('/admin/api/managed/lease/:leaseId/remind', express.json(), async (req, res) => {
  const auth = await resolveRole(req.query.key)
  if (!auth) return res.status(401).json({ error: 'unauthorized' })
  try {
    const lease = await getOwnedLease(auth, req.params.leaseId)
    if (!lease) return res.status(lease === false ? 403 : 404).json({ error: lease === false ? 'forbidden' : 'not found' })
    if (!lease.lineUserId) return res.status(400).json({ error: '此租約尚未綁定 LINE 租客' })
    const client = await getClientForLease(lease)
    if (!client) return res.status(400).json({ error: 'LINE Bot 尚未設定' })
    const data = { ...lease, managedTitle: lease.managedProperty.title }
    const kind = req.body.kind === 'UTILITY' ? 'UTILITY' : 'RENT'
    if (kind === 'UTILITY') {
      data.utilAmount = parseInt(req.body.amount) || lease.utilAmount || 0
      data.utilPayDay = req.body.dueDate ? new Date(req.body.dueDate).getDate() : lease.utilPayDay
      await client.pushMessage(lease.lineUserId, utilReminderFlex(data))
    } else {
      data.rent = parseInt(req.body.amount) || lease.rent || 0
      data.rentPayDay = req.body.dueDate ? new Date(req.body.dueDate).getDate() : lease.rentPayDay
      await client.pushMessage(lease.lineUserId, rentReminderFlex(data))
    }
    res.json({ ok: true })
  } catch (e) {
    console.error('手動繳費提醒失敗:', e.message)
    res.status(500).json({ error: e.message })
  }
})

module.exports = router
