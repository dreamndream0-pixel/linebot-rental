// src/admin/routes/social.js — 社群管理：房源一鍵發文（第一步：串接 Instagram）
const express = require('express')
const router = express.Router()
const { resolveRole, revalidateSite } = require('../helpers')
const prisma = require('../../db')

// Instagram API with Instagram Login（token 以 IGAA 開頭，使用 graph.instagram.com）
// 帳號 ID 填 Instagram 商業帳號的 user_id（17841... 開頭）
const IG_API_BASE = 'https://graph.instagram.com/v21.0'
const FB_API_BASE = 'https://graph.facebook.com/v21.0'

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
  const fb = config.facebook || {}
  const pages = fb.pages || []
  const activePage = pages.find(p => p.id === fb.pageId) || null
  return {
    instagram: {
      accountId: ig.accountId || '',
      hasToken: !!ig.accessToken,
      tokenPreview: ig.accessToken ? '••••' + ig.accessToken.slice(-4) : '',
    },
    facebook: {
      connected: !!(pages.length && fb.pageId && activePage),
      pageId: fb.pageId || '',
      pageName: activePage ? activePage.name : '',
      pages: pages.map(p => ({ id: p.id, name: p.name })),
    },
  }
}

// 帶超時的 GET（避免抓頭像/名稱時拖慢設定載入）
async function fetchJsonQuick(url, ms = 4000) {
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(ms) })
    return await r.json()
  } catch (_) { return null }
}

router.get('/admin/api/social/config', async (req, res) => {
  const auth = await resolveRole(req.query.key)
  if (!auth) return res.status(401).json({ error: 'unauthorized' })
  try {
    const config = await getConfig(auth)
    const masked = maskConfig(config)

    const ig = config.instagram || {}
    const fb = config.facebook || {}
    const activePage = (fb.pages || []).find(p => p.id === fb.pageId)

    // 平行抓 IG 名稱/頭像 與 FB 粉專頭像（抓不到就維持空值、不影響其他功能）
    const [igProfile, fbPic] = await Promise.all([
      (ig.accountId && ig.accessToken)
        ? fetchJsonQuick(`${IG_API_BASE}/me?fields=username,profile_picture_url&access_token=${encodeURIComponent(ig.accessToken)}`)
        : Promise.resolve(null),
      (activePage && activePage.token)
        ? fetchJsonQuick(`${FB_API_BASE}/${activePage.id}?fields=picture.width(96).height(96){url}&access_token=${encodeURIComponent(activePage.token)}`)
        : Promise.resolve(null),
    ])
    if (igProfile && igProfile.username) masked.instagram.username = igProfile.username
    if (igProfile && igProfile.profile_picture_url) masked.instagram.avatar = igProfile.profile_picture_url
    if (fbPic && fbPic.picture && fbPic.picture.data && fbPic.picture.data.url) masked.facebook.pageAvatar = fbPic.picture.data.url

    res.json(masked)
  } catch (e) { res.status(500).json({ error: e.message }) }
})

// 取消連結（清掉該平台的設定）
router.post('/admin/api/social/disconnect', express.json(), async (req, res) => {
  const auth = await resolveRole(req.query.key)
  if (!auth) return res.status(401).json({ error: 'unauthorized' })
  try {
    const config = await getConfig(auth)
    if (req.body.platform === 'instagram') config.instagram = {}
    else if (req.body.platform === 'facebook') config.facebook = {}
    else return res.status(400).json({ error: 'unknown platform' })
    await saveConfig(auth, config)
    res.json({ ok: true })
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

async function postStoryToInstagram({ accountId, accessToken, imageUrl }) {
  if (!accountId || !accessToken) throw new Error('尚未設定 Instagram 帳號 ID 或 Access Token')
  if (!imageUrl) throw new Error('此房源沒有照片，無法發布限時動態')
  const id = await igCreateContainer(accountId, accessToken, {
    media_type: 'STORIES',
    image_url: imageUrl,
  })
  await igWaitFinished(id, accessToken)
  return igPublish(accountId, accessToken, id)
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

// ── Facebook 粉專發文（Page Graph API） ────────────────────────────
async function postToFacebook({ pageId, pageToken, imageUrls, message }) {
  if (!pageId || !pageToken) throw new Error('尚未連結 Facebook 粉專')
  const urls = (imageUrls || []).filter(Boolean)

  // 沒照片：發純文字貼文
  if (!urls.length) {
    const res = await fetch(`${FB_API_BASE}/${pageId}/feed`, {
      method: 'POST', body: new URLSearchParams({ message, access_token: pageToken }),
    })
    const d = await res.json()
    if (!d.id) throw new Error('發布失敗：' + (d.error?.message || JSON.stringify(d)))
    return d.id
  }

  // 有照片：先上傳未發布的照片取得 media_fbid，再用 attached_media 組成多圖貼文
  const mediaFbids = []
  for (const url of urls) {
    const res = await fetch(`${FB_API_BASE}/${pageId}/photos`, {
      method: 'POST', body: new URLSearchParams({ url, published: 'false', access_token: pageToken }),
    })
    const d = await res.json()
    if (!d.id) throw new Error('上傳照片失敗：' + (d.error?.message || JSON.stringify(d)))
    mediaFbids.push(d.id)
  }
  const body = new URLSearchParams({ message, access_token: pageToken })
  mediaFbids.forEach((id, i) => body.append(`attached_media[${i}]`, JSON.stringify({ media_fbid: id })))
  const res = await fetch(`${FB_API_BASE}/${pageId}/feed`, { method: 'POST', body })
  const d = await res.json()
  if (!d.id) throw new Error('發布失敗：' + (d.error?.message || JSON.stringify(d)))
  return d.id
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

  const { propertyId, platforms, postType } = req.body
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
  const isStory = postType === 'story'
  // 前端可傳入編輯過的文案；沒給才用預設組字（限時動態不帶 caption）
  const caption = isStory ? '' : (
    (typeof req.body.caption === 'string' && req.body.caption.trim())
      ? req.body.caption.trim()
      : buildCaption(property)
  )
  const imageUrls = property.images.map(i => i.url).filter(Boolean)
  const results = {}

  for (const platform of platforms) {
    try {
      if (platform === 'instagram') {
        const ig = config.instagram || {}
        if (isStory) {
          const postId = await postStoryToInstagram({
            accountId: ig.accountId, accessToken: ig.accessToken, imageUrl: imageUrls[0],
          })
          results.instagram = { ok: true, postId, type: 'story' }
        } else {
          const postId = await postToInstagram({
            accountId: ig.accountId, accessToken: ig.accessToken, imageUrls, caption,
          })
          results.instagram = { ok: true, postId }
        }
      } else if (platform === 'facebook') {
        const fb = config.facebook || {}
        const page = (fb.pages || []).find(p => p.id === fb.pageId) || (fb.pages || [])[0]
        if (!page) throw new Error('尚未連結 Facebook 粉專')
        const postId = await postToFacebook({
          pageId: page.id, pageToken: page.token, imageUrls, message: caption,
        })
        results.facebook = { ok: true, postId }
      } else {
        // Threads 尚未串接
        results[platform] = { ok: false, error: '此平台尚未開放，敬請期待' }
      }
    } catch (e) {
      results[platform] = { ok: false, error: e.message }
    }
  }

  res.json({ results })
})

// ── IG 已發布貼文（總覽九宮格用，連動讀取）─────────────────────────
async function fetchIgMedia(accessToken, cursor) {
  const fullFields = 'id,caption,media_type,media_url,thumbnail_url,permalink,timestamp,like_count,comments_count,children{media_url,thumbnail_url}'
  const slimFields = 'id,caption,media_type,media_url,thumbnail_url,permalink,timestamp'
  const buildUrl = (fields) => {
    const qs = new URLSearchParams({ limit: '30', access_token: accessToken, fields })
    if (cursor) qs.set('after', cursor)
    return `${IG_API_BASE}/me/media?${qs}`
  }
  let data = await (await fetch(buildUrl(fullFields))).json()
  if (data.error) data = await (await fetch(buildUrl(slimFields))).json()
  return data
}

router.get('/admin/api/social/ig/feed', async (req, res) => {
  const auth = await resolveRole(req.query.key)
  if (!auth) return res.status(401).json({ error: 'unauthorized' })
  try {
    const config = await getConfig(auth)
    const ig = config.instagram || {}
    if (!ig.accountId || !ig.accessToken) return res.json({ connected: false, media: [] })
    const data = await fetchIgMedia(ig.accessToken, req.query.cursor || '')
    if (data.error) return res.status(400).json({ error: data.error.message })
    const nextCursor = data.paging && data.paging.cursors && data.paging.next
      ? data.paging.cursors.after : null
    res.json({ connected: true, media: data.data || [], nextCursor })
  } catch (e) { res.status(500).json({ error: e.message }) }
})

// ── 版面規劃：暫存「準備發布」的房源順序（property id 陣列）────────
router.get('/admin/api/social/ig/plan', async (req, res) => {
  const auth = await resolveRole(req.query.key)
  if (!auth) return res.status(401).json({ error: 'unauthorized' })
  try {
    const config = await getConfig(auth)
    res.json({ plan: (config.instagram && config.instagram.plan) || [] })
  } catch (e) { res.status(500).json({ error: e.message }) }
})

router.post('/admin/api/social/ig/plan', express.json(), async (req, res) => {
  const auth = await resolveRole(req.query.key)
  if (!auth) return res.status(401).json({ error: 'unauthorized' })
  try {
    const plan = Array.isArray(req.body.plan) ? req.body.plan.map(String).slice(0, 60) : []
    const config = await getConfig(auth)
    config.instagram = config.instagram || {}
    config.instagram.plan = plan
    await saveConfig(auth, config)
    res.json({ ok: true, plan })
  } catch (e) { res.status(500).json({ error: e.message }) }
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

// 一次性票券：OAuth 彈窗是頁面導向（無法帶 header），改用短效單次票券換金鑰，
// 避免把後台金鑰直接放進彈窗網址。前端先以 header 取得 ticket，再用 ?ticket= 開窗。
const oauthTickets = new Map()
router.post('/admin/api/social/oauth-ticket', async (req, res) => {
  const auth = await resolveRole(req.query.key)
  if (!auth) return res.status(401).json({ error: 'unauthorized' })
  const ticket = require('crypto').randomBytes(18).toString('hex')
  oauthTickets.set(ticket, { key: req.query.key, expires: Date.now() + 2 * 60 * 1000 })
  for (const [t, v] of oauthTickets) if (v.expires < Date.now()) oauthTickets.delete(t)
  res.json({ ticket })
})
// 從 ticket 換回金鑰（單次、用後即焚）；沒帶 ticket 時相容舊的 ?key=
function keyFromTicket(req) {
  const t = req.query.ticket
  if (!t) return req.query.key
  const entry = oauthTickets.get(t)
  if (!entry || entry.expires < Date.now()) { oauthTickets.delete(t); return null }
  oauthTickets.delete(t)
  return entry.key
}

function publicBase(req) {
  const host = req.get('host')
  const proto = /localhost|127\.0\.0\.1/.test(host) ? 'http' : 'https'
  return `${proto}://${host}`
}
function redirectUri(req) {
  return process.env.IG_REDIRECT_URI || `${publicBase(req)}/admin/api/social/ig/callback`
}
function fbRedirectUri(req) {
  return process.env.FB_REDIRECT_URI || `${publicBase(req)}/admin/api/social/fb/callback`
}

function popupClose(message) {
  return `<!doctype html><meta charset="utf-8"><body style="font-family:sans-serif;text-align:center;padding:40px;color:#444;">
    <p>${message}</p><p style="color:#999;font-size:13px;">這個視窗即將自動關閉…</p>
    <script>setTimeout(function(){ window.close() }, 1800)</script></body>`
}

router.get('/admin/api/social/ig/connect', async (req, res) => {
  const key = keyFromTicket(req)
  const auth = await resolveRole(key)
  if (!auth) return res.status(401).send(popupClose('授權失敗：登入狀態無效，請重新登入後台。'))
  if (!IG_APP_ID || !IG_APP_SECRET) {
    return res.status(500).send(popupClose('系統尚未設定 Instagram 應用程式（IG_APP_ID / IG_APP_SECRET），請聯絡管理員。'))
  }
  const state = makeState(key)
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

// ── Facebook OAuth（連結粉專，一鍵自動發文）─────────────────────────
const FB_APP_ID = process.env.FB_APP_ID
const FB_APP_SECRET = process.env.FB_APP_SECRET

router.get('/admin/api/social/fb/connect', async (req, res) => {
  const key = keyFromTicket(req)
  const auth = await resolveRole(key)
  if (!auth) return res.status(401).send(popupClose('授權失敗：登入狀態無效，請重新登入後台。'))
  if (!FB_APP_ID || !FB_APP_SECRET) {
    return res.status(500).send(popupClose('系統尚未設定 Facebook 應用程式（FB_APP_ID / FB_APP_SECRET），請聯絡管理員。'))
  }
  const state = makeState(key)
  const scope = 'pages_show_list,pages_manage_posts,pages_read_engagement'
  const url = 'https://www.facebook.com/v21.0/dialog/oauth'
    + '?client_id=' + encodeURIComponent(FB_APP_ID)
    + '&redirect_uri=' + encodeURIComponent(fbRedirectUri(req))
    + '&response_type=code'
    + '&scope=' + encodeURIComponent(scope)
    + '&state=' + state
  res.redirect(url)
})

router.get('/admin/api/social/fb/callback', async (req, res) => {
  const { code, state, error, error_description } = req.query
  if (error) return res.send(popupClose('授權未完成：' + (error_description || error)))
  const entry = state && oauthStates.get(state)
  if (!entry || entry.expires < Date.now()) {
    return res.status(400).send(popupClose('授權連結已失效，請回後台重新點「連結 Facebook 粉專」。'))
  }
  oauthStates.delete(state)
  const auth = await resolveRole(entry.key)
  if (!auth) return res.status(401).send(popupClose('授權失敗：登入狀態無效。'))

  try {
    // 1) code 換短期 user token
    const tokenUrl = `${FB_API_BASE}/oauth/access_token`
      + '?client_id=' + encodeURIComponent(FB_APP_ID)
      + '&client_secret=' + encodeURIComponent(FB_APP_SECRET)
      + '&redirect_uri=' + encodeURIComponent(fbRedirectUri(req))
      + '&code=' + encodeURIComponent(String(code))
    const shortData = await (await fetch(tokenUrl)).json()
    if (!shortData.access_token) throw new Error(shortData.error?.message || JSON.stringify(shortData))

    // 2) 換長期 user token（約 60 天），連帶讓粉專 token 也長期
    const longUrl = `${FB_API_BASE}/oauth/access_token`
      + '?grant_type=fb_exchange_token'
      + '&client_id=' + encodeURIComponent(FB_APP_ID)
      + '&client_secret=' + encodeURIComponent(FB_APP_SECRET)
      + '&fb_exchange_token=' + encodeURIComponent(shortData.access_token)
    const longData = await (await fetch(longUrl)).json()
    const userToken = longData.access_token || shortData.access_token

    // 3) 取得使用者管理的粉專與各自的 Page Token
    const pagesData = await (await fetch(`${FB_API_BASE}/me/accounts?fields=id,name,access_token&access_token=${encodeURIComponent(userToken)}`)).json()
    if (pagesData.error) throw new Error(pagesData.error.message)
    const pages = (pagesData.data || []).map(p => ({ id: p.id, name: p.name, token: p.access_token }))
    if (!pages.length) throw new Error('找不到你管理的粉專，請確認你是該粉專的管理員。')

    // 4) 存進設定，預設選第一個粉專
    const config = await getConfig(auth)
    config.facebook = config.facebook || {}
    config.facebook.pages = pages
    if (!pages.some(p => p.id === config.facebook.pageId)) config.facebook.pageId = pages[0].id
    await saveConfig(auth, config)

    res.send(popupClose('✅ Facebook 粉專連結成功！共 ' + pages.length + ' 個粉專。'))
  } catch (e) {
    res.status(500).send(popupClose('連結失敗：' + e.message))
  }
})

// 切換要發布的粉專
router.post('/admin/api/social/fb/page', express.json(), async (req, res) => {
  const auth = await resolveRole(req.query.key)
  if (!auth) return res.status(401).json({ error: 'unauthorized' })
  try {
    const pageId = String(req.body.pageId || '')
    const config = await getConfig(auth)
    config.facebook = config.facebook || {}
    if (!(config.facebook.pages || []).some(p => p.id === pageId)) {
      return res.status(400).json({ error: '找不到此粉專' })
    }
    config.facebook.pageId = pageId
    await saveConfig(auth, config)
    res.json({ ok: true })
  } catch (e) { res.status(500).json({ error: e.message }) }
})

// ── IG 文案解析：正則 fallback ───────────────────────────────────
function parseIgCaption(text) {
  const r = {}
  // 月租金
  const pm = text.match(/月租[金]?\s*[：:\$＄]*\s*\$?\s*([\d,]+)|([\d,]+)\s*[元\/]\s*月|\$\s*([\d,]+)/)
  if (pm) { const n = (pm[1]||pm[2]||pm[3]||'').replace(/,/g,''); if (n) r.price = parseInt(n) }
  // 坪數
  const sm = text.match(/([\d.]+)\s*坪/)
  if (sm) r.size = parseFloat(sm[1])
  // 行政區（台中）
  const districts = ['中區','東區','西區','南區','北區','西屯區','南屯區','北屯區','豐原區','大里區','太平區','清水區','沙鹿區','梧棲區','烏日區','大甲區','東勢區','大肚區','神岡區','潭子區','外埔區','后里區','龍井區','霧峰區','石岡區','新社區','和平區','大安區','苑裡區']
  for (const d of districts) { if (text.includes(d)) { r.district = d; break } }
  // 縣市
  const cm = text.match(/(台中|台北|新北|桃園|台南|高雄|新竹|苗栗|彰化|南投|嘉義|屏東)/)
  if (cm) r.city = cm[1] + (cm[0].endsWith('市')||cm[0].endsWith('縣') ? '' : '市')
  // 類型（SUITE=套房, ROOM=雅房, WHOLE_FLOOR=整層住家, SHARED_SUITE=分租套房）
  if (/分租套房/.test(text)) r.type = 'SHARED_SUITE'
  else if (/雅房/.test(text)) r.type = 'ROOM'
  else if (/整層|整棟|公寓|透天/.test(text)) r.type = 'WHOLE_FLOOR'
  else if (/套房/.test(text)) r.type = 'SUITE'
  // 押金
  const dm = text.match(/押[金]?\s*(一|兩|三|四|五|[\d]+)\s*個月/)
  if (dm) r.deposit = dm[1] + '個月'
  // 設備
  const amenities = ['冷氣','冷暖氣','冰箱','洗衣機','熱水器','網路','第四台','電視','瓦斯爐','微波爐','烘衣機','床組','書桌','衣櫃','獨立衛浴']
  r.amenities = amenities.filter(k => text.includes(k))
  // 標籤
  const tags = ['近捷運','近公車','近學校','含水費','含電費','含管理費','含車位','機車位','汽車位','可養寵物','不養寵物','女性限定','男性限定','頂樓加蓋']
  r.tags = tags.filter(k => text.includes(k))
  return r
}

// ── IG 文案 AI 解析端點 ──────────────────────────────────────────
router.post('/admin/api/social/ig/parse-caption', express.json(), async (req, res) => {
  const auth = await resolveRole(req.query.key)
  if (!auth) return res.status(401).json({ error: 'unauthorized' })

  const caption = String(req.body.caption || '').trim()
  if (!caption) return res.json({ parsed: {} })

  if (process.env.ANTHROPIC_API_KEY) {
    try {
      const resp = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': process.env.ANTHROPIC_API_KEY,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model: 'claude-haiku-4-5-20251001',
          max_tokens: 700,
          messages: [{
            role: 'user',
            content: `從以下 Instagram 租屋貼文萃取房源資訊，以 JSON 格式回傳，不要加說明或 markdown。

文案：
"""
${caption.slice(0, 2000)}
"""

欄位（無法判斷填 null）：
- title: string 房源標題（10-20字，簡潔精確，無法判斷時填 null）
- price: number 月租金（純數字）
- size: number 坪數（純數字）
- type: "SUITE"|"ROOM"|"WHOLE_FLOOR"|"SHARED_SUITE"（SUITE=套房, ROOM=雅房, WHOLE_FLOOR=整層住家/整層/公寓/透天, SHARED_SUITE=分租套房）
- city: string 縣市（例"台中市"，沒提就填"台中市"）
- district: string 行政區（例"北區"）
- address: string 路名或地址（沒有填 null）
- deposit: string 押金（例"兩個月"，沒提填 null）
- amenities: string[] 從以下選符合的：冷氣、冷暖氣、冰箱、洗衣機、熱水器、網路、第四台、電視、瓦斯爐、微波爐、烘衣機、床組、書桌、衣櫃、獨立衛浴
- tags: string[] 從以下選符合的，也可自訂重要特色：近捷運、近公車、近學校、含水費、含電費、含管理費、含車位、機車位、汽車位、可養寵物、不養寵物、女性限定、男性限定、頂樓加蓋

只回傳 JSON。`,
          }],
        }),
      })
      if (resp.ok) {
        const data = await resp.json()
        const text = (data.content?.[0]?.text || '').trim().replace(/^```(?:json)?\n?|\n?```$/g, '')
        return res.json({ parsed: JSON.parse(text), source: 'ai' })
      }
    } catch (_) {}
  }

  res.json({ parsed: parseIgCaption(caption), source: 'regex' })
})

// ── IG 匯入：把 IG 貼文照片建立為新房源 ────────────────────────────
router.post('/admin/api/social/ig/import-property', express.json(), async (req, res) => {
  const auth = await resolveRole(req.query.key)
  if (!auth) return res.status(401).json({ error: 'unauthorized' })

  const { title, price, type, city, district, address, size, deposit, description, imageUrls, status, ownerId, amenities, tags } = req.body
  if (!title || !price) return res.status(400).json({ error: 'title 和 price 為必填' })

  const targetOwnerId = auth.role === 'landlord' ? auth.landlordId : (ownerId || null)
  if (!targetOwnerId) return res.status(400).json({ error: '請指定房東 (ownerId)' })

  // 嘗試把 IG 圖片搬到 Cloudinary，避免 IG URL 過期；失敗時直接用原始 URL
  let hostedUrls = (imageUrls || []).slice(0, 10).filter(u => typeof u === 'string' && u.startsWith('https://'))
  try {
    const cloudinary = require('cloudinary').v2
    hostedUrls = await Promise.all(
      hostedUrls.map(url =>
        cloudinary.uploader.upload(url, { folder: 'xiaowo-ig-import' })
          .then(r => r.secure_url)
          .catch(() => url)
      )
    )
  } catch (_) {}

  const adminUser = await prisma.user.upsert({
    where: { email: 'admin@xiaowo.tw' },
    update: {},
    create: { email: 'admin@xiaowo.tw', name: '小蝸出租', handle: 'xiaowo', role: 'LANDLORD', verified: true },
  })

  const property = await prisma.property.create({
    data: {
      landlordId: adminUser.id,
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
      images: { create: hostedUrls.map((url, i) => ({ url, order: i, isCover: i === 0 })) },
    },
  })

  // 寫入設備與標籤
  if (Array.isArray(amenities) && amenities.length) {
    await prisma.propertyAmenity.createMany({
      data: amenities.map(name => ({ propertyId: property.id, name })),
      skipDuplicates: true,
    })
  }
  if (Array.isArray(tags) && tags.length) {
    await prisma.propertyTag.createMany({
      data: tags.map(name => ({ propertyId: property.id, name })),
      skipDuplicates: true,
    })
  }

  await revalidateSite(['/listings', `/site/${targetOwnerId}`, `/property/${property.id}`])
  res.json({ ok: true, propertyId: property.id, title: property.title })
})

module.exports = router
