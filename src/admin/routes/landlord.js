// src/admin/routes/landlord.js
const express = require('express')
const router = express.Router()
const crypto = require('crypto')
const prisma = require('../../db')
const { resolveRole, deleteCloudinaryImages, revalidateSite, hashAdminKey } = require('../helpers')

// 列出所有房東（僅超級管理員）
router.get('/admin/api/landlords', async (req, res) => {
  const auth = await resolveRole(req.query.key)
  if (!auth || auth.role !== 'super') return res.status(401).json({ error: 'unauthorized' })
  const landlords = await prisma.landlord.findMany({ orderBy: { createdAt: 'desc' } })
  res.json(landlords)
})

// 新增房東
router.post('/admin/api/landlord', express.json(), async (req, res) => {
  const auth = await resolveRole(req.query.key)
  if (!auth || auth.role !== 'super') return res.status(401).json({ error: 'unauthorized' })

  const { name, email, phone } = req.body
  if (!name || !email) return res.status(400).json({ error: 'name 和 email 為必填' })

  const adminKey = 'LL-' + crypto.randomBytes(9).toString('base64url')
  const tempPassword = crypto.randomBytes(6).toString('base64url')
  const passwordHash = crypto.createHash('sha256').update(tempPassword).digest('hex')

  try {
    const landlord = await prisma.landlord.create({
      data: { name, email, phone: phone || null, adminKey: null, adminKeyHash: hashAdminKey(adminKey), passwordHash }
    })
    res.json({ ...landlord, _adminKey: adminKey, _tempPassword: tempPassword })
  } catch (e) {
    if (e.code === 'P2002') return res.status(400).json({ error: 'email 已存在' })
    res.status(500).json({ error: e.message })
  }
})

// 編輯房東基本資料
router.post('/admin/api/landlord/:id', express.json(), async (req, res) => {
  const auth = await resolveRole(req.query.key)
  if (!auth || auth.role !== 'super') return res.status(401).json({ error: 'unauthorized' })

  const { name, email, phone, isActive, lineOfficialId } = req.body
  const data = {}
  if (name !== undefined) {
    if (!name.trim()) return res.status(400).json({ error: '房東名稱不可空白' })
    data.name = name.trim()
  }
  if (email !== undefined) {
    if (!email.trim()) return res.status(400).json({ error: 'Email 不可空白' })
    data.email = email.trim().toLowerCase()
  }
  if (phone !== undefined) data.phone = phone.trim() || null
  if (isActive !== undefined) data.isActive = isActive
  if (lineOfficialId !== undefined) {
    const v = String(lineOfficialId || '').trim()
    if (v && !v.startsWith('@')) return res.status(400).json({ error: 'LINE 官方帳號 ID 請以 @ 開頭，例如 @xiaowo' })
    data.lineOfficialId = v || null
  }

  try {
    const landlord = await prisma.landlord.update({ where: { id: req.params.id }, data })
    res.json(landlord)
  } catch (e) {
    if (e.code === 'P2002') return res.status(400).json({ error: 'Email 已被其他房東使用' })
    res.status(500).json({ error: e.message })
  }
})

// 重新產生房東金鑰
router.post('/admin/api/landlord/:id/regenerate-key', express.json(), async (req, res) => {
  const auth = await resolveRole(req.query.key)
  if (!auth || auth.role !== 'super') return res.status(401).json({ error: 'unauthorized' })

  const adminKey = 'LL-' + crypto.randomBytes(9).toString('base64url')
  const landlord = await prisma.landlord.update({
    where: { id: req.params.id },
    data: { adminKey: null, adminKeyHash: hashAdminKey(adminKey) }
  })
  res.json({ ...landlord, _adminKey: adminKey })
})

// 設定 LINE Bot（Channel Secret / Token）
router.post('/admin/api/landlord/:id/bot', express.json(), async (req, res) => {
  const auth = await resolveRole(req.query.key)
  if (!auth || auth.role !== 'super') return res.status(401).json({ error: 'unauthorized' })

  const { lineChannelSecret, lineChannelToken, lineBotName, notifyLineUserId } = req.body
  let lineOfficialId = null
  if (lineChannelToken) {
    try {
      const botInfoRes = await fetch('https://api.line.me/v2/bot/info', {
        headers: { Authorization: `Bearer ${lineChannelToken}` }
      })
      if (botInfoRes.ok) {
        const botInfo = await botInfoRes.json()
        lineOfficialId = botInfo.premiumId || botInfo.basicId || null
      }
    } catch (e) {
      console.error('取得 LINE 官方帳號 ID 失敗:', e.message)
    }
  }

  const data = {
    lineBotName: lineBotName || null,
    notifyLineUserId: notifyLineUserId || null,
  }
  if (lineChannelSecret) data.lineChannelSecret = lineChannelSecret
  if (lineChannelToken) data.lineChannelToken = lineChannelToken
  if (lineOfficialId) data.lineOfficialId = lineOfficialId

  const landlord = await prisma.landlord.update({
    where: { id: req.params.id },
    data
  })

  try {
    const { clearConfigCache } = require('../../landlordWebhook')
    clearConfigCache(req.params.id)
  } catch (e) {}

  res.json({ ok: true, id: landlord.id })
})

// ── Rich Menu ────────────────────────────────────────────────────

router.post('/admin/api/landlord/:id/richmenu', express.json(), async (req, res) => {
  const auth = await resolveRole(req.query.key)
  if (!auth) return res.status(401).json({ error: 'unauthorized' })
  if (auth.role === 'landlord' && auth.landlordId !== req.params.id) {
    return res.status(403).json({ error: 'forbidden' })
  }

  const { template, cells, chatBarText } = req.body
  const config = JSON.stringify({ template, cells, chatBarText: chatBarText || '選單' })
  await prisma.landlord.update({ where: { id: req.params.id }, data: { richMenuConfig: config } })
  res.json({ ok: true })
})

router.post('/admin/api/landlord/:id/richmenu/preview', express.json(), async (req, res) => {
  const auth = await resolveRole(req.query.key)
  if (!auth) return res.status(401).json({ error: 'unauthorized' })

  try {
    const { previewRichMenu } = require('../../richMenu')
    const { template, cells } = req.body
    const png = await previewRichMenu(template, cells)
    res.set('Content-Type', 'image/png')
    res.send(png)
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

router.post('/admin/api/landlord/:id/richmenu/apply', express.json(), async (req, res) => {
  const auth = await resolveRole(req.query.key)
  if (!auth) return res.status(401).json({ error: 'unauthorized' })
  if (auth.role === 'landlord' && auth.landlordId !== req.params.id) {
    return res.status(403).json({ error: 'forbidden' })
  }

  try {
    const { applyRichMenu } = require('../../richMenu')
    const result = await applyRichMenu(req.params.id)
    res.json({ ok: true, richMenuId: result.richMenuId })
  } catch (e) {
    console.error('套用選單失敗:', e.message)
    res.status(500).json({ error: e.message })
  }
})

router.post('/admin/api/landlord/:id/richmenu/toggle', express.json(), async (req, res) => {
  const auth = await resolveRole(req.query.key)
  if (!auth) return res.status(401).json({ error: 'unauthorized' })
  if (auth.role === 'landlord' && auth.landlordId !== req.params.id) {
    return res.status(403).json({ error: 'forbidden' })
  }

  try {
    const { enableRichMenu, disableRichMenu } = require('../../richMenu')
    if (req.body.enabled) {
      await enableRichMenu(req.params.id)
    } else {
      await disableRichMenu(req.params.id)
    }
    res.json({ ok: true, enabled: !!req.body.enabled })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

// ── 官網設定 ─────────────────────────────────────────────────────

router.post('/admin/api/landlord/:id/site', express.json(), async (req, res) => {
  const auth = await resolveRole(req.query.key)
  if (!auth) return res.status(401).json({ error: 'unauthorized' })
  if (auth.role === 'landlord' && auth.landlordId !== req.params.id) {
    return res.status(403).json({ error: 'forbidden' })
  }

  const { siteName, siteLogo, siteSlides } = req.body
  const data = {}
  if (siteName !== undefined) data.siteName = siteName || null
  if (siteLogo !== undefined) data.siteLogo = siteLogo || null

  // siteSlides stored inside features JSON to avoid schema change
  if (siteSlides !== undefined) {
    const current = await prisma.landlord.findUnique({ where: { id: req.params.id }, select: { features: true } })
    let feats = {}
    try { feats = current?.features ? JSON.parse(current.features) : {} } catch (_) {}
    feats.siteSlides = Array.isArray(siteSlides) ? siteSlides : []
    data.features = JSON.stringify(feats)
  }

  try {
    await prisma.landlord.update({ where: { id: req.params.id }, data })
    res.json({ ok: true })
  } catch (e) {
    console.error('[site] update error:', e.message)
    res.status(500).json({ error: e.message })
  }
})

// ── Bot 開關 / 文字設定 ──────────────────────────────────────────

router.post('/admin/api/landlord/:id/bot-toggle', express.json(), async (req, res) => {
  const auth = await resolveRole(req.query.key)
  if (!auth) return res.status(401).json({ error: 'unauthorized' })
  if (auth.role === 'landlord' && auth.landlordId !== req.params.id) {
    return res.status(403).json({ error: 'forbidden' })
  }

  await prisma.landlord.update({ where: { id: req.params.id }, data: { botEnabled: !!req.body.enabled } })
  try { require('../../botText').clearTextCache(req.params.id) } catch (e) {}
  try { require('../../landlordWebhook').clearConfigCache(req.params.id) } catch (e) {}
  res.json({ ok: true, enabled: !!req.body.enabled })
})

router.post('/admin/api/landlord/:id/bot-autoreply', express.json(), async (req, res) => {
  const auth = await resolveRole(req.query.key)
  if (!auth) return res.status(401).json({ error: 'unauthorized' })
  if (auth.role === 'landlord' && auth.landlordId !== req.params.id) {
    return res.status(403).json({ error: 'forbidden' })
  }
  try {
    const row = await prisma.landlord.findUnique({ where: { id: req.params.id }, select: { features: true } })
    let feats = {}
    try { feats = row?.features ? JSON.parse(row.features) : {} } catch (_) {}
    feats.autoReply = !!req.body.autoReply
    await prisma.landlord.update({ where: { id: req.params.id }, data: { features: JSON.stringify(feats) } })
    try { require('../../landlordWebhook').clearConfigCache(req.params.id) } catch (e) {}
    res.json({ ok: true, autoReply: feats.autoReply })
  } catch (e) { res.status(500).json({ error: e.message }) }
})

router.post('/admin/api/landlord/:id/bottext', express.json(), async (req, res) => {
  const auth = await resolveRole(req.query.key)
  if (!auth) return res.status(401).json({ error: 'unauthorized' })
  if (auth.role === 'landlord' && auth.landlordId !== req.params.id) {
    return res.status(403).json({ error: 'forbidden' })
  }

  const { botTextConfig, botEnabled } = req.body
  const data = {}
  if (botTextConfig !== undefined) data.botTextConfig = botTextConfig
  if (botEnabled !== undefined) data.botEnabled = !!botEnabled

  await prisma.landlord.update({ where: { id: req.params.id }, data })
  try { require('../../botText').clearTextCache(req.params.id) } catch (e) {}
  try { require('../../landlordWebhook').clearConfigCache(req.params.id) } catch (e) {}
  res.json({ ok: true })
})

// 完全刪除房東 + 名下所有房源（含照片、預約、評論、維修等關聯）— 僅超級管理員
// ⚠️ 不可復原。Booking/Repair/Review 對 Property 是 Restrict，需先刪子資料再刪房源。
router.delete('/admin/api/landlord/:id', async (req, res) => {
  const auth = await resolveRole(req.query.key)
  if (!auth || auth.role !== 'super') return res.status(401).json({ error: 'unauthorized' })

  const id = req.params.id
  const landlord = await prisma.landlord.findUnique({ where: { id } })
  if (!landlord) return res.status(404).json({ error: '找不到房東' })

  try {
    // 名下所有房源（含已軟刪除的）
    const props = await prisma.property.findMany({ where: { ownerId: id }, select: { id: true } })
    const propIds = props.map(p => p.id)

    // 先收集 Cloudinary 圖片網址（DB 刪掉後就查不到）
    let imageUrls = []
    if (propIds.length) {
      const imgs = await prisma.propertyImage.findMany({ where: { propertyId: { in: propIds } }, select: { url: true } })
      imageUrls = imgs.map(i => i.url)
    }

    // 交易內依相依順序刪除
    await prisma.$transaction([
      ...(propIds.length ? [
        prisma.booking.deleteMany({ where: { propertyId: { in: propIds } } }),
        prisma.repair.deleteMany({ where: { propertyId: { in: propIds } } }),
        prisma.review.deleteMany({ where: { propertyId: { in: propIds } } }),
        prisma.message.deleteMany({ where: { propertyId: { in: propIds } } }),
        prisma.favorite.deleteMany({ where: { propertyId: { in: propIds } } }),
        prisma.propertyTag.deleteMany({ where: { propertyId: { in: propIds } } }),
        prisma.propertyAmenity.deleteMany({ where: { propertyId: { in: propIds } } }),
        prisma.propertyImage.deleteMany({ where: { propertyId: { in: propIds } } }),
        prisma.property.deleteMany({ where: { id: { in: propIds } } }),
      ] : []),
      // 刪房東（managed_properties → leases/records/payouts 由 DB ON DELETE CASCADE 連帶刪除）
      prisma.landlord.delete({ where: { id } }),
    ])

    // DB 一致後再清 Cloudinary（失敗只是殘留圖片，不影響資料）
    if (imageUrls.length) { try { await deleteCloudinaryImages(imageUrls) } catch (e) {} }
    try { await revalidateSite(['/listings', `/site/${id}`]) } catch (e) {}

    res.json({ ok: true, deletedProperties: propIds.length })
  } catch (e) {
    console.error('刪除房東失敗:', e.message)
    res.status(500).json({ error: e.message })
  }
})

module.exports = router
