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
          select: { id: true, name: true, email: true, phone: true, adminKey: true, isActive: true, createdAt: true, lineBotName: true, lineChannelSecret: true, lineChannelToken: true, richMenuConfig: true, richMenuId: true, richMenuEnabled: true, siteName: true, siteLogo: true, botTextConfig: true, botEnabled: true }
        })
      : Promise.resolve([]),
  ])

  const safeLandlords = landlords.map(l => ({
    id: l.id, name: l.name, email: l.email, phone: l.phone,
    adminKey: l.adminKey, isActive: l.isActive, createdAt: l.createdAt,
    lineBotName: l.lineBotName,
    botConfigured: !!(l.lineChannelSecret && l.lineChannelToken),
    richMenuConfig: l.richMenuConfig || null,
    hasRichMenu: !!l.richMenuId,
    richMenuEnabled: !!l.richMenuEnabled,
    siteName: l.siteName || null,
    siteLogo: l.siteLogo || null,
    botTextConfig: l.botTextConfig || null,
    botEnabled: l.botEnabled !== false,
  }))

  let selfLandlord = null
  if (auth.role === 'landlord') {
    try {
      selfLandlord = await prisma.landlord.findUnique({
        where: { id: auth.landlordId },
        select: { id: true, botTextConfig: true, botEnabled: true }
      })
    } catch (e) { console.error('selfLandlord 查詢失敗:', e.message) }
  }

  res.json({
    tenants, bookings, repairs, properties,
    landlords: safeLandlords, selfLandlord,
    account: auth.label, role: auth.role,
    landlordId: auth.landlordId || null,
    siteUrl: process.env.SITE_URL || 'https://xiaowo-rental.vercel.app'
  })
})

module.exports = router
