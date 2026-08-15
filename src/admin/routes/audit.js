// src/admin/routes/audit.js — 操作紀錄（審計軌跡）Phase 1：記錄後台每筆寫入操作
const express = require('express')
const router = express.Router()
const prisma = require('../../db')
const { resolveRole } = require('../helpers')

// 不記錄的路徑（登入/登出/視角切換/讀取操作紀錄本身）
const SKIP_PATHS = new Set([
  '/admin/api/login',
  '/admin/api/logout',
  '/admin/api/switch-to-broker',
  '/admin/api/switch-to-super',
  '/admin/api/audit-logs',
])

// summary 內含機敏欄位一律不留存
const SENSITIVE_KEYS = /(password|passwd|pwd|key|token|secret|adminkey|channeltoken|channelsecret|authorization)/i

// 依 method + 路徑推斷中文操作名稱
function describeAction(method, pathname) {
  const p = pathname.replace(/\/admin\/api\/?/, '')
  const table = [
    [/managed-broadcast/, 'LINE 群發'],
    [/managed-import-taipower/, '匯入台電帳單'],
    [/managed-report/, '收支報表'],
    [/managed-leases/, '租約資料'],
    [/bot-mute/, 'Bot 靜音設定'],
    [/managed\/[^/]+\/settle-notify/, '結算通知'],
    [/managed\/[^/]+\/settle/, '合約結算'],
    [/managed\/[^/]+\/renew/, '續約'],
    [/managed\/[^/]+\/payment/, '繳費登記'],
    [/managed\/[^/]+\/remind/, '發送繳費提醒'],
    [/managed\/[^/]+\/receipt/, '發送收據'],
    [/managed\/[^/]+\/record/, '管理紀錄'],
    [/managed/, '包租代管'],
    [/smartlock|lock/, '智慧門鎖'],
    [/tenant/, '租客資料'],
    [/propert/, '房源資料'],
    [/landlord/, '房東資料'],
    [/community/, '社區資料'],
    [/booking/, '預約資料'],
    [/repair/, '報修資料'],
    [/feature/, '功能模組'],
    [/site\/hero|hero/, '首頁設定'],
    [/site\/pages|pages/, '頁面設定'],
    [/upload/, '上傳檔案'],
    [/import|export/, '匯入匯出'],
    [/social/, '社群設定'],
    [/webuser/, '網站帳號'],
  ]
  const verb = { POST: '新增/送出', PUT: '更新', PATCH: '更新', DELETE: '刪除' }[method] || method
  for (const [re, label] of table) if (re.test(p)) return `${label}・${verb}`
  return `${p || pathname}・${verb}`
}

// 從 req.body 擷取可留存的摘要（過濾機敏欄位、限制長度）
function buildSummary(body) {
  if (!body || typeof body !== 'object') return null
  try {
    const out = {}
    for (const [k, v] of Object.entries(body)) {
      if (SENSITIVE_KEYS.test(k)) continue
      if (v == null) continue
      if (typeof v === 'string') out[k] = v.length > 200 ? v.slice(0, 200) + '…' : v
      else if (typeof v === 'number' || typeof v === 'boolean') out[k] = v
      else if (Array.isArray(v)) out[k] = `[${v.length} 筆]`
      else out[k] = '{…}'
    }
    const s = JSON.stringify(out)
    if (s === '{}') return null
    return s.length > 1000 ? s.slice(0, 1000) + '…' : s
  } catch (_) { return null }
}

// 中介層：記錄所有寫入類（POST/PUT/PATCH/DELETE）/admin/api/* 操作
function auditMiddleware(req, res, next) {
  const method = req.method
  const pathname = (req.originalUrl || req.url || '').split('?')[0]
  const isWrite = method === 'POST' || method === 'PUT' || method === 'PATCH' || method === 'DELETE'
  if (!isWrite || !pathname.startsWith('/admin/api/') || SKIP_PATHS.has(pathname)) return next()

  const key = req.query.key
  res.on('finish', async () => {
    try {
      const auth = await resolveRole(key).catch(() => null)
      await prisma.auditLog.create({
        data: {
          actorLabel: auth ? (auth.label || null) : null,
          actorRole: auth ? (auth.role || null) : null,
          landlordId: auth ? (auth.landlordId || null) : null,
          method,
          path: pathname,
          action: describeAction(method, pathname),
          summary: buildSummary(req.body),
          status: res.statusCode,
        },
      })
    } catch (e) {
      console.error('⚠️ 操作紀錄寫入失敗:', e.message)
    }
  })
  next()
}

// GET /admin/api/audit-logs — 查看操作紀錄（super 看全部，房東只看自己的）
router.get('/admin/api/audit-logs', async (req, res) => {
  const auth = await resolveRole(req.query.key)
  if (!auth) return res.status(401).json({ error: 'unauthorized' })
  const take = Math.min(parseInt(req.query.limit, 10) || 100, 300)
  const where = auth.role === 'super' ? {} : { landlordId: auth.landlordId }
  try {
    const rows = await prisma.auditLog.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take,
    })
    res.json({ ok: true, logs: rows })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

module.exports = router
module.exports.auditMiddleware = auditMiddleware
