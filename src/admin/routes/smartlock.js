// src/admin/routes/smartlock.js — 智慧門鎖（TTLock）後台管理（移植自 rubyclean）
// 掛在「包租代管」功能底下；需總管理員授權 features.smartlock 才可用。
// 資料模型：房東的 landlord.lockRooms（JSON）= { roomKey: { type, ids, userId } }
const express = require('express')
const router = express.Router()
const prisma = require('../../db')
const { resolveRole } = require('../helpers')
const { listLocks, parseCreds, buildingsForLandlord, defaultLockDbFor, inferLockRoomsFromLiveLocks, parseUsage, unpaidTotal, FREE_QUOTA, CHARGE_AMOUNT, syncLockRoomsFromLeases, listLandlordLeases } = require('../../smartlock')

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

function normalizeLockEntry(entry) {
  const e = entry && typeof entry === 'object' ? entry : {}
  const type = ['keypad', 'ttlock', 'traditional'].includes(e.type) ? e.type : 'keypad'
  const out = { type }
  if (type === 'ttlock') {
    const ids = Array.isArray(e.ids) ? e.ids.map(Number).filter(n => !isNaN(n) && n > 0) : []
    if (ids.length) out.ids = [...new Set(ids)]
  }
  if (e.userId) out.userId = String(e.userId).trim()
  if (e.leaseId) out.leaseId = String(e.leaseId).trim()
  return out
}

function hasLockIds(entry) {
  return entry && entry.type === 'ttlock' && Array.isArray(entry.ids) && entry.ids.length > 0
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
      buildings: await buildingsForLandlord(ctx.landlordId),
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
    const leases = await listLandlordLeases(ctx.landlordId)
    res.json({ buildings: await buildingsForLandlord(ctx.landlordId), rooms: parseRoomsJson(landlord && landlord.lockRooms), leases })
  } catch (e) { res.status(500).json({ error: e.message }) }
})

// ── 儲存房間門鎖設定（整包覆蓋）──
// body: { rooms: { roomKey: { type, ids:[Int], userId } } }
router.post('/admin/api/smartlock/rooms', express.json(), async (req, res) => {
  const ctx = await authLandlord(req, res); if (!ctx) return
  const incoming = (req.body && req.body.rooms && typeof req.body.rooms === 'object') ? req.body.rooms : null
  if (!incoming) return res.status(400).json({ error: '缺少 rooms 資料' })

  // 正規化 + 只保留合法的 roomKey（存在於該房東自己的建物清單）
  const validKeys = new Set()
  const buildings = await buildingsForLandlord(ctx.landlordId)
  buildings.forEach(b => b.rooms.forEach(r => validKeys.add(b.id + '_' + r)))
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
    const leaseId = (v.leaseId == null ? '' : String(v.leaseId)).trim()
    if (leaseId) entry.leaseId = leaseId
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
    const seedDb = defaultLockDbFor(ctx.landlordId)
    // 非原始仲介房東沒有內建預設門鎖 → 不覆蓋，保留現有綁定
    if (!Object.keys(seedDb).length) {
      return res.json({ ok: true, count: Object.keys(cur).length, skipped: true })
    }
    const merged = {}
    for (const k of Object.keys(cur)) merged[k] = normalizeLockEntry(cur[k])
    for (const key of Object.keys(seedDb)) {
      const def = seedDb[key]
      const curEntry = normalizeLockEntry(cur[key])
      const entry = hasLockIds(curEntry) ? curEntry : { type: def.type }
      if (!hasLockIds(curEntry) && def.type === 'ttlock' && Array.isArray(def.ids)) entry.ids = def.ids.slice()
      // 保留原本已填的房客 User ID 與綁定的合約（不覆蓋）
      if (cur[key] && cur[key].userId) entry.userId = cur[key].userId
      if (cur[key] && cur[key].leaseId) entry.leaseId = cur[key].leaseId
      merged[key] = entry
    }
    await prisma.landlord.update({
      where: { id: ctx.landlordId },
      data: { lockRooms: JSON.stringify(merged) },
    })
    res.json({ ok: true, count: Object.keys(merged).length })
  } catch (e) { res.status(500).json({ error: e.message }) }
})

// ── 從 TTLock 帳號抓取現有門鎖，覆蓋房間門鎖資料（保留 userId/leaseId）──
// 依內建 room↔lockId 對照表指派，但只保留 TTLock 帳號目前實際存在的鎖；
// 帳號中尚未對應到房間的鎖（可能是新加的）會回報，供房東手動綁定。
router.post('/admin/api/smartlock/import-ttlock', express.json(), async (req, res) => {
  const ctx = await authLandlord(req, res); if (!ctx) return
  try {
    const landlord = await prisma.landlord.findUnique({
      where: { id: ctx.landlordId },
      select: { ttlockConfig: true, lockRooms: true },
    })
    const creds = parseCreds(landlord)
    if (!creds) return res.status(400).json({ error: '尚未設定 TTLock 帳密' })
    const result = await listLocks(creds)
    if (result.error) return res.status(502).json(result)
    const liveLocks = result.list || []
    const liveIds = new Set(liveLocks.map(l => Number(l.lockId)))
    const cur = parseRoomsJson(landlord && landlord.lockRooms)
    const buildings = await buildingsForLandlord(ctx.landlordId)
    const inferred = inferLockRoomsFromLiveLocks(liveLocks, buildings)

    // 先保留房東現有資料；下方再用 TTLock 雲端最新清單更新硬體設定。
    // userId / leaseId 是房客合約綁定，匯入硬體資料時一律保留。
    const merged = {}
    for (const k of Object.keys(cur)) merged[k] = normalizeLockEntry(cur[k])
    const usedIds = new Set()
    const seedDb = defaultLockDbFor(ctx.landlordId)
    const importKeys = new Set([...Object.keys(cur), ...Object.keys(seedDb), ...Object.keys(inferred.byKey || {})])
    for (const key of importKeys) {
      const def = seedDb[key]
      let entry
      const curEntry = normalizeLockEntry(cur[key])
      const inferredIds = ((inferred.byKey && inferred.byKey[key]) || []).map(Number).filter(id => liveIds.has(id))
      const defaultIds = (def && def.type === 'ttlock' && Array.isArray(def.ids))
        ? def.ids.map(Number).filter(id => liveIds.has(id))
        : []
      const currentLiveIds = hasLockIds(curEntry)
        ? curEntry.ids.map(Number).filter(id => liveIds.has(id))
        : []

      if (inferredIds.length) {
        entry = { type: 'ttlock', ids: [...new Set(inferredIds)] }
      } else if (defaultIds.length) {
        entry = { type: 'ttlock', ids: [...new Set(defaultIds)] }
      } else if (currentLiveIds.length) {
        // 手動配對過、且 TTLock 雲端仍存在的 Lock ID，保留為最新有效硬體資料。
        entry = { type: 'ttlock', ids: [...new Set(currentLiveIds)] }
      } else {
        entry = { type: (def && def.type && def.type !== 'ttlock') ? def.type : (curEntry.type === 'traditional' ? 'traditional' : 'keypad') }
      }
      // 保留已填的房客 UID 與綁定合約
      if (cur[key] && cur[key].userId) entry.userId = cur[key].userId
      if (cur[key] && cur[key].leaseId) entry.leaseId = cur[key].leaseId
      merged[key] = entry
    }
    // 計算所有已使用（且實際存在）的 lockId：涵蓋預設對照與既有手動綁定
    for (const k of Object.keys(merged)) {
      const e = merged[k]
      if (e && e.type === 'ttlock' && Array.isArray(e.ids)) {
        e.ids.forEach(id => { if (liveIds.has(Number(id))) usedIds.add(Number(id)) })
      }
    }
    await prisma.landlord.update({
      where: { id: ctx.landlordId },
      data: { lockRooms: JSON.stringify(merged) },
    })
    const unmatched = liveLocks
      .filter(l => !usedIds.has(Number(l.lockId)))
      .map(l => ({ name: l.name || '(未命名)', lockId: l.lockId }))
    res.json({
      ok: true,
      count: Object.keys(merged).length,
      totalLocks: liveLocks.length,
      matched: usedIds.size,
      autoMatched: inferred.matched || [],
      unmatched,
    })
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

// ── 以合約租約為準，同步門鎖房間的 userId（房號比對）──
router.post('/admin/api/smartlock/sync-from-lease', express.json(), async (req, res) => {
  const ctx = await authLandlord(req, res); if (!ctx) return
  try {
    const result = await syncLockRoomsFromLeases(ctx.landlordId)
    res.json({ ok: true, ...result })
  } catch (e) { res.status(500).json({ error: e.message }) }
})

module.exports = router
