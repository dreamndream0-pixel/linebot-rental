// src/admin/routes/smartlock.js — 智慧門鎖（TTLock）後台管理（移植自 rubyclean）
// 掛在「包租代管」功能底下；需總管理員授權 features.smartlock 才可用。
// 資料模型：房東的 landlord.lockRooms（JSON）= { roomKey: { type, ids, userId } }
const express = require('express')
const router = express.Router()
const prisma = require('../../db')
const { resolveRole } = require('../helpers')
const { listLocks, parseCreds, BUILDINGS, DEFAULT_LOCK_DB, parseUsage, unpaidTotal, FREE_QUOTA, CHARGE_AMOUNT } = require('../../smartlock')

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

// 統一權限入口：解析身分 + 檢查功能授權 + 取得目標房東 id
// super 可用 query/body 的 landlordId 指定；房東只能操作自己
async function authLandlord(req, res) {
  const auth = await resolveRole(req.query.key)
  if (!auth) { res.status(401).json({ error: 'unauthorized' }); return null }
  if (!(await hasSmartlock(auth))) { res.status(403).json({ error: '未授權門鎖功能' }); return null }
  let landlordId = auth.landlordId
  if (auth.role === 'super') {
    landlordId = req.query.landlordId || (req.body && req.body.landlordId) || auth.landlordId
  }
  if (!landlordId) { res.status(400).json({ error: '缺少 landlordId（請以房東身分登入或指定 landlordId）' }); return null }
  return { auth, landlordId }
}

function parseRoomsJson(json) {
  if (!json) return {}
  try { const r = JSON.parse(json); return (r && typeof r === 'object') ? r : {} } catch { return {} }
}

// ── 門鎖設定狀態（TTLock 帳密是否已填；不回傳密鑰）+ 建物清單 ──
router.get('/admin/api/smartlock/config', async (req, res) => {
  const ctx = await authLandlord(req, res); if (!ctx) return
  try {
    const landlord = await prisma.landlord.findUnique({
      where: { id: ctx.landlordId },
      select: { ttlockConfig: true },
    })
    const creds = parseCreds(landlord)
    res.json({
      hasCreds: !!creds,
      username: creds ? creds.username : '',
      landlordId: ctx.landlordId,
      buildings: BUILDINGS,
    })
  } catch (e) { res.status(500).json({ error: e.message }) }
})

// ── 儲存房東 TTLock 帳密 ──
router.post('/admin/api/smartlock/config', express.json(), async (req, res) => {
  const ctx = await authLandlord(req, res); if (!ctx) return
  const { clientId, clientSecret, username, password } = req.body || {}
  if (!clientId || !clientSecret || !username || !password) {
    return res.status(400).json({ error: '請完整填寫 clientId / clientSecret / username / password' })
  }
  try {
    await prisma.landlord.update({
      where: { id: ctx.landlordId },
      data: { ttlockConfig: JSON.stringify({ clientId, clientSecret, username, password }) },
    })
    res.json({ ok: true })
  } catch (e) { res.status(500).json({ error: e.message }) }
})

// ── 列出該房東 TTLock 帳號下所有門鎖（供對照 lockId）──
router.get('/admin/api/smartlock/locks', async (req, res) => {
  const ctx = await authLandlord(req, res); if (!ctx) return
  try {
    const landlord = await prisma.landlord.findUnique({
      where: { id: ctx.landlordId },
      select: { ttlockConfig: true },
    })
    const creds = parseCreds(landlord)
    if (!creds) return res.status(400).json({ error: '尚未設定 TTLock 帳密' })
    const result = await listLocks(creds)
    if (result.error) return res.status(502).json(result)
    res.json(result)
  } catch (e) { res.status(500).json({ error: e.message }) }
})

// ── 讀取房間門鎖設定（建物 + 每間 type/ids/userId）──
router.get('/admin/api/smartlock/rooms', async (req, res) => {
  const ctx = await authLandlord(req, res); if (!ctx) return
  try {
    const landlord = await prisma.landlord.findUnique({
      where: { id: ctx.landlordId },
      select: { lockRooms: true },
    })
    res.json({ buildings: BUILDINGS, rooms: parseRoomsJson(landlord && landlord.lockRooms) })
  } catch (e) { res.status(500).json({ error: e.message }) }
})

// ── 儲存房間門鎖設定（整包覆蓋）──
// body: { rooms: { roomKey: { type, ids:[Int], userId } } }
router.post('/admin/api/smartlock/rooms', express.json(), async (req, res) => {
  const ctx = await authLandlord(req, res); if (!ctx) return
  const incoming = (req.body && req.body.rooms && typeof req.body.rooms === 'object') ? req.body.rooms : null
  if (!incoming) return res.status(400).json({ error: '缺少 rooms 資料' })

  // 正規化 + 只保留合法的 roomKey（存在於 BUILDINGS）
  const validKeys = new Set()
  BUILDINGS.forEach(b => b.rooms.forEach(r => validKeys.add(b.id + '_' + r)))
  const clean = {}
  for (const key of Object.keys(incoming)) {
    if (!validKeys.has(key)) continue
    const v = incoming[key] || {}
    const type = ['keypad', 'ttlock', 'traditional'].includes(v.type) ? v.type : 'keypad'
    const entry = { type }
    if (type === 'ttlock') {
      entry.ids = Array.isArray(v.ids)
        ? v.ids.map(Number).filter(n => !isNaN(n) && n > 0)
        : []
    }
    const userId = (v.userId == null ? '' : String(v.userId)).trim()
    if (userId) entry.userId = userId
    clean[key] = entry
  }

  try {
    await prisma.landlord.update({
      where: { id: ctx.landlordId },
      data: { lockRooms: JSON.stringify(clean) },
    })
    res.json({ ok: true, count: Object.keys(clean).length })
  } catch (e) { res.status(500).json({ error: e.message }) }
})

// ── 匯入 rubyclean 預設門鎖資料（保留已填 userId）──
router.post('/admin/api/smartlock/seed', express.json(), async (req, res) => {
  const ctx = await authLandlord(req, res); if (!ctx) return
  try {
    const landlord = await prisma.landlord.findUnique({
      where: { id: ctx.landlordId },
      select: { lockRooms: true },
    })
    const cur = parseRoomsJson(landlord && landlord.lockRooms)
    const merged = {}
    for (const key of Object.keys(DEFAULT_LOCK_DB)) {
      const def = DEFAULT_LOCK_DB[key]
      const entry = { type: def.type }
      if (def.type === 'ttlock' && Array.isArray(def.ids)) entry.ids = def.ids.slice()
      // 保留原本已填的房客 User ID（不覆蓋）
      if (cur[key] && cur[key].userId) entry.userId = cur[key].userId
      merged[key] = entry
    }
    await prisma.landlord.update({
      where: { id: ctx.landlordId },
      data: { lockRooms: JSON.stringify(merged) },
    })
    res.json({ ok: true, count: Object.keys(merged).length })
  } catch (e) { res.status(500).json({ error: e.message }) }
})

// ── 用量／帳款：列出各房客本年度取密碼次數與待收帳款 ──
router.get('/admin/api/smartlock/usage', async (req, res) => {
  const ctx = await authLandlord(req, res); if (!ctx) return
  try {
    const landlord = await prisma.landlord.findUnique({
      where: { id: ctx.landlordId },
      select: { lockUsage: true, lockRooms: true },
    })
    const usage = parseUsage(landlord)
    const rooms = parseRoomsJson(landlord && landlord.lockRooms)
    const year = new Date().getFullYear()
    // 綁定房間對照：userId → [房間 label]
    const roomsByUser = {}
    Object.keys(rooms).forEach(k => {
      const uid = rooms[k] && rooms[k].userId
      if (uid) { (roomsByUser[uid] = roomsByUser[uid] || []).push(k) }
    })
    const list = Object.keys(usage).map(uid => {
      const u = usage[uid] || {}
      return {
        userId: uid,
        name: u.name || '',
        rooms: roomsByUser[uid] || [],
        issuedThisYear: (u.year === year) ? (u.issued || 0) : 0,
        owe: unpaidTotal(u.charges),
        charges: Array.isArray(u.charges) ? u.charges : [],
      }
    }).sort((a, b) => b.owe - a.owe)
    res.json({ freeQuota: FREE_QUOTA, chargeAmount: CHARGE_AMOUNT, list })
  } catch (e) { res.status(500).json({ error: e.message }) }
})

// ── 結清某房客帳款（全部標記已收）──
router.post('/admin/api/smartlock/usage/settle', express.json(), async (req, res) => {
  const ctx = await authLandlord(req, res); if (!ctx) return
  const userId = req.body && req.body.userId
  if (!userId) return res.status(400).json({ error: '缺少 userId' })
  try {
    const landlord = await prisma.landlord.findUnique({
      where: { id: ctx.landlordId },
      select: { lockUsage: true },
    })
    const usage = parseUsage(landlord)
    if (!usage[userId]) return res.status(404).json({ error: '找不到該房客用量資料' })
    const charges = (Array.isArray(usage[userId].charges) ? usage[userId].charges : []).map(c => ({ ...c, paid: true }))
    usage[userId].charges = charges
    await prisma.landlord.update({ where: { id: ctx.landlordId }, data: { lockUsage: JSON.stringify(usage) } })
    res.json({ ok: true })
  } catch (e) { res.status(500).json({ error: e.message }) }
})

module.exports = router
