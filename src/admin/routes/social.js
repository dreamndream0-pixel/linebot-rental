// src/admin/routes/social.js — 社群管理：房源一鍵發文（第一步：串接 Instagram）
const express = require('express')
const router = express.Router()
const { resolveRole } = require('../helpers')
const prisma = require('../../db')

// Instagram API with Instagram Login（token 以 IGAA 開頭，使用 graph.instagram.com）
// 帳號 ID 填 Instagram 商業帳號的 user_id（17841... 開頭）
const IG_API_BASE = 'https://graph.instagram.com/v21.0'

// ── 設定讀寫 ──────────────────────────────────────────────────────
// 房東：存在 Landlord.socialConfig；總管理員（主站）：存在 site_settings（key=social_config）
function parseConfig(json) {
  try { return json ? JSON.parse(json) : {} } catch { return {} }
}

async function getConfig(auth) {
  if (auth.role === 'super') {
    await prisma.$queryRawUnsafe(`
      CREATE TABLE IF NOT EXISTS site_settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `)
    const rows = await prisma.$queryRawUnsafe(`SELECT value FROM site_settings WHERE key = 'social_config'`)
    return parseConfig(rows[0]?.value)
  }
  const landlord = await prisma.landlord.findUnique({ where: { id: auth.landlordId }, select: { socialConfig: true } })
  return parseConfig(landlord?.socialConfig)
}

async function saveConfig(auth, config) {
  if (auth.role === 'super') {
    await prisma.$queryRawUnsafe(
      `INSERT INTO site_settings (key, value, "updatedAt") VALUES ('social_config', $1, NOW())
       ON CONFLICT (key) DO UPDATE SET value = $1, "updatedAt" = NOW()`,
      JSON.stringify(config)
    )
    return
  }
  await prisma.landlord.update({ where: { id: auth.landlordId }, data: { socialConfig: JSON.stringify(config) } })
}

// 回傳給前端用的設定（權杖遮蔽，只顯示後 4 碼）
function maskConfig(config) {
  const ig = config.instagram || {}
  return {
    instagram: {
      accountId: ig.accountId || '',
      hasToken: !!ig.accessToken,
      tokenPreview: ig.accessToken ? '••••' + ig.accessToken.slice(-4) : '',
    },
  }
}

router.get('/admin/api/social/config', async (req, res) => {
  const auth = await resolveRole(req.query.key)
  if (!auth) return res.status(401).json({ error: 'unauthorized' })
  try {
    const config = await getConfig(auth)
    res.json(maskConfig(config))
  } catch (e) { res.status(500).json({ error: e.message }) }
})

router.post('/admin/api/social/config', express.json(), async (req, res) => {
  const auth = await resolveRole(req.query.key)
  if (!auth) return res.status(401).json({ error: 'unauthorized' })
  try {
    const config = await getConfig(auth)
    const { instagramAccountId, instagramAccessToken } = req.body
    config.instagram = config.instagram || {}
    if (instagramAccountId !== undefined) config.instagram.accountId = String(instagramAccountId || '').trim()
    // 權杖只在使用者真的輸入新值時才覆蓋，避免每次儲存都被清空
    if (instagramAccessToken) config.instagram.accessToken = String(instagramAccessToken).trim()
    await saveConfig(auth, config)
    res.json({ ok: true, config: maskConfig(config) })
  } catch (e) { res.status(500).json({ error: e.message }) }
})

// ── Instagram 發文（Content Publishing API） ───────────────────────
async function postToInstagram({ accountId, accessToken, imageUrl, caption }) {
  if (!accountId || !accessToken) throw new Error('尚未設定 Instagram 帳號 ID 或 Access Token')
  if (!imageUrl) throw new Error('此房源沒有照片，無法發布到 Instagram')

  const createUrl = `${IG_API_BASE}/${accountId}/media?image_url=${encodeURIComponent(imageUrl)}&caption=${encodeURIComponent(caption)}&access_token=${encodeURIComponent(accessToken)}`
  const createRes = await fetch(createUrl, { method: 'POST' })
  const createData = await createRes.json()
  if (!createData.id) throw new Error('建立貼文失敗：' + (createData.error?.message || JSON.stringify(createData)))

  const publishUrl = `${IG_API_BASE}/${accountId}/media_publish?creation_id=${createData.id}&access_token=${encodeURIComponent(accessToken)}`
  const publishRes = await fetch(publishUrl, { method: 'POST' })
  const publishData = await publishRes.json()
  if (!publishData.id) throw new Error('發布失敗：' + (publishData.error?.message || JSON.stringify(publishData)))

  return publishData.id
}

function buildCaption(property) {
  const lines = [
    `🏠 ${property.title}`,
    `📍 ${property.city || ''}${property.district || ''}`,
    `💰 NT$ ${Number(property.price).toLocaleString()}/月・${property.size} 坪`,
  ]
  return lines.join('\n')
}

router.post('/admin/api/social/post', express.json(), async (req, res) => {
  const auth = await resolveRole(req.query.key)
  if (!auth) return res.status(401).json({ error: 'unauthorized' })

  const { propertyId, platforms } = req.body
  if (!propertyId || !Array.isArray(platforms) || !platforms.length) {
    return res.status(400).json({ error: '請選擇房源與至少一個發布平台' })
  }

  const property = await prisma.property.findUnique({
    where: { id: propertyId },
    include: { images: { orderBy: [{ isCover: 'desc' }, { order: 'asc' }], take: 1 } },
  })
  if (!property) return res.status(404).json({ error: '找不到此房源' })
  if (auth.role === 'landlord' && property.ownerId !== auth.landlordId) {
    return res.status(403).json({ error: 'forbidden' })
  }

  const config = await getConfig(auth)
  const caption = buildCaption(property)
  const imageUrl = property.images[0]?.url || null
  const results = {}

  for (const platform of platforms) {
    try {
      if (platform === 'instagram') {
        const ig = config.instagram || {}
        const postId = await postToInstagram({
          accountId: ig.accountId, accessToken: ig.accessToken, imageUrl, caption,
        })
        results.instagram = { ok: true, postId }
      } else {
        // Facebook、Threads 尚未串接
        results[platform] = { ok: false, error: '此平台尚未開放，敬請期待' }
      }
    } catch (e) {
      results[platform] = { ok: false, error: e.message }
    }
  }

  res.json({ results })
})

module.exports = router
