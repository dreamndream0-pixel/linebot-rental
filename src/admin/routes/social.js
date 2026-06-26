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
// 建立媒體容器，回傳 container id（用 URLSearchParams 正確編碼 caption/換行/emoji）
async function igCreateContainer(accountId, accessToken, params) {
  const qs = new URLSearchParams({ ...params, access_token: accessToken })
  const res = await fetch(`${IG_API_BASE}/${accountId}/media?${qs.toString()}`, { method: 'POST' })
  const data = await res.json()
  if (!data.id) throw new Error('建立貼文失敗：' + (data.error?.message || JSON.stringify(data)))
  return data.id
}

// Instagram 需要時間下載/處理圖片，要等容器狀態 FINISHED 才能發布，
// 否則會回「Media ID is not available」。最多輪詢約 30 秒。
async function igWaitFinished(containerId, accessToken) {
  for (let i = 0; i < 15; i++) {
    await new Promise(r => setTimeout(r, 2000))
    const statusUrl = `${IG_API_BASE}/${containerId}?fields=status_code&access_token=${encodeURIComponent(accessToken)}`
    const code = (await (await fetch(statusUrl)).json()).status_code
    if (code === 'FINISHED') return
    if (code === 'ERROR' || code === 'EXPIRED') {
      throw new Error('圖片處理失敗（' + code + '）：請確認照片網址可公開存取、格式為 JPG，且比例介於 4:5 ~ 1.91:1')
    }
  }
  throw new Error('圖片處理逾時，請稍後再試一次')
}

async function igPublish(accountId, accessToken, creationId) {
  const res = await fetch(`${IG_API_BASE}/${accountId}/media_publish?creation_id=${creationId}&access_token=${encodeURIComponent(accessToken)}`, { method: 'POST' })
  const data = await res.json()
  if (!data.id) throw new Error('發布失敗：' + (data.error?.message || JSON.stringify(data)))
  return data.id
}

async function postToInstagram({ accountId, accessToken, imageUrls, caption }) {
  if (!accountId || !accessToken) throw new Error('尚未設定 Instagram 帳號 ID 或 Access Token')
  const urls = (imageUrls || []).filter(Boolean).slice(0, 10) // IG 輪播上限 10 張
  if (!urls.length) throw new Error('此房源沒有照片，無法發布到 Instagram')

  // 單張：直接建立含文案的容器後發布
  if (urls.length === 1) {
    const id = await igCreateContainer(accountId, accessToken, { image_url: urls[0], caption })
    await igWaitFinished(id, accessToken)
    return igPublish(accountId, accessToken, id)
  }

  // 多張：每張先建子容器（is_carousel_item），再組成 CAROUSEL 母容器發布
  const childIds = []
  for (const url of urls) {
    const childId = await igCreateContainer(accountId, accessToken, { image_url: url, is_carousel_item: 'true' })
    await igWaitFinished(childId, accessToken)
    childIds.push(childId)
  }
  const carouselId = await igCreateContainer(accountId, accessToken, {
    media_type: 'CAROUSEL', caption, children: childIds.join(','),
  })
  await igWaitFinished(carouselId, accessToken)
  return igPublish(accountId, accessToken, carouselId)
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
    include: { images: { orderBy: [{ isCover: 'desc' }, { order: 'asc' }] } },
  })
  if (!property) return res.status(404).json({ error: '找不到此房源' })
  if (auth.role === 'landlord' && property.ownerId !== auth.landlordId) {
    return res.status(403).json({ error: 'forbidden' })
  }

  const config = await getConfig(auth)
  // 前端可傳入編輯過的文案；沒給才用預設組字
  const caption = (typeof req.body.caption === 'string' && req.body.caption.trim())
    ? req.body.caption.trim()
    : buildCaption(property)
  const imageUrls = property.images.map(i => i.url).filter(Boolean)
  const results = {}

  for (const platform of platforms) {
    try {
      if (platform === 'instagram') {
        const ig = config.instagram || {}
        const postId = await postToInstagram({
          accountId: ig.accountId, accessToken: ig.accessToken, imageUrls, caption,
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

// ── Instagram OAuth（一鍵連結，房東免手動填 token）──────────────────
// Instagram API with Instagram Login 授權流程：
//   connect → 導向 instagram.com 授權 → callback 換 token → 存進設定
const IG_APP_ID = process.env.IG_APP_ID
const IG_APP_SECRET = process.env.IG_APP_SECRET

// state → { key, expires }，避免把後台金鑰直接帶過 Instagram
const oauthStates = new Map()
function makeState(key) {
  const state = require('crypto').randomBytes(16).toString('hex')
  oauthStates.set(state, { key, expires: Date.now() + 10 * 60 * 1000 })
  // 順手清掉過期的
  for (const [s, v] of oauthStates) if (v.expires < Date.now()) oauthStates.delete(s)
  return state
}

function redirectUri(req) {
  if (process.env.IG_REDIRECT_URI) return process.env.IG_REDIRECT_URI
  const host = req.get('host')
  const proto = /localhost|127\.0\.0\.1/.test(host) ? 'http' : 'https'
  return `${proto}://${host}/admin/api/social/ig/callback`
}

function popupClose(message) {
  return `<!doctype html><meta charset="utf-8"><body style="font-family:sans-serif;text-align:center;padding:40px;color:#444;">
    <p>${message}</p><p style="color:#999;font-size:13px;">這個視窗即將自動關閉…</p>
    <script>setTimeout(function(){ window.close() }, 1800)</script></body>`
}

router.get('/admin/api/social/ig/connect', async (req, res) => {
  const auth = await resolveRole(req.query.key)
  if (!auth) return res.status(401).send(popupClose('授權失敗：登入狀態無效，請重新登入後台。'))
  if (!IG_APP_ID || !IG_APP_SECRET) {
    return res.status(500).send(popupClose('系統尚未設定 Instagram 應用程式（IG_APP_ID / IG_APP_SECRET），請聯絡管理員。'))
  }
  const state = makeState(req.query.key)
  const scope = 'instagram_business_basic,instagram_business_content_publish'
  const url = 'https://www.instagram.com/oauth/authorize'
    + '?client_id=' + encodeURIComponent(IG_APP_ID)
    + '&redirect_uri=' + encodeURIComponent(redirectUri(req))
    + '&response_type=code'
    + '&scope=' + encodeURIComponent(scope)
    + '&state=' + state
  res.redirect(url)
})

router.get('/admin/api/social/ig/callback', async (req, res) => {
  const { code, state, error, error_description } = req.query
  if (error) return res.send(popupClose('授權未完成：' + (error_description || error)))
  const entry = state && oauthStates.get(state)
  if (!entry || entry.expires < Date.now()) {
    return res.status(400).send(popupClose('授權連結已失效，請回後台重新點「連結 Instagram」。'))
  }
  oauthStates.delete(state)
  const auth = await resolveRole(entry.key)
  if (!auth) return res.status(401).send(popupClose('授權失敗：登入狀態無效。'))

  try {
    // 1) code 換短期 token（同時拿到 user_id）
    const form = new URLSearchParams({
      client_id: IG_APP_ID,
      client_secret: IG_APP_SECRET,
      grant_type: 'authorization_code',
      redirect_uri: redirectUri(req),
      code: String(code),
    })
    const shortRes = await fetch('https://api.instagram.com/oauth/access_token', { method: 'POST', body: form })
    const shortData = await shortRes.json()
    if (!shortData.access_token) {
      throw new Error(shortData.error_message || JSON.stringify(shortData))
    }
    const userId = String(shortData.user_id)

    // 2) 短期換長期 token（約 60 天）
    const longUrl = 'https://graph.instagram.com/access_token'
      + '?grant_type=ig_exchange_token'
      + '&client_secret=' + encodeURIComponent(IG_APP_SECRET)
      + '&access_token=' + encodeURIComponent(shortData.access_token)
    const longData = await (await fetch(longUrl)).json()
    const accessToken = longData.access_token || shortData.access_token

    // 3) OAuth 的 user_id 是 app 範圍 ID，發文要用 IG 商業帳號 ID（17841…），
    //    向 /me 查 user_id 欄位取得正確的發文帳號 ID
    let publishId = userId
    try {
      const meUrl = `${IG_API_BASE}/me?fields=user_id&access_token=${encodeURIComponent(accessToken)}`
      const me = await (await fetch(meUrl)).json()
      if (me.user_id) publishId = String(me.user_id)
    } catch (_) {}

    // 4) 存進該帳號的設定
    const config = await getConfig(auth)
    config.instagram = config.instagram || {}
    config.instagram.accountId = publishId
    config.instagram.accessToken = accessToken
    await saveConfig(auth, config)

    res.send(popupClose('✅ Instagram 連結成功！'))
  } catch (e) {
    res.status(500).send(popupClose('連結失敗：' + e.message))
  }
})

module.exports = router
