// src/admin/routes/property.js
const express = require('express')
const router = express.Router()
const prisma = require('../../db')
const { resolveRole, revalidateSite, deleteCloudinaryImages } = require('../helpers')

// 共用：從 req.body 取出費用、電費、標籤欄位
function extractFeeFields(body) {
  const data = {}
  if (body.mgmtFee     !== undefined) data.mgmtFee     = parseInt(body.mgmtFee)     || 0
  if (body.cleaningFee !== undefined) data.cleaningFee = parseInt(body.cleaningFee) || 0
  if (body.electricType !== undefined) data.electricType = body.electricType || null
  if (body.electricRate !== undefined) data.electricRate = body.electricRate != null ? parseFloat(body.electricRate) : null
  if (body.electricFlat !== undefined) data.electricFlat = body.electricFlat != null ? parseInt(body.electricFlat) : null
  return data
}

// 共用：更新標籤（先全刪再寫入）
async function syncTags(propertyId, tags) {
  if (!Array.isArray(tags)) return
  await prisma.propertyTag.deleteMany({ where: { propertyId } })
  if (tags.length) {
    await prisma.propertyTag.createMany({
      data: tags.map(name => ({ propertyId, name })),
      skipDuplicates: true,
    })
  }
}

// 共用：更新設備（先全刪再寫入）
async function syncAmenities(propertyId, amenities) {
  if (!Array.isArray(amenities)) return
  await prisma.propertyAmenity.deleteMany({ where: { propertyId } })
  if (amenities.length) {
    await prisma.propertyAmenity.createMany({
      data: amenities.map(name => ({ propertyId, name })),
      skipDuplicates: true,
    })
  }
}

router.post('/admin/api/property', express.json(), async (req, res) => {
  const auth = await resolveRole(req.query.key)
  if (!auth) return res.status(401).json({ error: 'unauthorized' })

  const { title, type, city, district, address, size, price, deposit, description, imageUrls, status, ownerId, tags, amenities } = req.body
  if (!title || !price) return res.status(400).json({ error: 'title 和 price 為必填' })

  const targetOwnerId = auth.role === 'landlord' ? auth.landlordId : (ownerId || null)
  if (!targetOwnerId) return res.status(400).json({ error: '請指定房東' })

  const landlordUser = await prisma.user.upsert({
    where: { email: 'admin@xiaowo.tw' },
    update: {},
    create: { email: 'admin@xiaowo.tw', name: '小蝸出租', handle: 'xiaowo', role: 'LANDLORD', verified: true }
  })

  const property = await prisma.property.create({
    data: {
      landlordId: landlordUser.id,
      ownerId: targetOwnerId,
      title,
      type: type || 'SUITE',
      status: status || 'AVAILABLE',
      city: city || '台中市',
      district: district || '',
      address: address || '',
      size: parseFloat(size) || 0,
      price: parseInt(price),
      deposit: deposit || '兩個月',
      description: description || '',
      ...extractFeeFields(req.body),
      images: { create: (imageUrls || []).map((url, i) => ({ url, order: i, isCover: i === 0 })) }
    }
  })

  // communityId 不在 Prisma schema，用 raw SQL 單獨更新
  if (req.body.communityId !== undefined) {
    await prisma.$queryRawUnsafe(
      `UPDATE properties SET "communityId"=$1 WHERE id=$2`,
      req.body.communityId || null, property.id
    ).catch(() => {})
  }

  await syncTags(property.id, tags)
  await syncAmenities(property.id, amenities)
  await revalidateSite(['/listings', `/site/${targetOwnerId}`, `/property/${property.id}`])
  res.json(property)
})

router.post('/admin/api/property/:id', express.json(), async (req, res) => {
  const auth = await resolveRole(req.query.key)
  if (!auth) return res.status(401).json({ error: 'unauthorized' })

  const existing = await prisma.property.findUnique({ where: { id: req.params.id } })
  if (!existing) return res.status(404).json({ error: 'not found' })
  if (auth.role === 'landlord' && existing.ownerId !== auth.landlordId) {
    return res.status(403).json({ error: 'forbidden' })
  }

  const { title, type, city, district, address, size, price, deposit, description, imageUrls, status, tags, amenities } = req.body
  const data = { ...extractFeeFields(req.body) }
  if (title       !== undefined) data.title       = title
  if (type        !== undefined) data.type        = type
  if (status      !== undefined) data.status      = status
  if (city        !== undefined) data.city        = city
  if (district    !== undefined) data.district    = district
  if (address     !== undefined) data.address     = address
  if (size        !== undefined) data.size        = parseFloat(size) || 0
  if (price       !== undefined) data.price       = parseInt(price)
  if (deposit     !== undefined) data.deposit     = deposit
  if (description !== undefined) data.description = description
  // communityId 不在 Prisma schema，從 data 移除，用 raw SQL 單獨更新
  const communityIdValue = req.body.communityId

  console.log('[property update] data:', JSON.stringify(data))
  const property = await prisma.property.update({ where: { id: req.params.id }, data })

  if (communityIdValue !== undefined) {
    await prisma.$queryRawUnsafe(
      `UPDATE properties SET "communityId"=$1 WHERE id=$2`,
      communityIdValue || null, req.params.id
    ).catch(() => {})
  }
  console.log('[property update] result mgmtFee:', property.mgmtFee, 'electricType:', property.electricType, 'electricRate:', property.electricRate, 'cleaningFee:', property.cleaningFee)

  if (Array.isArray(imageUrls)) {
    const oldImages = await prisma.propertyImage.findMany({ where: { propertyId: req.params.id }, select: { url: true } })
    const oldUrls = oldImages.map(i => i.url)
    const newSet = new Set(imageUrls)
    const toDelete = oldUrls.filter(u => !newSet.has(u))
    await prisma.propertyImage.deleteMany({ where: { propertyId: req.params.id } })
    if (imageUrls.length) {
      await prisma.propertyImage.createMany({
        data: imageUrls.map((url, i) => ({ propertyId: req.params.id, url, order: i, isCover: i === 0 }))
      })
    }
    await deleteCloudinaryImages(toDelete)
  }

  await syncTags(req.params.id, tags)
  await syncAmenities(req.params.id, amenities)
  await revalidateSite(['/listings', `/site/${existing.ownerId}`, `/property/${req.params.id}`])
  res.json(property)
})

router.post('/admin/api/property/:id/featured', express.json(), async (req, res) => {
  const auth = await resolveRole(req.query.key)
  if (!auth) return res.status(401).json({ error: 'unauthorized' })
  const { featured } = req.body

  // 房東只能改自己房源的「官網精選(siteFeatured)」；總管理員改「主站精選(featured)」
  if (auth.role !== 'super') {
    const existing = await prisma.property.findUnique({
      where: { id: req.params.id },
      select: { ownerId: true },
    })
    if (!existing || existing.ownerId !== auth.landlordId) {
      return res.status(403).json({ error: 'forbidden' })
    }
  }
  const data = auth.role === 'super' ? { featured: !!featured } : { siteFeatured: !!featured }

  const property = await prisma.property.update({
    where: { id: req.params.id },
    data,
    select: { id: true, featured: true, siteFeatured: true, ownerId: true },
  })

  // 立即回應，前台快取清除在背景進行（不讓使用者等待外部網路請求）
  res.json(property)

  if (auth.role === 'super') {
    revalidateSite(['/'], ['featured-properties']).catch(() => {})
  } else if (property.ownerId) {
    revalidateSite([`/site/${property.ownerId}`]).catch(() => {})
  }
})

router.post('/admin/api/property/:id/delete', express.json(), async (req, res) => {
  const auth = await resolveRole(req.query.key)
  if (!auth) return res.status(401).json({ error: 'unauthorized' })

  const existing = await prisma.property.findUnique({
    where: { id: req.params.id },
    include: { images: { select: { url: true } } }
  })
  if (!existing) return res.status(404).json({ error: 'not found' })
  if (auth.role === 'landlord' && existing.ownerId !== auth.landlordId) {
    return res.status(403).json({ error: 'forbidden' })
  }

  const property = await prisma.property.update({
    where: { id: req.params.id },
    data: { deletedAt: new Date(), status: 'PAUSED' }
  })
  await deleteCloudinaryImages(existing.images.map(i => i.url))
  await revalidateSite(['/listings', `/site/${existing.ownerId}`, `/property/${req.params.id}`])
  res.json(property)
})

module.exports = router
