// src/admin/routes/landlord.js
const express = require('express')
const router = express.Router()
const crypto = require('crypto')
const prisma = require('../../db')
const { resolveRole } = require('../helpers')

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
      data: { name, email, phone: phone || null, adminKey, passwordHash }
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

  const { name, email, phone, isActive } = req.body
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
  const landlord = await prisma.landlord.update({ where: { id: req.params.id }, data: { adminKey } })
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

module.exports = router
