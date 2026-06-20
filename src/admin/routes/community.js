const express = require('express')
const router = express.Router()
const { resolveRole } = require('../helpers')
const prisma = require('../../db')

// 每次請求前都確認資料表存在（有 cache 避免重複執行）
let _tableEnsured = false
async function ensureTable() {
  if (_tableEnsured) return
  const results = []
  try {
    await prisma.$queryRawUnsafe(`
      CREATE TABLE IF NOT EXISTS communities (
        id           TEXT PRIMARY KEY,
        "ownerId"    TEXT,
        name         TEXT NOT NULL,
        description  TEXT NOT NULL DEFAULT '',
        photos       TEXT NOT NULL DEFAULT '[]',
        "mapUrl"     TEXT,
        "createdAt"  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        "updatedAt"  TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `)
    results.push('communities table OK')
  } catch(e) {
    results.push('communities table ERROR: ' + e.message)
    return results  // 建表失敗就停下，不往後走
  }
  try {
    await prisma.$queryRawUnsafe(`ALTER TABLE communities ALTER COLUMN "ownerId" DROP NOT NULL`)
    results.push('drop NOT NULL OK')
  } catch(e) { results.push('drop NOT NULL skip: ' + e.message) }
  try {
    await prisma.$queryRawUnsafe(`ALTER TABLE properties ADD COLUMN IF NOT EXISTS "communityId" TEXT`)
    results.push('communityId column OK')
  } catch(e) { results.push('communityId column skip: ' + e.message) }
  _tableEnsured = true
  return results
}

function newId() {
  return require('crypto').randomBytes(12).toString('base64url').replace(/[^a-z0-9]/gi, '').slice(0, 20)
}

// 專用 migrate 端點，讓後台頁面可以主動觸發並查看結果
router.get('/admin/api/migrate', async (req, res) => {
  try {
    const auth = await resolveRole(req.query.key)
    if (!auth) return res.status(401).json({ error: 'unauthorized' })
    _tableEnsured = false  // 強制重新執行
    const results = await ensureTable()
    res.json({ ok: _tableEnsured, results })
  } catch(e) {
    res.status(500).json({ error: e.message })
  }
})

router.get('/admin/api/community', async (req, res) => {
  try {
    const auth = await resolveRole(req.query.key)
    if (!auth) return res.status(401).json({ error: 'unauthorized' })
    await ensureTable()
    const communities = await prisma.$queryRawUnsafe(
      auth.role === 'super'
        ? `SELECT * FROM communities ORDER BY "createdAt" DESC`
        : `SELECT * FROM communities WHERE "ownerId" = $1 ORDER BY "createdAt" DESC`,
      ...(auth.role === 'super' ? [] : [auth.landlordId])
    )
    res.json(communities)
  } catch(e) { console.error(e); res.status(500).json({ error: e.message }) }
})

router.post('/admin/api/community', express.json(), async (req, res) => {
  try {
    const auth = await resolveRole(req.query.key)
    if (!auth) return res.status(401).json({ error: 'unauthorized' })
    await ensureTable()
    const ownerId = auth.role === 'super' ? (req.body.ownerId || null) : auth.landlordId
    const { name, description = '', photos = [], mapUrl = '' } = req.body
    if (!name) return res.status(400).json({ error: '請填寫社區名稱' })
    const id = 'c' + newId()
    await prisma.$queryRawUnsafe(
      `INSERT INTO communities (id, "ownerId", name, description, photos, "mapUrl", "createdAt", "updatedAt")
       VALUES ($1, $2, $3, $4, $5, $6, NOW(), NOW())`,
      id, ownerId, name, description, JSON.stringify(photos), mapUrl || null
    )
    const rows = await prisma.$queryRawUnsafe(`SELECT * FROM communities WHERE id = $1`, id)
    res.json(rows[0])
  } catch(e) { console.error(e); res.status(500).json({ error: e.message }) }
})

router.post('/admin/api/community/:id', express.json(), async (req, res) => {
  try {
    const auth = await resolveRole(req.query.key)
    if (!auth) return res.status(401).json({ error: 'unauthorized' })
    await ensureTable()
    const { name, description, photos, mapUrl } = req.body
    if (name !== undefined)        await prisma.$queryRawUnsafe(`UPDATE communities SET name=$1, "updatedAt"=NOW() WHERE id=$2`, name, req.params.id)
    if (description !== undefined) await prisma.$queryRawUnsafe(`UPDATE communities SET description=$1, "updatedAt"=NOW() WHERE id=$2`, description, req.params.id)
    if (photos !== undefined)      await prisma.$queryRawUnsafe(`UPDATE communities SET photos=$1, "updatedAt"=NOW() WHERE id=$2`, JSON.stringify(photos), req.params.id)
    if (mapUrl !== undefined)      await prisma.$queryRawUnsafe(`UPDATE communities SET "mapUrl"=$1, "updatedAt"=NOW() WHERE id=$2`, mapUrl || null, req.params.id)
    const rows = await prisma.$queryRawUnsafe(`SELECT * FROM communities WHERE id = $1`, req.params.id)
    res.json(rows[0])
  } catch(e) { console.error(e); res.status(500).json({ error: e.message }) }
})

router.post('/admin/api/community/:id/delete', express.json(), async (req, res) => {
  try {
    const auth = await resolveRole(req.query.key)
    if (!auth) return res.status(401).json({ error: 'unauthorized' })
    await ensureTable()
    await prisma.$queryRawUnsafe(`UPDATE properties SET "communityId"=NULL WHERE "communityId"=$1`, req.params.id)
    await prisma.$queryRawUnsafe(`DELETE FROM communities WHERE id=$1`, req.params.id)
    res.json({ ok: true })
  } catch(e) { console.error(e); res.status(500).json({ error: e.message }) }
})

module.exports = router
