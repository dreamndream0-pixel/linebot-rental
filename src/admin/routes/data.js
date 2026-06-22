// src/admin/routes/data.js — GET /admin/api/data
const express = require('express')
const router = express.Router()
const prisma = require('../../db')
const { resolveRole, landlordFilter } = require('../helpers')

// 確保 communities 資料表和 properties.communityId 欄位存在
let _migrated = false
async function ensureMigrations() {
  if (_migrated) return
  try {
    await prisma.$executeRawUnsafe(`
      CREATE TABLE IF NOT EXISTS communities (
        id           TEXT PRIMARY KEY,
        "ownerId"    TEXT NOT NULL,
        name         TEXT NOT NULL,
        description  TEXT NOT NULL DEFAULT '',
        photos       TEXT NOT NULL DEFAULT '[]',
        "mapUrl"     TEXT,
        "createdAt"  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        "updatedAt"  TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `)
    await prisma.$executeRawUnsafe(`
      ALTER TABLE properties ADD COLUMN IF NOT EXISTS "communityId" TEXT REFERENCES communities(id)
    `)
    await prisma.$executeRawUnsafe(`
      ALTER TABLE properties ADD COLUMN IF NOT EXISTS "availableFrom" TIMESTAMPTZ
    `)
    _migrated = true
  } catch (e) {
    console.error('[data] migration error:', e.message)
  }
}

router.get('/admin/api/data', async (req, res) => {
  const auth = await resolveRole(req.query.key)
  if (!auth) return res.status(401).json({ error: 'unauthorized' })

  await ensureMigrations()

  const f = landlordFilter(auth)

  const [tenants, bookings, repairs, properties, landlords] = await Promise.all([
    prisma.tenant.findMany({
      where: f,
      include: { property: true, landlord: { select: { name: true } } },
      orderBy: { createdAt: 'desc' }
    }),
    prisma.booking.findMany({
      where: f,
      include: { lineUser: true, tenant: true, property: true },
      orderBy: { createdAt: 'desc' }
    }),
    prisma.repair.findMany({
      where: f,
      include: { lineUser: true, property: true },
      orderBy: { createdAt: 'desc' }
    }),
    prisma.property.findMany({
      where: auth.role === 'super' ? { deletedAt: null } : { deletedAt: null, ownerId: auth.landlordId },
      include: { images: { orderBy: [{ isCover: 'desc' }, { order: 'asc' }] }, owner: { select: { name: true } }, tags: true, amenities: true },
      orderBy: { createdAt: 'desc' }
    }),
    auth.role === 'super'
      ? prisma.landlord.findMany({
          orderBy: { createdAt: 'desc' },
          select: { id: true, name: true, email: true, phone: true, adminKey: true, isActive: true, createdAt: true, lineBotName: true, lineChannelSecret: true, lineChannelToken: true, notifyLineUserId: true, richMenuConfig: true, richMenuId: true, richMenuEnabled: true, siteName: true, siteLogo: true, botTextConfig: true, botEnabled: true, features: true }
        })
      : Promise.resolve([]),
  ])

  const safeLandlords = landlords.map(l => ({
    id: l.id, name: l.name, email: l.email, phone: l.phone,
    adminKey: l.adminKey, isActive: l.isActive, createdAt: l.createdAt,
    lineBotName: l.lineBotName,
    notifyLineUserId: l.notifyLineUserId || null,
    botConfigured: !!(l.lineChannelSecret && l.lineChannelToken),
    richMenuConfig: l.richMenuConfig || null,
    hasRichMenu: !!l.richMenuId,
    richMenuEnabled: !!l.richMenuEnabled,
    siteName: l.siteName || null,
    siteLogo: l.siteLogo || null,
    botTextConfig: l.botTextConfig || null,
    botEnabled: l.botEnabled !== false,
    features: l.features || null,
  }))

  // 用 raw SQL 補上 communityId / communityName（欄位由 raw SQL 管理，不在 Prisma schema）
  let propertiesWithCommunity = properties
  try {
    const communityRows = await prisma.$queryRawUnsafe(
      `SELECT p.id, p."communityId", c.name as "communityName"
       FROM properties p
       LEFT JOIN communities c ON c.id = p."communityId"
       WHERE p."deletedAt" IS NULL`
    )
    const communityMap = {}
    communityRows.forEach(r => { communityMap[r.id] = { communityId: r.communityId, communityName: r.communityName } })
    propertiesWithCommunity = properties.map(p => ({ ...p, ...( communityMap[p.id] || {}) }))
  } catch (e) {
    // communities 資料表尚未建立時忽略，不影響其他功能
  }

  let selfLandlord = null
  if (auth.role === 'landlord') {
    try {
      selfLandlord = await prisma.landlord.findUnique({
        where: { id: auth.landlordId },
        select: { id: true, botTextConfig: true, botEnabled: true, features: true, siteName: true, siteLogo: true }
      })
    } catch (e) { console.error('selfLandlord 查詢失敗:', e.message) }
  }

  res.json({
    tenants, bookings, repairs, properties: propertiesWithCommunity,
    landlords: safeLandlords, selfLandlord,
    account: auth.label, role: auth.role,
    landlordId: auth.landlordId || null,
    siteUrl: process.env.SITE_URL || 'https://xiaowo-rental.vercel.app'
  })
})

module.exports = router
