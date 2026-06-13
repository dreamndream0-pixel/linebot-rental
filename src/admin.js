const express = require('express')
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

// ── API：取得所有資料（依房東隔離） ────────────────────────────
router.get('/admin/api/data', async (req, res) => {
  const auth = await resolveRole(req.query.key)
  if (!auth) return res.status(401).json({ error: 'unauthorized' })

  const f = landlordFilter(auth)  // {} 或 { landlordId }

  const [tenants, bookings, repairs, properties, landlords] = await Promise.all([
    prisma.tenant.findMany({ where: f, include: { property: true }, orderBy: { createdAt: 'desc' } }),
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
          select: { id: true, name: true, email: true, phone: true, adminKey: true, isActive: true, createdAt: true, lineBotName: true, lineChannelSecret: true, lineChannelToken: true, richMenuConfig: true, richMenuId: true, richMenuEnabled: true, siteName: true, siteLogo: true }
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
  }))

  res.json({ tenants, bookings, repairs, properties, landlords: safeLandlords, account: auth.label, role: auth.role, landlordId: auth.landlordId || null, siteUrl: process.env.SITE_URL || 'https://xiaowo-rental.vercel.app' })
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

  const existing = await prisma.booking.findUnique({ where: { id: req.params.id } })
  if (!ownsRecord(auth, existing)) return res.status(403).json({ error: 'forbidden' })

  const booking = await prisma.booking.update({ where: { id: req.params.id }, data: { status: req.body.status } })
  res.json(booking)
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
    await prisma.propertyImage.deleteMany({ where: { propertyId: req.params.id } })
    if (imageUrls.length) {
      await prisma.propertyImage.createMany({
        data: imageUrls.map((url, i) => ({ propertyId: req.params.id, url, order: i, isCover: i === 0 }))
      })
    }
  }
  res.json(property)
})

// ── API：刪除房源（軟刪除） ─────────────────────────────────────
router.post('/admin/api/property/:id/delete', express.json(), async (req, res) => {
  const auth = await resolveRole(req.query.key)
  if (!auth) return res.status(401).json({ error: 'unauthorized' })

  const existing = await prisma.property.findUnique({ where: { id: req.params.id } })
  if (!existing) return res.status(404).json({ error: 'not found' })
  if (auth.role === 'landlord' && existing.ownerId !== auth.landlordId) {
    return res.status(403).json({ error: 'forbidden' })
  }

  const property = await prisma.property.update({
    where: { id: req.params.id },
    data: { deletedAt: new Date(), status: 'PAUSED' }
  })
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

  const { name, phone, isActive } = req.body
  const data = {}
  if (name !== undefined) data.name = name
  if (phone !== undefined) data.phone = phone
  if (isActive !== undefined) data.isActive = isActive

  const landlord = await prisma.landlord.update({ where: { id: req.params.id }, data })
  res.json(landlord)
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
  const landlord = await prisma.landlord.update({
    where: { id: req.params.id },
    data: {
      lineChannelSecret: lineChannelSecret || null,
      lineChannelToken: lineChannelToken || null,
      lineBotName: lineBotName || null,
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

// ── 後台頁面 ─────────────────────────────────────────────────────
router.get('/admin', (req, res) => {
  res.send(ADMIN_HTML)
})

const ADMIN_HTML = `<!DOCTYPE html>
<html lang="zh-TW">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>🐌 小蝸出租 · 管理後台</title>
<style>
  :root {
    --cream: #F0EDE6;
    --sage: #7A9E7E;
    --deep-sage: #4E7153;
    --charcoal: #3D3D3D;
    --white: #FFFFFF;
    --warn: #E8A87C;
    --danger: #D97070;
  }
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body {
    font-family: "Noto Sans TC", -apple-system, sans-serif;
    background: var(--cream);
    color: var(--charcoal);
    min-height: 100vh;
  }
  #loginView {
    display: flex; align-items: center; justify-content: center;
    min-height: 100vh; flex-direction: column; gap: 20px;
  }
  #loadingView {
    display: none; align-items: center; justify-content: center;
    min-height: 100vh; flex-direction: column; gap: 16px;
  }
  .spinner {
    width: 40px; height: 40px; border: 4px solid #E5E0D5;
    border-top-color: var(--sage); border-radius: 50%;
    animation: spin .8s linear infinite;
  }
  @keyframes spin { to { transform: rotate(360deg); } }
  #loadingView p { color: #888; font-size: 14px; }
  .login-card {
    background: var(--white); padding: 40px; border-radius: 20px;
    box-shadow: 0 10px 40px rgba(0,0,0,0.08); text-align: center;
    max-width: 360px; width: 90%;
  }
  .login-card h1 { font-size: 28px; margin-bottom: 8px; }
  .login-card p { color: #888; font-size: 14px; margin-bottom: 24px; }
  .login-card input {
    width: 100%; padding: 14px; border: 2px solid #E5E0D5;
    border-radius: 12px; font-size: 16px; margin-bottom: 16px;
    outline: none; transition: border .2s;
  }
  .login-card input:focus { border-color: var(--sage); }
  .btn {
    background: var(--sage); color: white; border: none;
    padding: 14px 28px; border-radius: 12px; font-size: 16px;
    cursor: pointer; width: 100%; font-weight: 700;
    transition: background .2s;
  }
  .btn:hover { background: var(--deep-sage); }
  #mainView { display: none; }
  header {
    background: linear-gradient(135deg, var(--sage), var(--deep-sage));
    color: white; padding: 24px 20px;
  }
  header h1 { font-size: 22px; }
  header p { font-size: 13px; opacity: .8; margin-top: 4px; }
  .stats {
    display: grid; grid-template-columns: repeat(4, 1fr); gap: 10px;
    padding: 16px 20px; max-width: 900px; margin: 0 auto;
  }
  .stat-card {
    background: var(--white); border-radius: 14px; padding: 14px;
    text-align: center; box-shadow: 0 2px 10px rgba(0,0,0,0.04);
  }
  .stat-card .num { font-size: 26px; font-weight: 900; color: var(--deep-sage); }
  .stat-card .label { font-size: 12px; color: #888; margin-top: 2px; }
  .tabs {
    display: flex; gap: 8px; padding: 0 20px; max-width: 900px;
    margin: 0 auto 16px; flex-wrap: wrap;
  }
  .tab {
    padding: 10px 18px; border-radius: 99px; border: none;
    background: var(--white); color: var(--charcoal); font-size: 14px;
    cursor: pointer; font-weight: 500;
  }
  .tab.active { background: var(--charcoal); color: white; }
  .content { max-width: 900px; margin: 0 auto; padding: 0 20px 60px; }
  .card {
    background: var(--white); border-radius: 16px; padding: 18px;
    margin-bottom: 12px; box-shadow: 0 2px 10px rgba(0,0,0,0.04);
  }
  .card-row { display: flex; justify-content: space-between; align-items: flex-start; gap: 12px; flex-wrap: wrap; }
  .card h3 { font-size: 16px; margin-bottom: 6px; }
  .card .meta { font-size: 13px; color: #888; line-height: 1.7; }
  .uid {
    font-family: monospace; font-size: 12px; background: var(--cream);
    padding: 3px 8px; border-radius: 6px; cursor: pointer;
    word-break: break-all; display: inline-block; margin-top: 4px;
  }
  .uid:hover { background: #E5E0D5; }
  .badge {
    display: inline-block; padding: 4px 12px; border-radius: 99px;
    font-size: 12px; font-weight: 700;
  }
  .badge.PENDING { background: #FBF0E3; color: #C98B4E; }
  .badge.CONFIRMED, .badge.IN_PROGRESS, .badge.AVAILABLE { background: #E8F1E9; color: var(--deep-sage); }
  .badge.DONE, .badge.COMPLETED, .badge.RENTED { background: #EEE; color: #888; }
  .badge.CANCELLED, .badge.REJECTED { background: #FAEAEA; color: var(--danger); }
  .badge.PAUSED { background: #F3F0E8; color: #A89B6C; }
  .actions { display: flex; gap: 6px; margin-top: 10px; flex-wrap: wrap; }
  .action-btn {
    padding: 6px 14px; border-radius: 8px; border: 1.5px solid var(--sage);
    background: transparent; color: var(--deep-sage); font-size: 13px;
    cursor: pointer; font-weight: 500;
  }
  .action-btn:hover { background: var(--sage); color: white; }
  .action-btn.danger { border-color: var(--danger); color: var(--danger); }
  .action-btn.danger:hover { background: var(--danger); color: white; }
  .empty { text-align: center; color: #aaa; padding: 50px 0; font-size: 14px; }
  .form-box { background: var(--white); border-radius: 16px; padding: 20px; margin-bottom: 16px; box-shadow: 0 2px 10px rgba(0,0,0,0.04); }
  .form-box h3 { margin-bottom: 14px; }
  .form-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
  .form-grid .full { grid-column: 1 / -1; }
  .form-box input, .form-box select, .form-box textarea {
    width: 100%; padding: 10px 12px; border: 1.5px solid #E5E0D5;
    border-radius: 10px; font-size: 14px; outline: none; font-family: inherit;
  }
  .form-box input:focus, .form-box select:focus, .form-box textarea:focus { border-color: var(--sage); }
  .form-box label { font-size: 12px; color: #888; display: block; margin-bottom: 4px; }
  .prop-thumb { width: 72px; height: 54px; border-radius: 8px; object-fit: cover; flex-shrink: 0; background: var(--cream); }
  .toast {
    position: fixed; bottom: 24px; left: 50%; transform: translateX(-50%);
    background: var(--charcoal); color: white; padding: 12px 24px;
    border-radius: 99px; font-size: 14px; opacity: 0;
    transition: opacity .3s; pointer-events: none; z-index: 99;
  }
  .toast.show { opacity: 1; }
  @media (max-width: 600px) {
    .stats { grid-template-columns: repeat(2, 1fr); }
    .form-grid { grid-template-columns: 1fr; }
  }
</style>
</head>
<body>

<div id="loadingView">
  <div class="spinner"></div>
  <p>🐌 載入中...</p>
</div>

<div id="loginView">
  <div class="login-card">
    <h1>🐌 小蝸出租</h1>
    <p>管理後台</p>
    <input type="password" id="keyInput" placeholder="輸入管理密碼" onkeydown="if(event.key==='Enter')login()">
    <button class="btn" onclick="login()">登入</button>
  </div>
</div>

<div id="mainView">
  <header>
    <div style="display:flex;justify-content:space-between;align-items:center;">
      <div>
        <h1>🐌 小蝸出租 管理後台</h1>
        <p id="accountLabel">用戶、預約、維修一覽</p>
      </div>
      <div style="display:flex;gap:8px;">
        <a id="siteLink" href="#" target="_blank" style="background:rgba(255,255,255,.18);border:1px solid rgba(255,255,255,.4);color:white;padding:8px 16px;border-radius:99px;font-size:13px;cursor:pointer;text-decoration:none;display:inline-flex;align-items:center;">🌐 網站</a>
        <a id="mainSiteLink" href="#" target="_blank" style="display:none;background:rgba(255,255,255,.18);border:1px solid rgba(255,255,255,.4);color:white;padding:8px 16px;border-radius:99px;font-size:13px;cursor:pointer;text-decoration:none;align-items:center;">🐌 小蝸主站</a>
        <button onclick="logout()" style="background:rgba(255,255,255,.18);border:1px solid rgba(255,255,255,.4);color:white;padding:8px 16px;border-radius:99px;font-size:13px;cursor:pointer;">登出</button>
      </div>
    </div>
  </header>

  <div class="stats" id="stats"></div>

  <div class="tabs" id="tabBar"></div>

  <div class="content" id="content"></div>
</div>

<div class="toast" id="toast"></div>

<script>
var DATA = null
var KEY = sessionStorage.getItem('adminKey') || ''
var currentTab = 'tenants'
var editingPropertyId = null

var TYPE_LABEL = { SUITE: '套房', ROOM: '雅房', WHOLE_FLOOR: '整層住家', SHARED_SUITE: '分租套房' }
var PROP_STATUS_LABEL = { PENDING: '審核中', AVAILABLE: '可租', RENTED: '已租', PAUSED: '暫停刊登', REJECTED: '退回' }
var BOOKING_LABEL = { PENDING: '⏳ 待確認', CONFIRMED: '✅ 已確認', REJECTED: '❌ 已拒絕', CANCELLED: '❌ 已取消', COMPLETED: '🏁 已完成' }
var REPAIR_LABEL = { PENDING: '待處理', IN_PROGRESS: '處理中', DONE: '已完成' }

if (KEY) {
  document.getElementById('loginView').style.display = 'none'
  document.getElementById('loadingView').style.display = 'flex'
  login(KEY)
}

async function login(savedKey) {
  var key = savedKey || document.getElementById('keyInput').value.trim()
  if (!key) return
  try {
    var res = await fetch('/admin/api/data?key=' + encodeURIComponent(key))
    if (!res.ok) {
      showToast('❌ 密碼錯誤')
      sessionStorage.removeItem('adminKey')
      document.getElementById('loadingView').style.display = 'none'
      document.getElementById('loginView').style.display = 'flex'
      return
    }
    DATA = await res.json()
    KEY = key
    sessionStorage.setItem('adminKey', key)
    document.getElementById('loginView').style.display = 'none'
    document.getElementById('loadingView').style.display = 'none'
    document.getElementById('mainView').style.display = 'block'
    if (DATA.account) {
      document.getElementById('accountLabel').textContent = '👤 ' + DATA.account
    }
    if (DATA.siteUrl) {
      var sl = document.getElementById('siteLink')
      var msl = document.getElementById('mainSiteLink')
      if (sl) {
        if (DATA.role === 'landlord' && DATA.landlordId) {
          // 房東：第一顆＝個人官網，第二顆＝小蝸主站
          sl.href = DATA.siteUrl + '/landlord/' + DATA.landlordId
          sl.textContent = '🌐 個人官網'
          if (msl) { msl.href = DATA.siteUrl; msl.style.display = 'inline-flex' }
        } else {
          // 總管理員：只需要主站
          sl.href = DATA.siteUrl
          sl.textContent = '🐌 小蝸主站'
          if (msl) msl.style.display = 'none'
        }
      }
    }
    renderTabBar()
    renderStats()
    renderTab()
  } catch (e) {
    showToast('❌ 連線失敗')
    document.getElementById('loadingView').style.display = 'none'
    document.getElementById('loginView').style.display = 'flex'
  }
}

function logout() {
  sessionStorage.removeItem('adminKey')
  KEY = ''
  DATA = null
  document.getElementById('mainView').style.display = 'none'
  document.getElementById('loadingView').style.display = 'none'
  document.getElementById('loginView').style.display = 'flex'
  document.getElementById('keyInput').value = ''
}

async function reload() {
  var res = await fetch('/admin/api/data?key=' + encodeURIComponent(KEY))
  DATA = await res.json()
  renderStats()
  renderTab()
}

function renderTabBar() {
  var tabs = [
    { id: 'tenants', label: '👥 用戶' },
    { id: 'bookings', label: '📅 預約' },
    { id: 'repairs', label: '🔧 維修' },
    { id: 'properties', label: '🏠 房源管理' },
  ]
  if (DATA.role === 'super') {
    tabs.push({ id: 'landlords', label: '🏢 房東管理' })
  }
  document.getElementById('tabBar').innerHTML = tabs.map(function(t) {
    return '<button class="tab' + (currentTab === t.id ? ' active' : '') + '" data-tab="' + t.id + '" onclick="switchTab(\\'' + t.id + '\\')">' + t.label + '</button>'
  }).join('')
}

function renderStats() {
  var pendingBookings = DATA.bookings.filter(function(b){ return b.status === 'PENDING' }).length
  var pendingRepairs = DATA.repairs.filter(function(r){ return r.status === 'PENDING' }).length
  var available = DATA.properties.filter(function(p){ return p.status === 'AVAILABLE' }).length
  document.getElementById('stats').innerHTML =
    '<div class="stat-card"><div class="num">' + DATA.tenants.length + '</div><div class="label">總用戶</div></div>' +
    '<div class="stat-card"><div class="num">' + available + '</div><div class="label">可租房源</div></div>' +
    '<div class="stat-card"><div class="num">' + pendingBookings + '</div><div class="label">待確認預約</div></div>' +
    '<div class="stat-card"><div class="num">' + pendingRepairs + '</div><div class="label">待處理維修</div></div>'
}

function switchTab(tab) {
  currentTab = tab
  document.querySelectorAll('.tab').forEach(function(t) {
    t.classList.toggle('active', t.dataset.tab === tab)
  })
  renderTab()
}

function renderTab() {
  var el = document.getElementById('content')
  if (currentTab === 'tenants') el.innerHTML = renderTenants()
  if (currentTab === 'bookings') el.innerHTML = renderBookings()
  if (currentTab === 'repairs') el.innerHTML = renderRepairs()
  if (currentTab === 'properties') { el.innerHTML = renderProperties(); setTimeout(renderImgPreview, 50) }
  if (currentTab === 'landlords') el.innerHTML = renderLandlords()
}

function esc(s) {
  return String(s == null ? '' : s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;')
}

function renderTenants() {
  if (!DATA.tenants.length) return '<div class="empty">還沒有用戶，等人加 Bot 好友吧！</div>'
  return DATA.tenants.map(function(t) {
    var avatar = t.avatarUrl
      ? '<img src="' + esc(t.avatarUrl) + '" style="width:52px;height:52px;border-radius:50%;object-fit:cover;flex-shrink:0;" onerror="this.style.display=\\'none\\'">'
      : '<div style="width:52px;height:52px;border-radius:50%;background:var(--cream);display:flex;align-items:center;justify-content:center;font-size:24px;flex-shrink:0;">👤</div>'
    var nameHtml = t.customName
      ? esc(t.customName) + ' <span style="font-weight:400;font-size:13px;color:#aaa;">(' + esc(t.name || '未命名') + ')</span>'
      : esc(t.name || '未命名用戶')
    var sourceTag = (t.source && t.source !== 'main')
      ? '<span style="background:#E8F1E9;color:var(--deep-sage);padding:2px 8px;border-radius:6px;font-size:11px;font-weight:700;">📍 ' + esc(t.source) + '</span> '
      : ''
    return '<div class="card"><div class="card-row">' +
      '<div style="display:flex;gap:14px;align-items:flex-start;">' + avatar +
      '<div><h3>' + nameHtml +
      ' <button onclick="editName(\\'' + t.id + '\\', \\'' + esc(t.customName || '').replace(/'/g, '') + '\\')" style="border:none;background:none;cursor:pointer;font-size:14px;" title="編輯備註名稱">✏️</button></h3>' +
      (t.statusMessage ? '<div style="font-size:13px;color:var(--sage);margin-bottom:4px;">💬 ' + esc(t.statusMessage) + '</div>' : '') +
      '<div class="meta">' + sourceTag +
      (t.property ? '🏠 ' + esc(t.property.title) : '尚未入住') +
      (t.phone ? ' · 📞 ' + esc(t.phone) : '') +
      '<br>加入時間：' + fmtDate(t.createdAt) + '</div>' +
      '<span class="uid" onclick="copyText(\\'' + t.lineUserId + '\\')" title="點擊複製">' + t.lineUserId + '</span>' +
      '</div></div></div></div>'
  }).join('')
}

function renderBookings() {
  if (!DATA.bookings.length) return '<div class="empty">目前沒有預約記錄</div>'
  return DATA.bookings.map(function(b) {
    var who = b.lineUser
      ? (b.lineUser.customName || b.lineUser.name || b.lineUser.lineUserId.slice(0,12) + '...')
      : (b.tenant ? b.tenant.name + '（網站）' : '未知')
    var html = '<div class="card"><div class="card-row"><div>' +
      '<h3>' + esc(b.property.title) + '</h3>' +
      '<div class="meta">📅 ' + fmtDate(b.date) + ' ' + esc(b.timeslot) + '<br>用戶：' + esc(who) + '</div></div>' +
      '<span class="badge ' + b.status + '">' + (BOOKING_LABEL[b.status] || b.status) + '</span></div>'
    if (b.status === 'PENDING') {
      html += '<div class="actions">' +
        '<button class="action-btn" onclick="updateBooking(\\'' + b.id + '\\',\\'CONFIRMED\\')">✅ 確認</button>' +
        '<button class="action-btn" onclick="updateBooking(\\'' + b.id + '\\',\\'CANCELLED\\')">❌ 取消</button></div>'
    } else if (b.status === 'CONFIRMED') {
      html += '<div class="actions">' +
        '<button class="action-btn" onclick="updateBooking(\\'' + b.id + '\\',\\'COMPLETED\\')">🏁 標記完成</button></div>'
    }
    return html + '</div>'
  }).join('')
}

function renderRepairs() {
  if (!DATA.repairs.length) return '<div class="empty">目前沒有維修回報</div>'
  return DATA.repairs.map(function(r) {
    var who = r.lineUser ? (r.lineUser.customName || r.lineUser.name || '') : ''
    var html = '<div class="card"><div class="card-row"><div>' +
      '<h3>' + esc(r.title) + ' · ' + esc(r.property.title) + '</h3>' +
      '<div class="meta">' + esc(r.description) +
      (who ? '<br>回報人：' + esc(who) : '') +
      '<br>回報時間：' + fmtDate(r.createdAt) + '</div></div>' +
      '<span class="badge ' + r.status + '">' + (REPAIR_LABEL[r.status] || r.status) + '</span></div>'
    if (r.status !== 'DONE') {
      html += '<div class="actions">'
      if (r.status === 'PENDING') {
        html += '<button class="action-btn" onclick="updateRepair(\\'' + r.id + '\\',\\'IN_PROGRESS\\')">🔧 開始處理</button>'
      }
      html += '<button class="action-btn" onclick="updateRepair(\\'' + r.id + '\\',\\'DONE\\')">✅ 完成</button></div>'
    }
    return html + '</div>'
  }).join('')
}

// ── 房源管理 ──────────────────────────────────────────────────────
function renderProperties() {
  var formHtml = propertyForm()
  if (!DATA.properties.length) {
    return formHtml + '<div class="empty">還沒有房源，用上方表單新增第一間！</div>'
  }
  var listHtml = DATA.properties.map(function(p) {
    var thumb = (p.images && p.images[0])
      ? '<img class="prop-thumb" src="' + esc(p.images[0].url) + '" onerror="this.style.display=\\'none\\'">'
      : '<div class="prop-thumb" style="display:flex;align-items:center;justify-content:center;font-size:22px;">🏠</div>'
    var statusOptions = Object.keys(PROP_STATUS_LABEL).map(function(s) {
      return '<option value="' + s + '"' + (p.status === s ? ' selected' : '') + '>' + PROP_STATUS_LABEL[s] + '</option>'
    }).join('')
    return '<div class="card"><div class="card-row">' +
      '<div style="display:flex;gap:14px;align-items:flex-start;">' + thumb +
      '<div><h3>' + esc(p.title) + '</h3>' +
      '<div class="meta">' + esc(p.city) + esc(p.district) + ' · ' + (TYPE_LABEL[p.type] || '') +
      ' · NT$ ' + Number(p.price).toLocaleString() + '/月' +
      (p.size ? ' · ' + p.size + '坪' : '') + '</div></div></div>' +
      '<span class="badge ' + p.status + '">' + (PROP_STATUS_LABEL[p.status] || p.status) + '</span></div>' +
      '<div class="actions">' +
      '<select onchange="changePropertyStatus(\\'' + p.id + '\\', this.value)" style="padding:6px 10px;border-radius:8px;border:1.5px solid #E5E0D5;font-size:13px;">' + statusOptions + '</select>' +
      '<button class="action-btn" onclick="startEditProperty(\\'' + p.id + '\\')">✏️ 編輯</button>' +
      '<button class="action-btn danger" onclick="deleteProperty(\\'' + p.id + '\\')">🗑️ 刪除</button>' +
      '</div></div>'
  }).join('')
  return formHtml + listHtml
}

function propertyForm() {
  var p = editingPropertyId ? DATA.properties.find(function(x){ return x.id === editingPropertyId }) : null
  var typeOptions = Object.keys(TYPE_LABEL).map(function(t) {
    return '<option value="' + t + '"' + (p && p.type === t ? ' selected' : '') + '>' + TYPE_LABEL[t] + '</option>'
  }).join('')
  var imageUrls = p && p.images ? p.images.map(function(i){ return i.url }).join(', ') : ''
  // 總管理員新增房源時可選房東
  var ownerPicker = ''
  if (DATA.role === 'super' && !p) {
    var opts = (DATA.landlords || []).filter(function(l){ return l.isActive }).map(function(l){
      return '<option value="' + l.id + '">' + esc(l.name) + '</option>'
    }).join('')
    if (opts) {
      ownerPicker = '<div class="full"><label>歸屬房東 *</label><select id="f_owner">' + opts + '</select></div>'
    } else {
      ownerPicker = '<div class="full" style="color:var(--danger);font-size:13px;">⚠️ 尚無房東，請先到「房東管理」新增房東</div>'
    }
  }
  return '<div class="form-box"><h3>' + (p ? '✏️ 編輯房源：' + esc(p.title) : '➕ 新增房源') + '</h3>' +
    '<div class="form-grid">' +
    ownerPicker +
    '<div class="full"><label>房源名稱 *</label><input id="f_title" value="' + esc(p ? p.title : '') + '" placeholder="例：紅寶石11號 201室 採光套房"></div>' +
    '<div><label>類型</label><select id="f_type">' + typeOptions + '</select></div>' +
    '<div><label>月租金 *</label><input id="f_price" type="number" value="' + (p ? p.price : '') + '" placeholder="8000"></div>' +
    '<div><label>城市</label><input id="f_city" value="' + esc(p ? p.city : '台中市') + '"></div>' +
    '<div><label>區域</label><input id="f_district" value="' + esc(p ? p.district : '') + '" placeholder="北區"></div>' +
    '<div><label>坪數</label><input id="f_size" type="number" step="0.1" value="' + (p ? p.size : '') + '" placeholder="5.5"></div>' +
    '<div><label>押金</label><input id="f_deposit" value="' + esc(p ? p.deposit : '兩個月') + '"></div>' +
    '<div class="full"><label>地址（不公開，僅自己看）</label><input id="f_address" value="' + esc(p ? p.address : '') + '"></div>' +
    '<div class="full"><label>描述</label><textarea id="f_desc" rows="2" placeholder="採光良好，含冷氣熱水器...">' + esc(p ? p.description : '') + '</textarea></div>' +
    '<div class="full"><label>照片</label>' +
    '<div id="img_preview" style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:8px;"></div>' +
    '<input type="file" id="f_upload" accept="image/*" multiple onchange="uploadImages(this)" style="font-size:13px;margin-bottom:8px;">' +
    '<div id="upload_status" style="font-size:12px;color:var(--sage);"></div>' +
    '<input type="hidden" id="f_images" value="' + esc(imageUrls) + '">' +
    '</div>' +
    '<div class="actions" style="margin-top:14px;">' +
    '<button class="btn" style="width:auto;padding:10px 24px;" onclick="saveProperty()">' + (p ? '儲存修改' : '新增房源') + '</button>' +
    (p ? '<button class="action-btn" onclick="cancelEdit()">取消編輯</button>' : '') +
    '</div></div>'
}

function startEditProperty(id) {
  editingPropertyId = id
  renderTab()
  setTimeout(renderImgPreview, 50)
  window.scrollTo({ top: 0, behavior: 'smooth' })
}

// 渲染目前已有的照片預覽（可刪除）
function renderImgPreview() {
  var box = document.getElementById('img_preview')
  var hidden = document.getElementById('f_images')
  if (!box || !hidden) return
  var urls = hidden.value.split(',').map(function(s){ return s.trim() }).filter(Boolean)
  box.innerHTML = urls.map(function(u, i) {
    return '<div style="position:relative;">' +
      '<img src="' + u + '" style="width:72px;height:54px;object-fit:cover;border-radius:8px;">' +
      '<button onclick="removeImg(' + i + ')" style="position:absolute;top:-6px;right:-6px;background:var(--danger);color:white;border:none;border-radius:50%;width:20px;height:20px;font-size:12px;cursor:pointer;line-height:1;">×</button>' +
      (i === 0 ? '<span style="position:absolute;bottom:2px;left:2px;background:var(--sage-dark,#4E7153);color:white;font-size:9px;padding:1px 4px;border-radius:3px;">封面</span>' : '') +
      '</div>'
  }).join('')
}

function removeImg(idx) {
  var hidden = document.getElementById('f_images')
  var urls = hidden.value.split(',').map(function(s){ return s.trim() }).filter(Boolean)
  urls.splice(idx, 1)
  hidden.value = urls.join(', ')
  renderImgPreview()
}

async function uploadImages(input) {
  var files = input.files
  if (!files.length) return
  var status = document.getElementById('upload_status')
  var hidden = document.getElementById('f_images')

  for (var i = 0; i < files.length; i++) {
    status.textContent = '上傳中... (' + (i + 1) + '/' + files.length + ')'
    var fd = new FormData()
    fd.append('file', files[i])
    try {
      var res = await fetch('/admin/api/upload?key=' + encodeURIComponent(KEY), { method: 'POST', body: fd })
      if (!res.ok) { status.textContent = '❌ 上傳失敗'; continue }
      var data = await res.json()
      var cur = hidden.value.split(',').map(function(s){ return s.trim() }).filter(Boolean)
      cur.push(data.url)
      hidden.value = cur.join(', ')
      renderImgPreview()
    } catch (e) {
      status.textContent = '❌ 上傳失敗'
    }
  }
  status.textContent = '✅ 上傳完成'
  input.value = ''
}

function cancelEdit() {
  editingPropertyId = null
  renderTab()
}

async function saveProperty() {
  var body = {
    title: document.getElementById('f_title').value.trim(),
    type: document.getElementById('f_type').value,
    price: document.getElementById('f_price').value,
    city: document.getElementById('f_city').value.trim(),
    district: document.getElementById('f_district').value.trim(),
    size: document.getElementById('f_size').value,
    deposit: document.getElementById('f_deposit').value.trim(),
    address: document.getElementById('f_address').value.trim(),
    description: document.getElementById('f_desc').value.trim(),
    imageUrls: document.getElementById('f_images').value.split(',').map(function(s){ return s.trim() }).filter(Boolean),
  }
  if (!body.title || !body.price) { showToast('❌ 名稱和租金必填'); return }

  // 總管理員新增時帶上選的房東
  var ownerSel = document.getElementById('f_owner')
  if (ownerSel) {
    if (!ownerSel.value) { showToast('❌ 請選擇房東'); return }
    body.ownerId = ownerSel.value
  }

  var url = editingPropertyId
    ? '/admin/api/property/' + editingPropertyId + '?key=' + encodeURIComponent(KEY)
    : '/admin/api/property?key=' + encodeURIComponent(KEY)

  var res = await fetch(url, {
    method: 'POST', headers: {'Content-Type':'application/json'},
    body: JSON.stringify(body)
  })
  if (!res.ok) { showToast('❌ 儲存失敗'); return }
  showToast(editingPropertyId ? '✅ 已更新房源' : '✅ 已新增房源')
  editingPropertyId = null
  reload()
}

async function changePropertyStatus(id, status) {
  await fetch('/admin/api/property/' + id + '?key=' + encodeURIComponent(KEY), {
    method: 'POST', headers: {'Content-Type':'application/json'},
    body: JSON.stringify({ status: status })
  })
  showToast('✅ 狀態已更新')
  reload()
}

async function deleteProperty(id) {
  if (!confirm('確定要刪除這個房源嗎？')) return
  await fetch('/admin/api/property/' + id + '/delete?key=' + encodeURIComponent(KEY), {
    method: 'POST', headers: {'Content-Type':'application/json'}, body: '{}'
  })
  showToast('🗑️ 已刪除')
  reload()
}

// ── 房東管理（僅總管理員） ──────────────────────────────────────
function renderLandlords() {
  var formHtml = '<div class="form-box"><h3>➕ 新增房東</h3>' +
    '<div class="form-grid">' +
    '<div><label>房東名稱 *</label><input id="l_name" placeholder="王先生 / 紅寶石建設"></div>' +
    '<div><label>Email（登入帳號）*</label><input id="l_email" placeholder="landlord@example.com"></div>' +
    '<div><label>電話</label><input id="l_phone" placeholder="0912..."></div>' +
    '</div>' +
    '<div class="actions" style="margin-top:14px;">' +
    '<button class="btn" style="width:auto;padding:10px 24px;" onclick="createLandlord()">新增房東</button>' +
    '</div></div>'

  var list = DATA.landlords || []
  if (!list.length) return formHtml + '<div class="empty">還沒有房東，用上方表單新增第一位！</div>'

  var listHtml = list.map(function(l) {
    var propCount = DATA.properties.filter(function(p){ return p.ownerId === l.id }).length
    var botStatus = l.botConfigured
      ? '<span style="color:var(--deep-sage);font-size:12px;">🤖 Bot 已設定' + (l.lineBotName ? '：' + esc(l.lineBotName) : '') + '</span>'
      : '<span style="color:var(--warn,#C9913A);font-size:12px;">🤖 Bot 未設定</span>'
    var webhookUrl = location.origin + '/webhook/landlord/' + l.id
    return '<div class="card"><div class="card-row"><div>' +
      '<h3>' + esc(l.name) + (l.isActive ? '' : ' <span style="font-size:12px;color:var(--danger);">(已停用)</span>') + '</h3>' +
      '<div class="meta">📧 ' + esc(l.email) + (l.phone ? ' · 📞 ' + esc(l.phone) : '') +
      '<br>🏠 ' + propCount + ' 間房源 · 加入：' + fmtDate(l.createdAt) + '<br>' + botStatus + '</div>' +
      '<div style="margin-top:6px;"><span style="font-size:12px;color:var(--gray-mid);">登入金鑰：</span>' +
      '<span class="uid" onclick="copyText(\\'' + l.adminKey + '\\')" title="點擊複製">' + l.adminKey + '</span></div>' +
      '<div style="margin-top:6px;"><span style="font-size:12px;color:var(--gray-mid);">Webhook URL（填到房東 LINE 後台）：</span><br>' +
      '<span class="uid" onclick="copyText(\\'' + webhookUrl + '\\')" title="點擊複製" style="font-size:11px;">' + webhookUrl + '</span></div>' +
      '</div></div>' +
      '<div class="actions">' +
      '<button class="action-btn" onclick="openSiteEditor(\\'' + l.id + '\\')">⚙️ 官網設定</button>' +
      '<button class="action-btn" onclick="viewLandlordSite(\\'' + l.id + '\\')">🌐 個人官網</button>' +
      '<button class="action-btn" onclick="setupBot(\\'' + l.id + '\\', \\'' + esc(l.name).replace(/'/g, '') + '\\', \\'' + webhookUrl + '\\')">🤖 設定 Bot</button>' +
      '<button class="action-btn" onclick="openMenuEditor(\\'' + l.id + '\\')">📱 設定選單</button>' +
      (l.hasRichMenu ? '<button class="action-btn ' + (l.richMenuEnabled ? 'danger' : '') + '" onclick="toggleMenu(\\'' + l.id + '\\', ' + (!l.richMenuEnabled) + ')">' + (l.richMenuEnabled ? '🔕 關閉選單' : '🔔 開啟選單') + '</button>' : '') +
      '<button class="action-btn" onclick="regenerateKey(\\'' + l.id + '\\')">🔑 重發金鑰</button>' +
      '<button class="action-btn ' + (l.isActive ? 'danger' : '') + '" onclick="toggleLandlord(\\'' + l.id + '\\', ' + (!l.isActive) + ')">' + (l.isActive ? '停用' : '啟用') + '</button>' +
      '</div></div>'
  }).join('')
  return formHtml + listHtml
}

// 設定房東的 LINE Bot
async function setupBot(id, name, webhookUrl) {
  var secret = prompt('【' + name + '】的 LINE Bot 設定\\n\\n步驟1/2：貼上 Channel Secret\\n（從房東的 LINE Developers Console → Basic settings）')
  if (secret === null) return
  var token = prompt('步驟2/2：貼上 Channel Access Token\\n（Messaging API 頁籤最下方 Issue）')
  if (token === null) return
  var botName = prompt('（選填）這個 Bot 的名稱，方便你辨識：', name) || ''
  var notifyId = prompt('（選填）房東要接收「預約/維修通知」的 LINE User ID\\n\\n留空的話，通知會發給你（總管理員）。\\n房東的 User ID 可在他的 LINE Developers Console → Basic settings → Your user ID 取得。') || ''

  var res = await fetch('/admin/api/landlord/' + id + '/bot?key=' + encodeURIComponent(KEY), {
    method: 'POST', headers: {'Content-Type':'application/json'},
    body: JSON.stringify({ lineChannelSecret: secret.trim(), lineChannelToken: token.trim(), lineBotName: botName.trim(), notifyLineUserId: notifyId.trim() })
  })
  if (!res.ok) { showToast('❌ 設定失敗'); return }

  // 顯示要填到 LINE 後台的 Webhook URL
  alert('✅ Bot 設定完成！\\n\\n最後一步：到這個房東的 LINE Developers Console → Messaging API → Webhook URL，填入：\\n\\n' + webhookUrl + '\\n\\n並開啟「Use webhook」。\\n\\n（這串網址已幫你準備好，也會顯示在房東卡片上）')
  reload()
}

async function createLandlord() {
  var name = document.getElementById('l_name').value.trim()
  var email = document.getElementById('l_email').value.trim()
  var phone = document.getElementById('l_phone').value.trim()
  if (!name || !email) { showToast('❌ 名稱和 Email 必填'); return }

  var res = await fetch('/admin/api/landlord?key=' + encodeURIComponent(KEY), {
    method: 'POST', headers: {'Content-Type':'application/json'},
    body: JSON.stringify({ name: name, email: email, phone: phone })
  })
  if (!res.ok) {
    var err = await res.json()
    showToast('❌ ' + (err.error === 'email 已存在' ? 'Email 已存在' : '新增失敗'))
    return
  }
  var data = await res.json()
  // 顯示金鑰給管理員複製（只此一次完整顯示）
  alert('✅ 房東「' + data.name + '」已建立！\\n\\n登入金鑰（請交給房東，用來登入後台）：\\n' + data._adminKey + '\\n\\n這組金鑰就是房東登入後台的密碼。')
  reload()
}

// ── 圖文選單編輯器 ──────────────────────────────────────────────
var MENU_TEMPLATES = {
  '2': { label: '左右兩格', count: 2 },
  '3': { label: '橫向三格', count: 3 },
  '4': { label: '田字四格', count: 4 },
  '6': { label: '六格 (2×3)', count: 6 },
}
var DEFAULT_ICONS = ['🏠','📅','🔧','📋','💬','📞']
var DEFAULT_LABELS = ['查詢空房','預約看房','維修回報','我的預約','聯絡我們','其他']
var DEFAULT_TEXTS = ['查詢空房','預約看房','維修回報','我的預約','聯絡','選單']
var menuEditState = { landlordId: null, template: '4', cells: [] }

function openMenuEditor(landlordId) {
  var l = (DATA.landlords || []).find(function(x){ return x.id === landlordId })
  menuEditState.landlordId = landlordId

  // 載入既有設定，或用預設
  if (l && l.richMenuConfig) {
    try {
      var cfg = JSON.parse(l.richMenuConfig)
      menuEditState.template = cfg.template || '4'
      menuEditState.cells = cfg.cells || []
      menuEditState.chatBarText = cfg.chatBarText || '選單'
    } catch (e) { resetMenuCells() }
  } else {
    resetMenuCells()
  }
  renderMenuEditor()
}

function resetMenuCells() {
  menuEditState.template = '4'
  menuEditState.chatBarText = '選單'
  menuEditState.cells = []
  for (var i = 0; i < 4; i++) {
    menuEditState.cells.push({ icon: DEFAULT_ICONS[i], label: DEFAULT_LABELS[i], text: DEFAULT_TEXTS[i] })
  }
}

function changeTemplate(t) {
  menuEditState.template = t
  var count = MENU_TEMPLATES[t].count
  var cells = []
  for (var i = 0; i < count; i++) {
    cells.push(menuEditState.cells[i] || { icon: DEFAULT_ICONS[i] || '', label: DEFAULT_LABELS[i] || '按鈕', text: DEFAULT_TEXTS[i] || '' })
  }
  menuEditState.cells = cells
  renderMenuEditor()
}

function updateCell(i, field, val) {
  menuEditState.cells[i][field] = val
}

function renderMenuEditor() {
  var tplBtns = Object.keys(MENU_TEMPLATES).map(function(t) {
    return '<button onclick="changeTemplate(\\'' + t + '\\')" style="padding:8px 14px;border-radius:8px;border:1.5px solid ' +
      (menuEditState.template === t ? 'var(--sage);background:var(--sage);color:white;' : '#E5E0D5;background:white;color:var(--charcoal);') +
      'font-size:13px;cursor:pointer;margin-right:6px;margin-bottom:6px;">' + MENU_TEMPLATES[t].label + '</button>'
  }).join('')

  var cellInputs = menuEditState.cells.map(function(c, i) {
    return '<div style="border:1px solid #E5E0D5;border-radius:10px;padding:12px;margin-bottom:8px;">' +
      '<div style="font-size:12px;color:var(--gray-mid);margin-bottom:6px;">格子 ' + (i+1) + '</div>' +
      '<div style="display:flex;gap:6px;flex-wrap:wrap;">' +
      '<input value="' + esc(c.icon || '') + '" onchange="updateCell(' + i + ',\\'icon\\',this.value)" placeholder="圖示" style="width:60px;padding:8px;border:1px solid #E5E0D5;border-radius:8px;text-align:center;">' +
      '<input value="' + esc(c.label || '') + '" onchange="updateCell(' + i + ',\\'label\\',this.value)" placeholder="顯示文字" style="flex:1;min-width:100px;padding:8px;border:1px solid #E5E0D5;border-radius:8px;">' +
      '</div>' +
      '<input value="' + esc(c.text || '') + '" onchange="updateCell(' + i + ',\\'text\\',this.value)" placeholder="點擊後送出的文字（例：查詢空房）" style="width:100%;padding:8px;border:1px solid #E5E0D5;border-radius:8px;margin-top:6px;">' +
      '</div>'
  }).join('')

  var html = '<div id="menuModal" style="position:fixed;inset:0;background:rgba(0,0,0,0.5);z-index:200;display:flex;align-items:flex-start;justify-content:center;overflow-y:auto;padding:20px;">' +
    '<div style="background:white;border-radius:18px;padding:24px;max-width:520px;width:100%;margin:auto;">' +
    '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px;">' +
    '<h3 style="margin:0;">📱 設定圖文選單</h3>' +
    '<button onclick="closeMenuEditor()" style="border:none;background:none;font-size:22px;cursor:pointer;">×</button></div>' +
    '<div style="font-size:13px;color:var(--gray-mid);margin-bottom:8px;">選擇版型</div>' +
    '<div style="margin-bottom:16px;">' + tplBtns + '</div>' +
    '<div style="font-size:13px;color:var(--gray-mid);margin-bottom:8px;">選單列文字（聊天室底部顯示）</div>' +
    '<input value="' + esc(menuEditState.chatBarText || '選單') + '" onchange="menuEditState.chatBarText=this.value" style="width:100%;padding:8px;border:1px solid #E5E0D5;border-radius:8px;margin-bottom:16px;">' +
    '<div style="font-size:13px;color:var(--gray-mid);margin-bottom:8px;">每格設定</div>' +
    cellInputs +
    '<div id="menuPreview" style="margin:16px 0;text-align:center;"></div>' +
    '<div style="display:flex;gap:8px;margin-top:16px;">' +
    '<button class="btn" style="flex:1;" onclick="previewMenu()">預覽圖片</button>' +
    '<button class="btn" style="flex:1;background:var(--deep-sage);" onclick="applyMenu()">儲存並套用</button>' +
    '</div>' +
    '<p style="font-size:11px;color:var(--gray-light);margin-top:12px;line-height:1.6;">套用後選單會出現在該房東 Bot 的聊天室底部。租客點按鈕＝送出你設定的文字，例如「查詢空房」就會觸發查空房功能。</p>' +
    '</div></div>'

  var existing = document.getElementById('menuModal')
  if (existing) existing.remove()
  document.body.insertAdjacentHTML('beforeend', html)
}

function closeMenuEditor() {
  var m = document.getElementById('menuModal')
  if (m) m.remove()
}

async function previewMenu() {
  var box = document.getElementById('menuPreview')
  box.innerHTML = '預覽生成中...'
  try {
    var res = await fetch('/admin/api/landlord/' + menuEditState.landlordId + '/richmenu/preview?key=' + encodeURIComponent(KEY), {
      method: 'POST', headers: {'Content-Type':'application/json'},
      body: JSON.stringify({ template: menuEditState.template, cells: menuEditState.cells })
    })
    if (!res.ok) { box.innerHTML = '❌ 預覽失敗'; return }
    var blob = await res.blob()
    var url = URL.createObjectURL(blob)
    box.innerHTML = '<img src="' + url + '" style="width:100%;border-radius:10px;border:1px solid #E5E0D5;">'
  } catch (e) {
    box.innerHTML = '❌ 預覽失敗'
  }
}

async function applyMenu() {
  // 先存設定
  var saveRes = await fetch('/admin/api/landlord/' + menuEditState.landlordId + '/richmenu?key=' + encodeURIComponent(KEY), {
    method: 'POST', headers: {'Content-Type':'application/json'},
    body: JSON.stringify({ template: menuEditState.template, cells: menuEditState.cells, chatBarText: menuEditState.chatBarText })
  })
  if (!saveRes.ok) { showToast('❌ 儲存失敗'); return }

  showToast('套用中，請稍候...')
  var res = await fetch('/admin/api/landlord/' + menuEditState.landlordId + '/richmenu/apply?key=' + encodeURIComponent(KEY), {
    method: 'POST', headers: {'Content-Type':'application/json'}, body: '{}'
  })
  if (!res.ok) {
    var err = await res.json()
    alert('❌ 套用失敗：' + (err.error || '未知錯誤') + '\\n\\n請確認該房東的 Bot 已設定 Channel Token。')
    return
  }
  showToast('✅ 選單已套用')
  closeMenuEditor()
  reload()
}

function viewLandlordSite(id) {
  var base = (DATA && DATA.siteUrl) ? DATA.siteUrl : 'https://xiaowo-rental.vercel.app'
  window.open(base + '/landlord/' + id, '_blank')
}

function openSiteEditor(id) {
  var l = (DATA.landlords || []).find(function(x){ return x.id === id })
  if (!l) return
  siteEditState = { id: id, siteName: l.siteName || '', siteLogo: l.siteLogo || '' }
  renderSiteEditor()
}

var siteEditState = { id: null, siteName: '', siteLogo: '' }

function renderSiteEditor() {
  var logoPreview = siteEditState.siteLogo
    ? '<img src="' + siteEditState.siteLogo + '" style="width:72px;height:72px;object-fit:cover;border-radius:12px;border:1px solid #E5E0D5;">'
    : '<div style="width:72px;height:72px;border-radius:12px;background:#F0EDE6;display:flex;align-items:center;justify-content:center;font-size:28px;">🏠</div>'

  var html = '<div id="siteModal" style="position:fixed;inset:0;background:rgba(0,0,0,0.5);z-index:200;display:flex;align-items:flex-start;justify-content:center;overflow-y:auto;padding:20px;">' +
    '<div style="background:white;border-radius:18px;padding:24px;max-width:440px;width:100%;margin:auto;">' +
    '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px;">' +
    '<h3 style="margin:0;">⚙️ 官網設定</h3>' +
    '<button onclick="closeSiteEditor()" style="border:none;background:none;font-size:22px;cursor:pointer;">×</button></div>' +
    '<label style="font-size:13px;color:var(--gray-mid);display:block;margin-bottom:6px;">官網名稱</label>' +
    '<input id="site_name" value="' + esc(siteEditState.siteName) + '" placeholder="例：小宇優質套房" style="width:100%;padding:10px 14px;border:1px solid #E5E0D5;border-radius:10px;margin-bottom:16px;">' +
    '<label style="font-size:13px;color:var(--gray-mid);display:block;margin-bottom:6px;">官網 LOGO</label>' +
    '<div style="display:flex;align-items:center;gap:12px;margin-bottom:8px;">' +
    '<div id="logo_preview">' + logoPreview + '</div>' +
    '<input type="file" id="logo_upload" accept="image/*" onchange="uploadLogo(this)" style="font-size:13px;">' +
    '</div>' +
    '<div id="logo_status" style="font-size:12px;color:var(--sage);"></div>' +
    '<div style="display:flex;gap:8px;margin-top:20px;">' +
    '<button class="btn" style="flex:1;background:var(--deep-sage);" onclick="saveSite()">儲存</button>' +
    '</div></div></div>'

  var existing = document.getElementById('siteModal')
  if (existing) existing.remove()
  document.body.insertAdjacentHTML('beforeend', html)
}

function closeSiteEditor() {
  var m = document.getElementById('siteModal')
  if (m) m.remove()
}

async function uploadLogo(input) {
  if (!input.files || !input.files[0]) return
  var status = document.getElementById('logo_status')
  status.textContent = '上傳中...'
  var fd = new FormData()
  fd.append('file', input.files[0])
  try {
    var res = await fetch('/admin/api/upload?key=' + encodeURIComponent(KEY), { method: 'POST', body: fd })
    if (!res.ok) { status.textContent = '❌ 上傳失敗'; return }
    var data = await res.json()
    siteEditState.siteLogo = data.url
    document.getElementById('logo_preview').innerHTML = '<img src="' + data.url + '" style="width:72px;height:72px;object-fit:cover;border-radius:12px;border:1px solid #E5E0D5;">'
    status.textContent = '✅ 上傳完成'
  } catch (e) {
    status.textContent = '❌ 上傳失敗'
  }
}

async function saveSite() {
  var name = document.getElementById('site_name').value.trim()
  var res = await fetch('/admin/api/landlord/' + siteEditState.id + '/site?key=' + encodeURIComponent(KEY), {
    method: 'POST', headers: {'Content-Type':'application/json'},
    body: JSON.stringify({ siteName: name, siteLogo: siteEditState.siteLogo })
  })
  if (!res.ok) { showToast('❌ 儲存失敗'); return }
  showToast('✅ 官網設定已儲存')
  closeSiteEditor()
  reload()
}

async function toggleMenu(id, enable) {
  showToast(enable ? '開啟中...' : '關閉中...')
  var res = await fetch('/admin/api/landlord/' + id + '/richmenu/toggle?key=' + encodeURIComponent(KEY), {
    method: 'POST', headers: {'Content-Type':'application/json'},
    body: JSON.stringify({ enabled: enable })
  })
  if (!res.ok) {
    var err = await res.json()
    alert('❌ 操作失敗：' + (err.error || '未知錯誤'))
    return
  }
  showToast(enable ? '🔔 選單已開啟' : '🔕 選單已關閉')
  reload()
}


async function regenerateKey(id) {
  if (!confirm('重發金鑰後，舊金鑰立刻失效，房東要用新金鑰登入。確定？')) return
  var res = await fetch('/admin/api/landlord/' + id + '/regenerate-key?key=' + encodeURIComponent(KEY), {
    method: 'POST', headers: {'Content-Type':'application/json'}, body: '{}'
  })
  var data = await res.json()
  alert('🔑 新金鑰：\\n' + data._adminKey + '\\n\\n請交給房東。')
  reload()
}

async function toggleLandlord(id, isActive) {
  await fetch('/admin/api/landlord/' + id + '?key=' + encodeURIComponent(KEY), {
    method: 'POST', headers: {'Content-Type':'application/json'},
    body: JSON.stringify({ isActive: isActive })
  })
  showToast(isActive ? '✅ 已啟用' : '⏸️ 已停用')
  reload()
}

async function updateBooking(id, status) {
  await fetch('/admin/api/booking/' + id + '/status?key=' + encodeURIComponent(KEY), {
    method: 'POST', headers: {'Content-Type':'application/json'},
    body: JSON.stringify({ status: status })
  })
  showToast('✅ 已更新')
  reload()
}

async function updateRepair(id, status) {
  await fetch('/admin/api/repair/' + id + '/status?key=' + encodeURIComponent(KEY), {
    method: 'POST', headers: {'Content-Type':'application/json'},
    body: JSON.stringify({ status: status })
  })
  showToast('✅ 已更新')
  reload()
}

async function editName(tenantId, currentName) {
  var newName = prompt('輸入備註名稱（清空 = 恢復顯示 LINE 名稱）:', currentName)
  if (newName === null) return
  await fetch('/admin/api/tenant/' + tenantId + '/name?key=' + encodeURIComponent(KEY), {
    method: 'POST', headers: {'Content-Type':'application/json'},
    body: JSON.stringify({ customName: newName.trim() })
  })
  showToast('✅ 名稱已更新')
  reload()
}

function copyText(text) {
  navigator.clipboard.writeText(text)
  showToast('📋 已複製 User ID')
}

function fmtDate(d) {
  return new Date(d).toLocaleDateString('zh-TW', { year:'numeric', month:'2-digit', day:'2-digit' })
}

function showToast(msg) {
  var t = document.getElementById('toast')
  t.textContent = msg
  t.classList.add('show')
  setTimeout(function(){ t.classList.remove('show') }, 2000)
}
</script>
</body>
</html>`

module.exports = router
