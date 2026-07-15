// src/admin/routes/data.js — GET /admin/api/data
const express = require('express')
const router = express.Router()
const prisma = require('../../db')
const { resolveRole, landlordFilter } = require('../helpers')

// property_view_stats 建表只在程序啟動後第一次需要時執行一次，
// 不要每個請求都跑 DDL（DDL 對 Supabase-Tokyo 可能上鎖、拖慢載入）。
let _viewStatsEnsured = false

// 社區名稱（communityId/communityName 由 raw SQL 管理，不在 Prisma schema）
async function fetchCommunityMap() {
  try {
    const rows = await prisma.$queryRawUnsafe(
      `SELECT p.id, p."communityId", c.name as "communityName"
       FROM properties p
       LEFT JOIN communities c ON c.id = p."communityId"
       WHERE p."deletedAt" IS NULL`
    )
    const map = {}
    rows.forEach(r => { map[r.id] = { communityId: r.communityId, communityName: r.communityName } })
    return map
  } catch (e) { return {} } // communities 資料表尚未建立時忽略
}

// availableFrom（不放進 Prisma schema，避免正式 DB 尚未補欄位時拖垮整站）
async function fetchReleaseMap() {
  try {
    const rows = await prisma.$queryRawUnsafe(
      `SELECT id, "availableFrom" FROM properties WHERE "deletedAt" IS NULL`
    )
    const map = {}
    rows.forEach(r => { map[r.id] = r.availableFrom })
    return map
  } catch (e) { return {} } // availableFrom 欄位尚未建立時忽略
}

// 房源每日瀏覽統計：今日 / 7日 / 30日
async function fetchTrafficMap() {
  try {
    if (!_viewStatsEnsured) {
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
      _viewStatsEnsured = true
    }
    const rows = await prisma.$queryRawUnsafe(`
      WITH today AS (SELECT (now() AT TIME ZONE 'Asia/Taipei')::date AS d)
      SELECT
        s."propertyId",
        COALESCE(SUM(CASE WHEN s."date" = today.d THEN s."count" ELSE 0 END), 0)::int AS "viewsToday",
        COALESCE(SUM(CASE WHEN s."date" >= today.d - INTERVAL '6 days' THEN s."count" ELSE 0 END), 0)::int AS "views7d",
        COALESCE(SUM(CASE WHEN s."date" >= today.d - INTERVAL '29 days' THEN s."count" ELSE 0 END), 0)::int AS "views30d"
      FROM property_view_stats s, today
      GROUP BY s."propertyId"
    `)
    const map = {}
    rows.forEach(r => {
      map[r.propertyId] = {
        viewsToday: Number(r.viewsToday || 0),
        views7d: Number(r.views7d || 0),
        views30d: Number(r.views30d || 0),
      }
    })
    return map
  } catch (e) { return {} }
}

router.get('/admin/api/data', async (req, res) => {
  const auth = await resolveRole(req.query.key)
  if (!auth) return res.status(401).json({ error: 'unauthorized' })

  const f = landlordFilter(auth)

  // 全部查詢一次平行發出（原本社區 / 釋出日期 / 瀏覽統計 / 房東自身是序列等待，改為並行）
  const [tenants, bookings, repairs, properties, landlords, communityMap, releaseMap, trafficMap, selfLandlord] = await Promise.all([
    prisma.tenant.findMany({
      where: f,
      include: { property: true, landlord: { select: { name: true, siteName: true } } },
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
      // 列表只需封面圖；完整 images/tags/amenities 改由編輯時 GET /admin/api/property/:id 取得
      include: {
        images: { orderBy: [{ isCover: 'desc' }, { order: 'asc' }], take: 1, select: { url: true } },
        owner: { select: { name: true } },
      },
      orderBy: { createdAt: 'desc' }
    }),
    auth.role === 'super'
      ? prisma.landlord.findMany({
          orderBy: { createdAt: 'desc' },
          select: { id: true, name: true, email: true, phone: true, adminKeyHash: true, isActive: true, createdAt: true, lineBotName: true, lineChannelSecret: true, lineChannelToken: true, lineOfficialId: true, notifyLineUserId: true, richMenuConfig: true, richMenuId: true, richMenuEnabled: true, siteName: true, siteLogo: true, botTextConfig: true, botEnabled: true, features: true }
        })
      : Promise.resolve([]),
    fetchCommunityMap(),
    fetchReleaseMap(),
    fetchTrafficMap(),
    auth.role === 'landlord'
      ? prisma.landlord.findUnique({
          where: { id: auth.landlordId },
          select: { id: true, botTextConfig: true, botEnabled: true, features: true, siteName: true, siteLogo: true }
        }).catch(e => { console.error('selfLandlord 查詢失敗:', e.message); return null })
      : Promise.resolve(null),
  ])

  const safeLandlords = landlords.map(l => ({
    id: l.id, name: l.name, email: l.email, phone: l.phone,
    adminKey: null, adminKeyAvailable: !!l.adminKeyHash, isActive: l.isActive, createdAt: l.createdAt,
    lineBotName: l.lineBotName,
    lineOfficialId: l.lineOfficialId || null,
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

  // 把社區 / 釋出日期 / 瀏覽統計一次併進房源（資料皆已平行取回）
  const propertiesWithCommunity = properties.map(p => {
    const t = trafficMap[p.id] || {}
    return {
      ...p,
      ...(communityMap[p.id] || {}),
      availableFrom: releaseMap[p.id] || null,
      viewsToday: t.viewsToday || 0,
      views7d: t.views7d || 0,
      views30d: t.views30d || 0,
    }
  })

  res.json({
    tenants, bookings, repairs, properties: propertiesWithCommunity,
    landlords: safeLandlords, selfLandlord,
    account: auth.label, role: auth.role,
    landlordId: auth.landlordId || null,
    siteUrl: process.env.SITE_URL || 'https://xiaowo-rental.vercel.app'
  })
})

module.exports = router
