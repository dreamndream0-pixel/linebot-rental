// src/admin/routes/data.js — GET /admin/api/data
const express = require('express')
const router = express.Router()
const prisma = require('../../db')
const { resolveRole, landlordFilter } = require('../helpers')

router.get('/admin/api/data', async (req, res) => {
  const auth = await resolveRole(req.query.key)
  if (!auth) return res.status(401).json({ error: 'unauthorized' })

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

  // availableFrom 不放進 Prisma schema，避免正式 DB 尚未補欄位時拖垮整站。
  try {
    const releaseRows = await prisma.$queryRawUnsafe(
      `SELECT id, "availableFrom" FROM properties WHERE "deletedAt" IS NULL`
    )
    const releaseMap = {}
    releaseRows.forEach(r => { releaseMap[r.id] = r.availableFrom })
    propertiesWithCommunity = propertiesWithCommunity.map(p => ({ ...p, availableFrom: releaseMap[p.id] || null }))
  } catch (e) {
    // availableFrom 欄位尚未建立時忽略；狀態仍可正常管理。
  }

  // 房源每日瀏覽統計：今日 / 7日 / 30日，若資料表尚未建立則自動建立。
  try {
    await prisma.$executeRawUnsafe(`
      CREATE TABLE IF NOT EXISTS property_view_stats (
        "propertyId" TEXT NOT NULL,
        "date" DATE NOT NULL,
        "count" INTEGER NOT NULL DEFAULT 0,
        "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
        "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
        PRIMARY KEY ("propertyId", "date")
      )
    `)
    const trafficRows = await prisma.$queryRawUnsafe(`
      WITH today AS (SELECT (now() AT TIME ZONE 'Asia/Taipei')::date AS d)
      SELECT
        s."propertyId",
        COALESCE(SUM(CASE WHEN s."date" = today.d THEN s."count" ELSE 0 END), 0)::int AS "viewsToday",
        COALESCE(SUM(CASE WHEN s."date" >= today.d - INTERVAL '6 days' THEN s."count" ELSE 0 END), 0)::int AS "views7d",
        COALESCE(SUM(CASE WHEN s."date" >= today.d - INTERVAL '29 days' THEN s."count" ELSE 0 END), 0)::int AS "views30d"
      FROM property_view_stats s, today
      GROUP BY s."propertyId"
    `)
    const trafficMap = {}
    trafficRows.forEach(r => {
      trafficMap[r.propertyId] = {
        viewsToday: Number(r.viewsToday || 0),
        views7d: Number(r.views7d || 0),
        views30d: Number(r.views30d || 0),
      }
    })
    propertiesWithCommunity = propertiesWithCommunity.map(p => ({
      ...p,
      viewsToday: trafficMap[p.id]?.viewsToday || 0,
      views7d: trafficMap[p.id]?.views7d || 0,
      views30d: trafficMap[p.id]?.views30d || 0,
    }))
  } catch (e) {
    propertiesWithCommunity = propertiesWithCommunity.map(p => ({
      ...p,
      viewsToday: 0,
      views7d: 0,
      views30d: 0,
    }))
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
