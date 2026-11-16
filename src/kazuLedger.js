// src/kazuLedger.js — KAZU（AI 主管）對帳專用 API，掛在 /api/kazu/ledger
// 只認獨立金鑰 KAZU_LEDGER_KEY（Authorization: Bearer）；與 ADMIN_KEY／後台角色判斷完全分離。
// 只能：查待繳、查提醒紀錄、登記「已繳金額＋繳款日期」。不能改應繳金額、刪除或推播房客。
const express = require('express')
const crypto = require('crypto')
const prisma = require('./db')
const { listRecentReminders } = require('./reminderLog')

const router = express.Router()

const KEY_MIN_LENGTH = 32
const RATE_LIMIT = 30
const RATE_WINDOW_MS = 60 * 1000
const MAX_PAID_AMOUNT = 100000000

// ── 工具 ────────────────────────────────────────────────────────
class HttpError extends Error {
  constructor(status, message, extra) {
    super(message)
    this.status = status
    this.extra = extra || {}
  }
}

// 台北時間 YYYY-MM-DD
function tpe(d) {
  if (!d) return null
  const t = new Date(d)
  if (isNaN(t.getTime())) return null
  return new Date(t.getTime() + 8 * 3600 * 1000).toISOString().slice(0, 10)
}

// 與後台 ymd() 相同（寫入收入帳說明文字用，維持與後台一致）
function adminYmd(d) {
  return d ? new Date(d).toISOString().slice(0, 10) : null
}

function ledger() {
  // 延後載入：沿用後台同一套期別計算，但不在啟動時拉入整個後台路由
  return require('./admin/routes/managedProperty').ledger
}

// ── 金鑰與限流 ──────────────────────────────────────────────────
function sha(s) { return crypto.createHash('sha256').update(String(s)).digest() }

const _hits = new Map()
function rateLimit(req, res, next) {
  const ip = req.ip || (req.socket && req.socket.remoteAddress) || 'unknown'
  const now = Date.now()
  let h = _hits.get(ip)
  if (!h || now - h.start >= RATE_WINDOW_MS) { h = { start: now, n: 0 }; _hits.set(ip, h) }
  h.n += 1
  if (_hits.size > 1000) {
    for (const [k, v] of _hits) if (now - v.start >= RATE_WINDOW_MS) _hits.delete(k)
  }
  if (h.n > RATE_LIMIT) return res.status(429).json({ error: 'too many requests' })
  next()
}

// 金鑰是否與總管理員／任何房東金鑰相同（相同則整組端點拒絕，避免權限混用）
let _collision = { key: null, bad: false }
async function keyCollides(key) {
  if (_collision.key === key) return _collision.bad
  let bad = !!process.env.ADMIN_KEY && key === process.env.ADMIN_KEY
  if (!bad) {
    try {
      const { resolveRole } = require('./admin/helpers')
      bad = !!(await resolveRole(key))
    } catch (e) {
      console.error('KAZU 金鑰碰撞檢查失敗，暫時拒絕:', e.message)
      return true
    }
  }
  _collision = { key, bad }
  if (bad) console.error('⚠️ KAZU_LEDGER_KEY 與總管理員或房東金鑰相同，KAZU 端點已停用')
  return bad
}

async function auth(req, res, next) {
  const key = process.env.KAZU_LEDGER_KEY
  if (!key || key.length < KEY_MIN_LENGTH) return res.status(404).json({ error: 'not found' })
  if (await keyCollides(key)) return res.status(404).json({ error: 'not found' })
  const m = /^Bearer (.+)$/.exec(String(req.headers.authorization || ''))
  if (!m || !crypto.timingSafeEqual(sha(m[1]), sha(key))) return res.status(401).json({ error: 'unauthorized' })
  next()
}

// ── 項目組裝（沿用後台的租金／車位排程計算）──────────────────────
function statusOf(item, today) {
  const unpaid = Math.max(0, item.amount - item.paidAmount)
  let status
  if (unpaid <= 0) status = 'paid'
  else if (item.paidAmount > 0) status = 'partial'
  else if (item.dueDate && item.dueDate < today) status = 'overdue'
  else status = 'unpaid'
  const overdue = status !== 'paid' && !!item.dueDate && item.dueDate < today
  return { status, overdue }
}

const STATUS_LABEL = { paid: '已繳', unpaid: '未繳', overdue: '逾期', partial: '部分' }

// 回傳該合約所有項目（含內部欄位 raw / storedId，輸出前再白名單化）
function buildItems(lease, rentPayments, readings) {
  const L = ledger()
  const items = []
  const push = (kind, r) => {
    const storedId = r.id || null
    items.push({
      itemId: storedId ? `rp:${storedId}` : `gen:${lease.id}:${kind}:${tpe(r.periodStart)}:${tpe(r.periodEnd)}`,
      kind, leaseId: lease.id, storedId, raw: r,
      periodStart: tpe(r.periodStart), periodEnd: tpe(r.periodEnd),
      amount: r.amount || 0, dueDate: tpe(r.dueDate),
      paidAmount: r.paidAmount || 0, paidDate: tpe(r.paidDate),
    })
  }
  // 已結算合約不會進來（只處理在租合約）；排程已排除隱藏／被去重的列
  L.buildRentSchedule(lease, rentPayments).forEach(r => push('rent', r))
  L.buildParkingSchedule(lease, rentPayments).forEach(r => push('parking', r))
  readings.forEach(rd => {
    items.push({
      itemId: `ur:${rd.id}`, kind: 'utility', leaseId: lease.id, storedId: rd.id, raw: rd,
      periodStart: tpe(rd.startDate), periodEnd: tpe(rd.endDate),
      amount: rd.amount || 0, dueDate: tpe(rd.dueDate || rd.endDate),
      paidAmount: rd.paidAmount || 0, paidDate: tpe(rd.paidDate),
    })
  })
  return items
}

function publicRow(lease, it, today) {
  const { status, overdue } = statusOf(it, today)
  return {
    itemId: it.itemId,
    leaseId: lease.id,
    property: lease.managedProperty ? lease.managedProperty.title : null,
    room: lease.roomLabel || null,
    tenantName: lease.tenantName,
    type: it.kind,
    periodStart: it.periodStart,
    periodEnd: it.periodEnd,
    amount: it.amount,
    dueDate: it.dueDate,
    paidAmount: it.paidAmount,
    paidDate: it.paidDate,
    status,
    statusLabel: STATUS_LABEL[status],
    overdue,
  }
}

// 在租＝狀態 ACTIVE 且尚未結算
const ACTIVE_LEASE_WHERE = { status: 'ACTIVE', settledAt: null }

// ── GET /pending ────────────────────────────────────────────────
router.get('/pending', async (req, res) => {
  let days = 45
  if (req.query.days !== undefined) {
    if (!/^\d{1,3}$/.test(String(req.query.days)) || Number(req.query.days) > 365) {
      return res.status(400).json({ error: 'days 必須是 0–365 的整數' })
    }
    days = Number(req.query.days)
  }
  const room = req.query.room !== undefined ? String(req.query.room) : null
  try {
    const where = { ...ACTIVE_LEASE_WHERE }
    if (room !== null) where.roomLabel = room
    const leases = await prisma.lease.findMany({
      where,
      include: { managedProperty: { select: { title: true } } },
    })
    const ids = leases.map(l => l.id)
    const [rps, rds] = await Promise.all([
      ids.length ? prisma.rentPayment.findMany({ where: { leaseId: { in: ids } } }) : [],
      ids.length ? prisma.utilityReading.findMany({ where: { leaseId: { in: ids } } }) : [],
    ])
    const today = tpe(new Date())
    const todayMs = Date.parse(today)
    const out = []
    for (const l of leases) {
      let items
      try {
        items = buildItems(l, rps.filter(p => p.leaseId === l.id), rds.filter(r => r.leaseId === l.id))
      } catch (e) { continue }
      for (const it of items) {
        if (!it.dueDate) continue
        const diff = Math.round((Date.parse(it.dueDate) - todayMs) / 86400000)
        if (Math.abs(diff) > days) continue
        out.push(publicRow(l, it, today))
      }
    }
    out.sort((a, b) => (a.dueDate < b.dueDate ? -1 : a.dueDate > b.dueDate ? 1 : 0))
    res.json({ today, days, items: out })
  } catch (e) {
    console.error('KAZU pending 失敗:', e.message)
    res.status(500).json({ error: 'internal error' })
  }
})

// ── GET /reminders（最近 60 天）─────────────────────────────────
router.get('/reminders', async (req, res) => {
  try {
    res.json({ days: 60, reminders: await listRecentReminders(60) })
  } catch (e) {
    console.error('KAZU reminders 失敗:', e.message)
    res.status(500).json({ error: 'internal error' })
  }
})

// ── POST /payment ───────────────────────────────────────────────
function parseDate(s) {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return null
  const d = new Date(s)
  return !isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s ? d : null
}

const TYPES = ['rent', 'parking', 'utility']

// 把請求轉成「項目條件」；之後一律對照目前排程重新解析
async function parseTarget(b) {
  if (typeof b.itemId === 'string' && b.itemId) {
    const id = b.itemId
    let m
    if ((m = /^rp:([A-Za-z0-9]+)$/.exec(id))) {
      const rp = await prisma.rentPayment.findUnique({ where: { id: m[1] } })
      return rp ? { leaseId: rp.leaseId, itemId: id } : null
    }
    if ((m = /^ur:([A-Za-z0-9]+)$/.exec(id))) {
      const rd = await prisma.utilityReading.findUnique({ where: { id: m[1] } })
      return rd ? { leaseId: rd.leaseId, itemId: id } : null
    }
    if ((m = /^gen:([A-Za-z0-9]+):(rent|parking):(\d{4}-\d{2}-\d{2}):(\d{4}-\d{2}-\d{2})$/.exec(id))) {
      return { leaseId: m[1], kind: m[2], periodStart: m[3], periodEnd: m[4] }
    }
    return null
  }
  if (typeof b.leaseId === 'string' && TYPES.includes(b.type) && typeof b.periodEnd === 'string') {
    return { leaseId: b.leaseId, kind: b.type, periodStart: typeof b.periodStart === 'string' ? b.periodStart : null, periodEnd: b.periodEnd }
  }
  return null
}

function pickItem(items, t) {
  if (t.itemId) return items.filter(i => i.itemId === t.itemId)
  return items.filter(i => i.kind === t.kind && i.periodEnd === t.periodEnd && (t.periodStart ? i.periodStart === t.periodStart : true))
}

async function registerPayment(target, paidAmount, paidDate) {
  return prisma.$transaction(async tx => {
    // 每次都重新依目前資料確認：在租、非隱藏、非被去重排除（排程已處理）
    const lease = await tx.lease.findFirst({
      where: { id: target.leaseId, ...ACTIVE_LEASE_WHERE },
      include: { managedProperty: { select: { title: true, landlordId: true } } },
    })
    if (!lease) throw new HttpError(404, '找不到在租合約')
    const [rps, rds] = await Promise.all([
      tx.rentPayment.findMany({ where: { leaseId: lease.id } }),
      tx.utilityReading.findMany({ where: { leaseId: lease.id } }),
    ])
    const found = pickItem(buildItems(lease, rps, rds), target)
    if (found.length === 0) throw new HttpError(404, '找不到此應繳項目（期別可能已變更，請重新查詢 pending）')
    if (found.length > 1) throw new HttpError(400, '條件對應到多個項目，請改用 itemId')
    const item = found[0]

    const already = item.kind === 'utility' ? (item.paidAmount > 0 || !!item.paidDate) : item.paidAmount > 0
    if (already) {
      throw new HttpError(409, '此期已有已繳紀錄，KAZU 不能覆蓋', {
        existing: { itemId: item.itemId, paidAmount: item.paidAmount, paidDate: item.paidDate },
      })
    }
    // 與後台相同：應繳大於 0 的項目須填已繳金額；租金／車位一律須大於 0
    if (paidAmount <= 0 && (item.kind !== 'utility' || item.amount > 0)) {
      throw new HttpError(400, 'paidAmount 必須大於 0')
    }
    const conflict = () => new HttpError(409, '此期已有已繳紀錄，KAZU 不能覆蓋', { existing: { itemId: item.itemId } })

    let newItemId = item.itemId
    if (item.kind === 'utility') {
      const rd = item.raw
      const upd = await tx.utilityReading.updateMany({
        where: { id: rd.id, paidAmount: 0, paidDate: null },
        data: { paidAmount, paidDate },
      })
      if (upd.count !== 1) throw conflict()
      await tx.managementRecord.create({
        data: {
          managedPropertyId: lease.managedPropertyId, leaseId: lease.id,
          type: 'INCOME', category: 'UTILITY', amount: paidAmount, recordDate: paidDate,
          description: ledger().utilityReceiptDescription(rd, lease, null),
        },
      })
    } else {
      const isParking = item.kind === 'parking'
      const r = item.raw
      let paymentId = item.storedId
      if (paymentId) {
        const upd = await tx.rentPayment.updateMany({
          where: { id: paymentId, leaseId: lease.id, paidAmount: 0 },
          data: { paidAmount, paidDate },
        })
        if (upd.count !== 1) throw conflict()
      } else {
        // 推算期別首次落庫：欄位全由伺服器依排程計算
        const created = await tx.rentPayment.create({
          data: {
            leaseId: lease.id,
            periodStart: r.periodStart, periodEnd: r.periodEnd, dueDate: r.dueDate,
            amount: r.amount || 0, paidAmount, paidDate,
            note: isParking ? `汽車位租金${lease.parkingSpotId ? ` ${lease.parkingSpotId}` : ''}` : (r.note || null),
          },
        })
        paymentId = created.id
        newItemId = `rp:${paymentId}`
      }
      const record = await tx.managementRecord.create({
        data: {
          managedPropertyId: lease.managedPropertyId, leaseId: lease.id,
          type: 'INCOME', category: isParking ? 'PARKING' : 'RENT', amount: paidAmount, recordDate: paidDate,
          description: `${isParking ? '汽車位租金' : '租金'} ${adminYmd(r.periodStart)}~${adminYmd(r.periodEnd)}`,
        },
      })
      await tx.rentPayment.update({ where: { id: paymentId }, data: { recordId: record.id } })
    }

    // 稽核與收款同一交易：稽核寫不進去就整筆回滾
    await tx.auditLog.create({
      data: {
        actorLabel: 'kazu', actorRole: 'kazu',
        landlordId: lease.managedProperty ? lease.managedProperty.landlordId : null,
        method: 'KAZU', path: '/api/kazu/ledger/payment', action: 'KAZU 登記收款',
        summary: JSON.stringify({
          source: 'kazu', itemId: newItemId, leaseId: lease.id, type: item.kind,
          periodStart: item.periodStart, periodEnd: item.periodEnd, amount: item.amount,
          before: { paidAmount: item.paidAmount, paidDate: item.paidDate },
          after: { paidAmount, paidDate: tpe(paidDate) },
        }),
        status: 200,
      },
    })
    return { itemId: newItemId, leaseId: lease.id, type: item.kind, amount: item.amount, paidAmount, paidDate: tpe(paidDate) }
  }, { isolationLevel: 'Serializable' })
}

router.post('/payment', express.json({ limit: '10kb' }), async (req, res) => {
  const b = req.body && typeof req.body === 'object' ? req.body : {}
  // 只取已繳金額與繳款日期；其他欄位（應繳金額、租金、備註…）一律忽略
  if (typeof b.paidAmount !== 'number' || !Number.isInteger(b.paidAmount) || b.paidAmount < 0 || b.paidAmount > MAX_PAID_AMOUNT) {
    return res.status(400).json({ error: 'paidAmount 必須是整數（0–' + MAX_PAID_AMOUNT + '）' })
  }
  const paidDate = parseDate(b.paidDate)
  if (!paidDate) return res.status(400).json({ error: 'paidDate 必須是 YYYY-MM-DD' })
  try {
    const target = await parseTarget(b)
    if (!target) return res.status(400).json({ error: '請提供有效的 itemId，或 leaseId + type + periodStart/periodEnd' })
    let lastErr
    for (let i = 0; i < 4; i++) {
      try {
        const result = await registerPayment(target, b.paidAmount, paidDate)
        return res.json({ ok: true, ...result })
      } catch (e) {
        lastErr = e
        // 序列化衝突（P2034）→ 重新查詢後再試；重試後通常會看到已繳而回 409
        if (!(e && e.code === 'P2034')) break
      }
    }
    throw lastErr
  } catch (e) {
    if (e instanceof HttpError) return res.status(e.status).json({ error: e.message, ...e.extra })
    console.error('KAZU payment 失敗:', e.message)
    res.status(500).json({ error: 'internal error' })
  }
})

router.use((req, res) => res.status(404).json({ error: 'not found' }))
router.use((err, req, res, next) => res.status(400).json({ error: 'bad request' }))

// 限流與驗證放在所有路由之前
const root = express.Router()
root.use(rateLimit, auth, router)

module.exports = root
module.exports._resetForTest = () => { _hits.clear(); _collision = { key: null, bad: false } }
