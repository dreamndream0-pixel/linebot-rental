const express = require('express')
const router = express.Router()
const { PrismaClient } = require('@prisma/client')
const { resolveRole } = require('../helpers')
const prisma = new PrismaClient()

// ── 模組載入時立即建立資料表（不等第一個 request）─────────────────
const _migrationDone = (async () => {
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
    console.log('[community] communities table ready')
  } catch(e) {
    console.error('[community] CREATE TABLE failed:', e.message)
  }
  try {
    await prisma.$queryRawUnsafe(`ALTER TABLE communities ALTER COLUMN "ownerId" DROP NOT NULL`)
  } catch(_) {}
  try {
    await prisma.$queryRawUnsafe(`ALTER TABLE properties ADD COLUMN IF NOT EXISTS "communityId" TEXT`)
    console.log('[community] communityId column ready')
  } catch(_) {}
})()

function newId() {
  return require('crypto').randomBytes(12).toString('base64url').replace(/[^a-z0-9]/gi, '').slice(0, 20)
}

router.get('/admin/api/community', async (req, res) => {
  try {
    const auth = await resolveRole(req.query.key)
    if (!auth) return res.status(401).json({ error: 'unauthorized' })
    await _migrationDone
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
    await _migrationDone
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
    await _migrationDone
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
    await _migrationDone
    await prisma.$queryRawUnsafe(`UPDATE properties SET "communityId"=NULL WHERE "communityId"=$1`, req.params.id)
    await prisma.$queryRawUnsafe(`DELETE FROM communities WHERE id=$1`, req.params.id)
    res.json({ ok: true })
  } catch(e) { console.error(e); res.status(500).json({ error: e.message }) }
})

module.exports = router
