const express = require('express')
const { Client } = require('@line/bot-sdk')
const prisma = require('./db')

const router = express.Router()

// ── Cloudinary 圖片上傳設定 ──────────────────────────────────────
const cloudinary = require('cloudinary').v2
const multer = require('multer')
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
})
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } })

// 不再提供預設密碼：沒設定環境變數就拒絕所有登入
const ADMIN_KEY = process.env.ADMIN_KEY

async function revalidateSite(paths) {
  const siteUrl = process.env.SITE_URL
  const secret = process.env.REVALIDATE_SECRET
  if (!siteUrl || !secret) return
  try {
    await fetch(`${siteUrl}/api/revalidate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ secret, paths }),
    })
  } catch (_) {}
}

// 從 Cloudinary URL 取出 public_id（含資料夾路徑）
function cloudinaryPublicId(url) {
  try {
    const u = new URL(url)
    // 路徑格式: /image/upload/v123456/folder/filename.ext
    const parts = u.pathname.split('/')
    const uploadIdx = parts.indexOf('upload')
    if (uploadIdx === -1) return null
    // 跳過 upload 和版本號（v...）
    const afterUpload = parts.slice(uploadIdx + 1)
    if (afterUpload[0]?.startsWith('v')) afterUpload.shift()
    const withExt = afterUpload.join('/')
    return withExt.replace(/\.[^.]+$/, '') // 去副檔名
  } catch { return null }
}

async function deleteCloudinaryImages(urls = []) {
  const ids = urls.map(cloudinaryPublicId).filter(Boolean)
  if (!ids.length) return
  try {
    await cloudinary.api.delete_resources(ids)
  } catch (e) {
    console.error('Cloudinary 刪除失敗:', e.message)
  }
}

// ── 權限解析（async，支援房東登入） ─────────────────────────────
// 回傳 { role, landlordId, label }
//   role='super'    → 總管理員（你），看全部
//   role='landlord' → 房東，只看自己 landlordId 的資料
async function resolveRole(key) {
  if (!key || !ADMIN_KEY) return null
  if (key === ADMIN_KEY) return { role: 'super', landlordId: null, label: '總管理員' }

  // 查 Landlord 表（用 adminKey 比對）
  try {
    const landlord = await prisma.landlord.findUnique({ where: { adminKey: key } })
    if (landlord && landlord.isActive) {
      return { role: 'landlord', landlordId: landlord.id, label: landlord.name, source: landlord.source }
    }
  } catch (e) {
    console.error('resolveRole 查詢房東失敗:', e.message)
  }
  return null
}

// 房東資料過濾條件
function landlordFilter(auth) {
  return auth.role === 'super' ? {} : { landlordId: auth.landlordId }
}

async function notifyBookingTenant(booking, status) {
  if (!booking.lineUser?.lineUserId) return { notified: false, reason: 'not-line-booking' }

  let config
  const landlordId = booking.landlordId || booking.property?.ownerId
  try {
    if (landlordId) {
      const landlord = await prisma.landlord.findUnique({
        where: { id: landlordId },
        select: { lineChannelToken: true, lineChannelSecret: true }
      })
      if (landlord?.lineChannelToken) {
        config = {
          channelAccessToken: landlord.lineChannelToken,
          channelSecret: landlord.lineChannelSecret || '',
        }
      }
    } else if (process.env.LINE_CHANNEL_ACCESS_TOKEN) {
      config = {
        channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
        channelSecret: process.env.LINE_CHANNEL_SECRET || '',
      }
    }
  } catch (e) {
    console.error('讀取預約通知 Bot 設定失敗:', e.message)
    return { notified: false, reason: 'bot-config-failed' }
  }

  if (!config) return { notified: false, reason: 'bot-not-configured' }

  const date = new Date(booking.date).toLocaleDateString('zh-TW', { timeZone: 'Asia/Taipei' })
  const messages = {
    CONFIRMED: `✅ 看房預約已確認\n\n🏠 ${booking.property.title}\n📅 ${date} ${booking.timeslot}\n\n請準時抵達，如需調整請直接聯絡房東。`,
    CANCELLED: `❌ 看房預約已取消\n\n🏠 ${booking.property.title}\n📅 ${date} ${booking.timeslot}\n\n如需重新預約，請回到選單再次選擇。`,
  }
  if (!messages[status]) return { notified: false, reason: 'status-does-not-notify' }

  try {
    const client = new Client(config)
    await client.pushMessage(booking.lineUser.lineUserId, { type: 'text', text: messages[status] })
    return { notified: true }
  } catch (e) {
    console.error('預約狀態 LINE 通知失敗:', e.message)
    return { notified: false, reason: 'push-failed' }
  }
}

// ── API：取得所有資料（依房東隔離） ────────────────────────────
router.get('/admin/api/data', async (req, res) => {
  const auth = await resolveRole(req.query.key)
  if (!auth) return res.status(401).json({ error: 'unauthorized' })

  const f = landlordFilter(auth)  // {} 或 { landlordId }

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
      include: { images: { orderBy: [{ isCover: 'desc' }, { order: 'asc' }] }, owner: { select: { name: true } } },
      orderBy: { createdAt: 'desc' }
    }),
    // 只有總管理員需要房東清單
    auth.role === 'super'
      ? prisma.landlord.findMany({
          orderBy: { createdAt: 'desc' },
          select: { id: true, name: true, email: true, phone: true, adminKey: true, isActive: true, createdAt: true, lineBotName: true, lineChannelSecret: true, lineChannelToken: true, richMenuConfig: true, richMenuId: true, richMenuEnabled: true, siteName: true, siteLogo: true, botTextConfig: true, botEnabled: true }
        })
      : Promise.resolve([]),
  ])

  // 房東的 Bot 機密不外洩到前端，只標示是否已設定
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

  // 房東用戶需要讀自己的 Bot 設定
  let selfLandlord = null
  if (auth.role === 'landlord') {
    try {
      selfLandlord = await prisma.landlord.findUnique({
        where: { id: auth.landlordId },
        select: { id: true, botTextConfig: true, botEnabled: true }
      })
    } catch (e) { console.error('selfLandlord 查詢失敗:', e.message) }
  }

  res.json({ tenants, bookings, repairs, properties, landlords: safeLandlords, selfLandlord, account: auth.label, role: auth.role, landlordId: auth.landlordId || null, siteUrl: process.env.SITE_URL || 'https://xiaowo-rental.vercel.app' })
})

// 共用：確認某筆資料屬於該 auth（房東只能動自己的）
function ownsRecord(auth, record) {
  if (auth.role === 'super') return true
  return record && record.landlordId === auth.landlordId
}

// ── API：更新預約狀態 ───────────────────────────────────────────
router.post('/admin/api/booking/:id/status', express.json(), async (req, res) => {
  const auth = await resolveRole(req.query.key)
  if (!auth) return res.status(401).json({ error: 'unauthorized' })

  const allowedStatuses = ['CONFIRMED', 'CANCELLED', 'COMPLETED']
  if (!allowedStatuses.includes(req.body.status)) {
    return res.status(400).json({ error: 'invalid status' })
  }

  const existing = await prisma.booking.findUnique({
    where: { id: req.params.id },
    include: { lineUser: true, property: true }
  })
  if (!ownsRecord(auth, existing)) return res.status(403).json({ error: 'forbidden' })

  const booking = await prisma.booking.update({ where: { id: req.params.id }, data: { status: req.body.status } })
  const notification = await notifyBookingTenant(existing, req.body.status)
  res.json({ booking, notification })
})

// ── API：更新維修狀態 ───────────────────────────────────────────
router.post('/admin/api/repair/:id/status', express.json(), async (req, res) => {
  const auth = await resolveRole(req.query.key)
  if (!auth) return res.status(401).json({ error: 'unauthorized' })

  const existing = await prisma.repair.findUnique({ where: { id: req.params.id } })
  if (!ownsRecord(auth, existing)) return res.status(403).json({ error: 'forbidden' })

  const repair = await prisma.repair.update({ where: { id: req.params.id }, data: { status: req.body.status } })
  res.json(repair)
})

// ── API：更新租客備註名稱 ───────────────────────────────────────
router.post('/admin/api/tenant/:id/name', express.json(), async (req, res) => {
  const auth = await resolveRole(req.query.key)
  if (!auth) return res.status(401).json({ error: 'unauthorized' })

  const existing = await prisma.tenant.findUnique({ where: { id: req.params.id } })
  if (!ownsRecord(auth, existing)) return res.status(403).json({ error: 'forbidden' })

  const tenant = await prisma.tenant.update({
    where: { id: req.params.id },
    data: { customName: req.body.customName || null }
  })
  res.json(tenant)
})

// ── API：新增房源（總管理員可指定房東；房東則綁自己） ───────────
router.post('/admin/api/property', express.json(), async (req, res) => {
  const auth = await resolveRole(req.query.key)
  if (!auth) return res.status(401).json({ error: 'unauthorized' })

  const { title, type, city, district, address, size, price, deposit, description, imageUrls, status, ownerId } = req.body
  if (!title || !price) return res.status(400).json({ error: 'title 和 price 為必填' })

  // 決定歸屬房東：房東登入→自己；總管理員→表單指定的 ownerId
  const targetOwnerId = auth.role === 'landlord' ? auth.landlordId : (ownerId || null)
  if (!targetOwnerId) return res.status(400).json({ error: '請指定房東' })

  // Property.landlordId 指向 User 表（網站相容），這裡沿用既有預設房東 User
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
      images: { create: (imageUrls || []).map((url, i) => ({ url, order: i, isCover: i === 0 })) }
    }
  })
  await revalidateSite(['/listings', `/site/${targetOwnerId}`, `/property/${property.id}`])
  res.json(property)
})

// ── API：編輯房源 ───────────────────────────────────────────────
router.post('/admin/api/property/:id', express.json(), async (req, res) => {
  const auth = await resolveRole(req.query.key)
  if (!auth) return res.status(401).json({ error: 'unauthorized' })

  const existing = await prisma.property.findUnique({ where: { id: req.params.id } })
  if (!existing) return res.status(404).json({ error: 'not found' })
  if (auth.role === 'landlord' && existing.ownerId !== auth.landlordId) {
    return res.status(403).json({ error: 'forbidden' })
  }

  const { title, type, city, district, address, size, price, deposit, description, imageUrls, status } = req.body
  const data = {}
  if (title !== undefined) data.title = title
  if (type !== undefined) data.type = type
  if (status !== undefined) data.status = status
  if (city !== undefined) data.city = city
  if (district !== undefined) data.district = district
  if (address !== undefined) data.address = address
  if (size !== undefined) data.size = parseFloat(size) || 0
  if (price !== undefined) data.price = parseInt(price)
  if (deposit !== undefined) data.deposit = deposit
  if (description !== undefined) data.description = description

  const property = await prisma.property.update({ where: { id: req.params.id }, data })

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
  await revalidateSite(['/listings', `/site/${existing.ownerId}`, `/property/${req.params.id}`])
  res.json(property)
})

// ── API：刪除房源（軟刪除） ─────────────────────────────────────
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

// ── API：房東管理（僅總管理員） ─────────────────────────────────
const crypto = require('crypto')

router.get('/admin/api/landlords', async (req, res) => {
  const auth = await resolveRole(req.query.key)
  if (!auth || auth.role !== 'super') return res.status(401).json({ error: 'unauthorized' })
  const landlords = await prisma.landlord.findMany({ orderBy: { createdAt: 'desc' } })
  res.json(landlords)
})

router.post('/admin/api/landlord', express.json(), async (req, res) => {
  const auth = await resolveRole(req.query.key)
  if (!auth || auth.role !== 'super') return res.status(401).json({ error: 'unauthorized' })

  const { name, email, phone } = req.body
  if (!name || !email) return res.status(400).json({ error: 'name 和 email 為必填' })

  // 自動產生該房東的後台金鑰（房東用這個登入）
  const adminKey = 'LL-' + crypto.randomBytes(9).toString('base64url')
  const tempPassword = crypto.randomBytes(6).toString('base64url')
  const passwordHash = crypto.createHash('sha256').update(tempPassword).digest('hex')

  try {
    const landlord = await prisma.landlord.create({
      data: { name, email, phone: phone || null, adminKey, passwordHash }
    })
    // 回傳金鑰和臨時密碼（只顯示這一次）
    res.json({ ...landlord, _adminKey: adminKey, _tempPassword: tempPassword })
  } catch (e) {
    if (e.code === 'P2002') return res.status(400).json({ error: 'email 已存在' })
    res.status(500).json({ error: e.message })
  }
})

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

// 設定房東的 LINE Bot（Channel Secret / Token）
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
  const landlord = await prisma.landlord.update({
    where: { id: req.params.id },
    data: {
      lineChannelSecret: lineChannelSecret || null,
      lineChannelToken: lineChannelToken || null,
      lineBotName: lineBotName || null,
      lineOfficialId,
      notifyLineUserId: notifyLineUserId || null,
    }
  })
  // 清除 webhook 設定快取，讓新設定立即生效
  try {
    const { clearConfigCache } = require('./landlordWebhook')
    clearConfigCache(req.params.id)
  } catch (e) {}

  res.json({ ok: true, id: landlord.id })
})

// ── API：上傳照片到 Cloudinary ─────────────────────────────────
router.post('/admin/api/upload', upload.single('file'), async (req, res) => {
  const auth = await resolveRole(req.query.key)
  if (!auth) return res.status(401).json({ error: 'unauthorized' })

  if (!process.env.CLOUDINARY_CLOUD_NAME) {
    return res.status(500).json({ error: 'Cloudinary 未設定' })
  }
  if (!req.file) return res.status(400).json({ error: '未選擇檔案' })

  try {
    const base64 = `data:${req.file.mimetype};base64,${req.file.buffer.toString('base64')}`
    const result = await cloudinary.uploader.upload(base64, {
      folder: 'xiaowo-rental/properties',
      transformation: [{ width: 1200, height: 900, crop: 'limit', quality: 'auto:good' }],
    })
    res.json({ url: result.secure_url, cloudinaryId: result.public_id })
  } catch (e) {
    console.error('上傳失敗:', e.message)
    res.status(500).json({ error: '上傳失敗' })
  }
})

// ── API：圖文選單（Rich Menu） ─────────────────────────────────
// 儲存選單設定
router.post('/admin/api/landlord/:id/richmenu', express.json(), async (req, res) => {
  const auth = await resolveRole(req.query.key)
  if (!auth) return res.status(401).json({ error: 'unauthorized' })
  // 房東只能設自己的
  if (auth.role === 'landlord' && auth.landlordId !== req.params.id) {
    return res.status(403).json({ error: 'forbidden' })
  }

  const { template, cells, chatBarText } = req.body
  const config = JSON.stringify({ template, cells, chatBarText: chatBarText || '選單' })
  await prisma.landlord.update({ where: { id: req.params.id }, data: { richMenuConfig: config } })
  res.json({ ok: true })
})

// 預覽選單圖（回傳 PNG）
router.post('/admin/api/landlord/:id/richmenu/preview', express.json(), async (req, res) => {
  const auth = await resolveRole(req.query.key)
  if (!auth) return res.status(401).json({ error: 'unauthorized' })

  try {
    const { previewRichMenu } = require('./richMenu')
    const { template, cells } = req.body
    const png = await previewRichMenu(template, cells)
    res.set('Content-Type', 'image/png')
    res.send(png)
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

// 套用選單到 LINE Bot
router.post('/admin/api/landlord/:id/richmenu/apply', express.json(), async (req, res) => {
  const auth = await resolveRole(req.query.key)
  if (!auth) return res.status(401).json({ error: 'unauthorized' })
  if (auth.role === 'landlord' && auth.landlordId !== req.params.id) {
    return res.status(403).json({ error: 'forbidden' })
  }

  try {
    const { applyRichMenu } = require('./richMenu')
    const result = await applyRichMenu(req.params.id)
    res.json({ ok: true, richMenuId: result.richMenuId })
  } catch (e) {
    console.error('套用選單失敗:', e.message)
    res.status(500).json({ error: e.message })
  }
})

// 開關選單
router.post('/admin/api/landlord/:id/richmenu/toggle', express.json(), async (req, res) => {
  const auth = await resolveRole(req.query.key)
  if (!auth) return res.status(401).json({ error: 'unauthorized' })
  if (auth.role === 'landlord' && auth.landlordId !== req.params.id) {
    return res.status(403).json({ error: 'forbidden' })
  }

  try {
    const { enableRichMenu, disableRichMenu } = require('./richMenu')
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

// 設定房東官網（名稱 + LOGO）
router.post('/admin/api/landlord/:id/site', express.json(), async (req, res) => {
  const auth = await resolveRole(req.query.key)
  if (!auth) return res.status(401).json({ error: 'unauthorized' })
  if (auth.role === 'landlord' && auth.landlordId !== req.params.id) {
    return res.status(403).json({ error: 'forbidden' })
  }

  const { siteName, siteLogo } = req.body
  const data = {}
  if (siteName !== undefined) data.siteName = siteName || null
  if (siteLogo !== undefined) data.siteLogo = siteLogo || null

  await prisma.landlord.update({ where: { id: req.params.id }, data })
  res.json({ ok: true })
})

// 開關 Bot
router.post('/admin/api/landlord/:id/bot-toggle', express.json(), async (req, res) => {
  const auth = await resolveRole(req.query.key)
  if (!auth) return res.status(401).json({ error: 'unauthorized' })
  if (auth.role === 'landlord' && auth.landlordId !== req.params.id) {
    return res.status(403).json({ error: 'forbidden' })
  }

  await prisma.landlord.update({ where: { id: req.params.id }, data: { botEnabled: !!req.body.enabled } })
  try { require('./botText').clearTextCache(req.params.id) } catch (e) {}
  res.json({ ok: true, enabled: !!req.body.enabled })
})

// ── API：Bot 文字與按鈕開關設定 ────────────────────────────────
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

  try {
    const { clearTextCache } = require('./botText')
    clearTextCache(req.params.id)
  } catch (e) {}

  res.json({ ok: true })
})

// ── 後台頁面 ─────────────────────────────────────────────────────
const path = require('path')
router.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, 'admin/views/admin.html'))
})

module.exports = router
