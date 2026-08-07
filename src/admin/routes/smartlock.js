// src/admin/routes/smartlock.js — 智慧門鎖（TTLock）後台管理
// 掛在「包租代管」功能底下；需總管理員授權 features.smartlock 才可用
const express = require('express')
const router = express.Router()
const prisma = require('../../db')
const { resolveRole } = require('../helpers')
const { listLocks, parseCreds } = require('../../smartlock')

// smartlock 功能授權：super 一律可用；房東需被授權 features.smartlock
async function hasSmartlock(auth) {
  if (!auth) return false
  if (auth.role === 'super') return true
  if (!auth.landlordId) return false
  try {
    const rows = await prisma.$queryRawUnsafe(`SELECT features FROM landlords WHERE id = $1`, auth.landlordId)
    const f = rows[0] && rows[0].features ? JSON.parse(rows[0].features) : {}
    return f.smartlock === true
  } catch (_) { return false }
}

// 取得代管物件（含權限驗證），回傳 managedProperty 或 false（無權）/ null（不存在）
async function getOwnedManaged(auth, managedId) {
  if (!managedId) return null
  const mp = await prisma.managedProperty.findUnique({ where: { id: managedId } })
  if (!mp) return null
  if (auth.role !== 'super' && mp.landlordId !== auth.landlordId) return false
  return mp
}

// 統一權限入口：解析身分 + 檢查功能授權 + 取得代管物件
async function authManaged(req, res) {
  const auth = await resolveRole(req.query.key)
  if (!auth) { res.status(401).json({ error: 'unauthorized' }); return null }
  if (!(await hasSmartlock(auth))) { res.status(403).json({ error: '未授權門鎖功能' }); return null }
  const managedId = req.query.managedId || (req.body && req.body.managedId)
  const mp = await getOwnedManaged(auth, managedId)
  if (mp === null) { res.status(404).json({ error: '找不到代管物件' }); return null }
  if (mp === false) { res.status(403).json({ error: 'forbidden' }); return null }
  return { auth, mp }
}

function unpaidTotal(charges) {
  if (!Array.isArray(charges)) return 0
  return charges.filter(c => !c.paid).reduce((s, c) => s + (c.amount || 0), 0)
}

// ── 門鎖設定狀態（是否已填 TTLock 帳密；不回傳密鑰）──
router.get('/admin/api/smartlock/config', async (req, res) => {
  const ctx = await authManaged(req, res); if (!ctx) return
  try {
    const landlord = await prisma.landlord.findUnique({
      where: { id: ctx.mp.landlordId },
      select: { ttlockConfig: true },
    })
    const creds = parseCreds(landlord)
    res.json({
      hasCreds: !!creds,
      username: creds ? creds.username : '',
      landlordId: ctx.mp.landlordId,
    })
  } catch (e) { res.status(500).json({ error: e.message }) }
})

// ── 儲存房東 TTLock 帳密 ──
router.post('/admin/api/smartlock/config', express.json(), async (req, res) => {
  const ctx = await authManaged(req, res); if (!ctx) return
  const { clientId, clientSecret, username, password } = req.body || {}
  if (!clientId || !clientSecret || !username || !password) {
    return res.status(400).json({ error: '請完整填寫 clientId / clientSecret / username / password' })
  }
  try {
    await prisma.landlord.update({
      where: { id: ctx.mp.landlordId },
      data: { ttlockConfig: JSON.stringify({ clientId, clientSecret, username, password }) },
    })
    res.json({ ok: true })
  } catch (e) { res.status(500).json({ error: e.message }) }
})

// ── 列出該房東 TTLock 帳號下所有門鎖（供綁定挑選）──
router.get('/admin/api/smartlock/locks', async (req, res) => {
  const ctx = await authManaged(req, res); if (!ctx) return
  try {
    const landlord = await prisma.landlord.findUnique({
      where: { id: ctx.mp.landlordId },
      select: { ttlockConfig: true },
    })
    const creds = parseCreds(landlord)
    if (!creds) return res.status(400).json({ error: '尚未設定 TTLock 帳密' })
    const result = await listLocks(creds)
    if (result.error) return res.status(502).json(result)
    res.json(result)
  } catch (e) { res.status(500).json({ error: e.message }) }
})

// ── 列出綁定房客（含用量／帳款）──
router.get('/admin/api/smartlock/tenants', async (req, res) => {
  const ctx = await authManaged(req, res); if (!ctx) return
  try {
    const rows = await prisma.lockTenant.findMany({
      where: { landlordId: ctx.mp.landlordId, managedPropertyId: ctx.mp.id },
      orderBy: { createdAt: 'desc' },
    })
    const year = new Date().getFullYear()
    res.json(rows.map(t => ({
      id: t.id,
      lineUserId: t.lineUserId,
      name: t.name || '',
      lockIds: t.lockIds || [],
      issuedThisYear: (t.year === year) ? (t.issuedThisYear || 0) : 0,
      owe: unpaidTotal(t.charges),
      charges: Array.isArray(t.charges) ? t.charges : [],
    })))
  } catch (e) { res.status(500).json({ error: e.message }) }
})

// ── 新增／更新綁定 ──
router.post('/admin/api/smartlock/tenant', express.json(), async (req, res) => {
  const ctx = await authManaged(req, res); if (!ctx) return
  const { id, lineUserId, name } = req.body || {}
  const lockIds = Array.isArray(req.body.lockIds)
    ? req.body.lockIds.map(Number).filter(n => !isNaN(n))
    : []
  if (!lineUserId || !lineUserId.trim()) return res.status(400).json({ error: '請輸入 LINE User ID' })
  if (lockIds.length === 0) return res.status(400).json({ error: '請至少選擇一把門鎖' })

  try {
    if (id) {
      // 更新：確認該筆屬於此代管物件
      const existing = await prisma.lockTenant.findUnique({ where: { id } })
      if (!existing || existing.landlordId !== ctx.mp.landlordId) {
        return res.status(404).json({ error: '找不到綁定資料' })
      }
      const updated = await prisma.lockTenant.update({
        where: { id },
        data: { lineUserId: lineUserId.trim(), name: name || null, lockIds, managedPropertyId: ctx.mp.id },
      })
      return res.json({ ok: true, id: updated.id })
    }
    // 新增（同房東同 userId 唯一 → upsert 避免衝突）
    const created = await prisma.lockTenant.upsert({
      where: { landlordId_lineUserId: { landlordId: ctx.mp.landlordId, lineUserId: lineUserId.trim() } },
      update: { name: name || null, lockIds, managedPropertyId: ctx.mp.id },
      create: {
        landlordId: ctx.mp.landlordId,
        managedPropertyId: ctx.mp.id,
        lineUserId: lineUserId.trim(),
        name: name || null,
        lockIds,
      },
    })
    res.json({ ok: true, id: created.id })
  } catch (e) { res.status(500).json({ error: e.message }) }
})

// ── 刪除綁定 ──
router.delete('/admin/api/smartlock/tenant/:id', async (req, res) => {
  const auth = await resolveRole(req.query.key)
  if (!auth) return res.status(401).json({ error: 'unauthorized' })
  if (!(await hasSmartlock(auth))) return res.status(403).json({ error: '未授權門鎖功能' })
  try {
    const existing = await prisma.lockTenant.findUnique({ where: { id: req.params.id } })
    if (!existing) return res.status(404).json({ error: '找不到綁定資料' })
    if (auth.role !== 'super' && existing.landlordId !== auth.landlordId) {
      return res.status(403).json({ error: 'forbidden' })
    }
    await prisma.lockTenant.delete({ where: { id: req.params.id } })
    res.json({ ok: true })
  } catch (e) { res.status(500).json({ error: e.message }) }
})

// ── 結清帳款（將該房客所有未收帳款標記為已收）──
router.post('/admin/api/smartlock/tenant/:id/settle', async (req, res) => {
  const auth = await resolveRole(req.query.key)
  if (!auth) return res.status(401).json({ error: 'unauthorized' })
  if (!(await hasSmartlock(auth))) return res.status(403).json({ error: '未授權門鎖功能' })
  try {
    const t = await prisma.lockTenant.findUnique({ where: { id: req.params.id } })
    if (!t) return res.status(404).json({ error: '找不到綁定資料' })
    if (auth.role !== 'super' && t.landlordId !== auth.landlordId) {
      return res.status(403).json({ error: 'forbidden' })
    }
    const charges = (Array.isArray(t.charges) ? t.charges : []).map(c => ({ ...c, paid: true }))
    await prisma.lockTenant.update({ where: { id: t.id }, data: { charges } })
    res.json({ ok: true })
  } catch (e) { res.status(500).json({ error: e.message }) }
})

module.exports = router
