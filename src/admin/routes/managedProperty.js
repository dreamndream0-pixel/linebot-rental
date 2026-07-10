// src/admin/routes/managedProperty.js — 包租代管系統
const express = require('express')
const router = express.Router()
const prisma = require('../../db')
const { resolveRole } = require('../helpers')
const { getClientForLease, rentReminderFlex, utilReminderFlex } = require('../../leaseReminder')
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
        lineUserId: l.lineUserId,
        lineTenantId: l.lineTenantId,
        lineImported: !!l.lineUserId,
        lineLinked: !!l.lineTenantId,
        lineBound: !!l.lineUserId,
        rentPayDay: l.rentPayDay,
        nextRentDate,
        managedTitle: l.managedProperty ? l.managedProperty.title : '未連結物業',
        managedId: l.managedProperty ? l.managedProperty.id : '',
        ownerName: l.managedProperty ? l.managedProperty.ownerName : '（未填房東）',
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
    // 一併回傳收支記錄，前端就不必再打較重的 /managed/:id（大幅加快對帳開啟）
    res.json({ lease, rentSchedule, utilityReadings, records })
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
  '紅寶石|11':'紅寶石 11棟','紅寶石|21':'紅寶石 21棟','紅寶石|28':'紅寶石 28棟',
  '致富讚|22':'致富讚 22棟','青雲巷|25-21':'青雲巷 25-21棟'
}
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

    // 取得現有各棟 ID
    const mpList = await prisma.managedProperty.findMany({ select: { id: true, title: true, landlordId: true } })
    const mpByTitle = Object.fromEntries(mpList.map(m => [m.title, m]))

    let created = 0, updated = 0
    let skipNoId = 0, skipNoBuilding = 0, skipNoProperty = 0
    let linkedLine = 0, rawLine = 0
    const unmatched = new Set()
    const lineTenantCache = {}
    send({ type: 'start', total: rows.length })
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i]
      send({ type: 'progress', current: i + 1, total: rows.length })
      const ragicId = row['合約編號']; if (!ragicId) { skipNoId++; continue }
      const buildingKey = `${row['社區名稱']}|${row['房屋號']}`
      const title = RAGIC_BUILDING_TITLES[buildingKey]
      if (!title) { skipNoBuilding++; unmatched.add(buildingKey); continue }
      const managedProperty = mpByTitle[title]
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

      const existing = await prisma.lease.findFirst({ where: { ragicId } })
      if (existing) {
        await prisma.lease.update({ where: { id: existing.id }, data })
        updated++
      } else {
        await prisma.lease.create({ data: { ...data, ragicId, status: 'ACTIVE' } })
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

    const leaseGroups = Object.entries(byLease)
    send({ type: 'start', total: leaseGroups.length })
    let _gi = 0
    for (const [ragicId, leaseRows] of leaseGroups) {
      send({ type: 'progress', current: ++_gi, total: leaseGroups.length })
      const leaseRes = await prisma.lease.findFirst({ where: { ragicId } })
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

        // 防重複
        const ex = await prisma.utilityReading.findFirst({
          where: { leaseId, startDegree, startDate: new Date(startDate) }
        })
        if (ex) { readingSkipped++; continue }

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

    let created = 0, updated = 0, skipped = 0

    send({ type: 'start', total: rows.length })
    for (let _i = 0; _i < rows.length; _i++) {
      const row = rows[_i]
      send({ type: 'progress', current: _i + 1, total: rows.length })
      const ragicId = row['合約編號']
      const lease = await prisma.lease.findFirst({
        where: { ragicId },
        select: { id: true, managedPropertyId: true }
      })
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

      const existing = await prisma.rentPayment.findFirst({
        where: { leaseId: lease.id, periodStart, amount }
      })

      if (existing) {
        // 若已付款狀態有更新則同步
        if (isPaid && paidAmount > 0 && existing.paidAmount === 0) {
          // 建立對應財務記錄
          await prisma.managementRecord.create({
            data: {
              managedPropertyId: lease.managedPropertyId,
              leaseId: lease.id,
              type: 'INCOME',
              category,
              amount,
              description: `[ragic-rent:${ragicId}] ${desc}`,
              recordDate: paidDate || dueDate,
            }
          })
          await prisma.rentPayment.update({
            where: { id: existing.id },
            data: { paidAmount, paidDate, payMethod, note }
          })
          updated++
        } else {
          skipped++
        }
        continue
      }

      // 新記錄：已付才建財務流水
      let recordId = null
      if (isPaid && paidAmount > 0) {
        const rec = await prisma.managementRecord.create({
          data: {
            managedPropertyId: lease.managedPropertyId,
            leaseId: lease.id,
            type: 'INCOME',
            category,
            amount,
            description: `[ragic-rent:${ragicId}] ${desc}`,
            recordDate: paidDate || dueDate,
          }
        })
        recordId = rec.id
      }

      await prisma.rentPayment.create({
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
        }
      })
      created++
    }

    send({ type: 'done', ok: true, created, updated, skipped })
    res.end()
  } catch (e) {
    console.error('Ragic 租金同步失敗:', e.message)
    send({ type: 'done', ok: false, error: e.message })
    res.end()
  }
})

module.exports = router
