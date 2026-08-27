// src/admin/routes/operators.js — 房東底下「操作人員」管理（Gmail 白名單 + 權限）
const express = require('express')
const router = express.Router()
const prisma = require('../../db')
const { resolveRole, parseOperators, normalizeOperatorPermission } = require('../helpers')

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

// 只有「房東本人（金鑰/一般登入，非操作人員）」或「總管理員（帶 landlordId）」能管理操作人員。
// 操作人員（含 full 權限）一律不得管理操作人員，避免權限擴張。
async function requireManager(req, res) {
  const auth = await resolveRole(req.query.key)
  if (!auth) { res.status(401).json({ error: 'unauthorized' }); return null }
  if (auth.operator) { res.status(403).json({ error: '操作人員無法管理操作人員名單' }); return null }
  let landlordId = auth.landlordId
  if (auth.role === 'super') landlordId = req.query.landlordId || null
  if (!landlordId) { res.status(400).json({ error: '缺少 landlordId' }); return null }
  return { auth, landlordId }
}

async function loadOperators(landlordId) {
  const l = await prisma.landlord.findUnique({ where: { id: landlordId }, select: { operators: true } })
  return parseOperators(l && l.operators)
}

async function saveOperators(landlordId, ops) {
  await prisma.landlord.update({ where: { id: landlordId }, data: { operators: JSON.stringify(ops) } })
}

const PERMISSION_LABELS = { full: '完整權限', limited: '有限操作', view: '僅檢視' }

// 列出操作人員
router.get('/admin/api/operators', async (req, res) => {
  const ctx = await requireManager(req, res); if (!ctx) return
  try {
    const operators = await loadOperators(ctx.landlordId)
    res.json({ operators, permissionLabels: PERMISSION_LABELS })
  } catch (e) {
    console.error('讀取操作人員失敗:', e.message)
    res.status(500).json({ error: e.message })
  }
})

// 新增 / 更新一位操作人員
router.post('/admin/api/operators', express.json(), async (req, res) => {
  const ctx = await requireManager(req, res); if (!ctx) return
  const email = String(req.body?.email || '').trim().toLowerCase()
  const permission = normalizeOperatorPermission(req.body?.permission)
  if (!EMAIL_RE.test(email)) return res.status(400).json({ error: '請輸入正確的 Email（Gmail 或 Google 帳號）' })
  try {
    const ops = await loadOperators(ctx.landlordId)
    const idx = ops.findIndex(o => o.email === email)
    if (idx === -1) ops.push({ email, permission })
    else ops[idx].permission = permission
    await saveOperators(ctx.landlordId, ops)
    res.json({ ok: true, operators: ops })
  } catch (e) {
    console.error('新增操作人員失敗:', e.message)
    res.status(500).json({ error: e.message })
  }
})

// 移除一位操作人員
router.delete('/admin/api/operators', async (req, res) => {
  const ctx = await requireManager(req, res); if (!ctx) return
  const email = String(req.query.email || '').trim().toLowerCase()
  if (!email) return res.status(400).json({ error: '缺少 email' })
  try {
    const ops = (await loadOperators(ctx.landlordId)).filter(o => o.email !== email)
    await saveOperators(ctx.landlordId, ops)
    res.json({ ok: true, operators: ops })
  } catch (e) {
    console.error('移除操作人員失敗:', e.message)
    res.status(500).json({ error: e.message })
  }
})

module.exports = router
