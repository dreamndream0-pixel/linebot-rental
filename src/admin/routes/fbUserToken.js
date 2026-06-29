const express = require('express')
const crypto = require('crypto')
const prisma = require('../../db')
const { resolveRole } = require('../helpers')

const router = express.Router()
const FB_API_BASE = 'https://graph.facebook.com/v21.0'
const FB_APP_ID = process.env.FB_APP_ID
const FB_APP_SECRET = process.env.FB_APP_SECRET

const tickets = new Map()
const states = new Map()

function publicBase(req) {
  const host = req.get('host')
  const proto = /localhost|127\.0\.0\.1/.test(host) ? 'http' : 'https'
  return `${proto}://${host}`
}

function redirectUri(req) {
  return process.env.FB_USER_REDIRECT_URI || `${publicBase(req)}/admin/api/fb-user-token/callback`
}

function ownerKey(auth) {
  return {
    ownerType: auth.role === 'super' ? 'SUPER' : 'LANDLORD',
    ownerId: auth.role === 'super' ? 'super' : auth.landlordId,
  }
}

async function ensureTable() {
  await prisma.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS fb_user_auth_tokens (
      id TEXT PRIMARY KEY,
      "ownerType" TEXT NOT NULL,
      "ownerId" TEXT NOT NULL,
      "fbUserId" TEXT,
      "fbName" TEXT,
      "userToken" TEXT NOT NULL,
      "tokenExpiresAt" TIMESTAMPTZ,
      "pagesJson" TEXT,
      "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `)
  await prisma.$executeRawUnsafe(`CREATE UNIQUE INDEX IF NOT EXISTS "fb_user_auth_tokens_owner_key" ON fb_user_auth_tokens ("ownerType", "ownerId")`)
}

function cleanup(map) {
  for (const [k, v] of map) if (v.expires < Date.now()) map.delete(k)
}

function popupClose(message) {
  const safeMessage = String(message || '').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  return `<!doctype html><meta charset="utf-8"><body style="font-family:sans-serif;text-align:center;padding:40px;color:#444;">
    <p>${safeMessage}</p><p style="color:#999;font-size:13px;">這個視窗即將自動關閉...</p>
    <script>
      if (window.opener) window.opener.postMessage({ type: 'fb-user-token-oauth-done' }, '*');
      setTimeout(function(){ window.close() }, 1500)
    </script></body>`
}

async function getSaved(auth) {
  await ensureTable()
  const o = ownerKey(auth)
  const rows = await prisma.$queryRawUnsafe(
    `SELECT * FROM fb_user_auth_tokens WHERE "ownerType" = $1 AND "ownerId" = $2 LIMIT 1`,
    o.ownerType,
    o.ownerId
  )
  return rows[0] || null
}

function mask(row) {
  if (!row) return { connected: false }
  let pages = []
  try { pages = row.pagesJson ? JSON.parse(row.pagesJson) : [] } catch (_) {}
  return {
    connected: true,
    fbUserId: row.fbUserId || '',
    fbName: row.fbName || '',
    tokenPreview: row.userToken ? `••••${row.userToken.slice(-4)}` : '',
    tokenExpiresAt: row.tokenExpiresAt || null,
    pages,
    updatedAt: row.updatedAt || null,
  }
}

async function fetchPages(userToken) {
  const pagesData = await (await fetch(`${FB_API_BASE}/me/accounts?fields=id,name&access_token=${encodeURIComponent(userToken)}`)).json()
  if (pagesData.error) throw new Error(pagesData.error.message)
  return (pagesData.data || []).map(p => ({ id: p.id, name: p.name }))
}

router.get('/admin/api/fb-user-token/status', async (req, res) => {
  const auth = await resolveRole(req.query.key)
  if (!auth) return res.status(401).json({ error: 'unauthorized' })
  try {
    res.json(mask(await getSaved(auth)))
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

router.post('/admin/api/fb-user-token/oauth-ticket', async (req, res) => {
  const auth = await resolveRole(req.query.key)
  if (!auth) return res.status(401).json({ error: 'unauthorized' })
  const ticket = crypto.randomBytes(18).toString('hex')
  tickets.set(ticket, { key: req.query.key, expires: Date.now() + 2 * 60 * 1000 })
  cleanup(tickets)
  res.json({ ticket })
})

router.get('/admin/api/fb-user-token/connect', async (req, res) => {
  const entry = tickets.get(req.query.ticket)
  if (!entry || entry.expires < Date.now()) {
    if (req.query.ticket) tickets.delete(req.query.ticket)
    return res.status(401).send(popupClose('授權連結已失效，請回頁面重新點擊。'))
  }
  tickets.delete(req.query.ticket)
  const auth = await resolveRole(entry.key)
  if (!auth) return res.status(401).send(popupClose('授權失敗：請先登入後台。'))
  if (!FB_APP_ID || !FB_APP_SECRET) return res.status(500).send(popupClose('系統尚未設定 FB_APP_ID / FB_APP_SECRET。'))

  const state = crypto.randomBytes(16).toString('hex')
  states.set(state, { key: entry.key, expires: Date.now() + 10 * 60 * 1000 })
  cleanup(states)
  const scope = 'pages_show_list,pages_read_engagement'
  const url = 'https://www.facebook.com/v21.0/dialog/oauth'
    + '?client_id=' + encodeURIComponent(FB_APP_ID)
    + '&redirect_uri=' + encodeURIComponent(redirectUri(req))
    + '&response_type=code'
    + '&scope=' + encodeURIComponent(scope)
    + '&state=' + state
  res.redirect(url)
})

router.get('/admin/api/fb-user-token/callback', async (req, res) => {
  const { code, state, error, error_description } = req.query
  if (error) return res.send(popupClose('授權未完成：' + (error_description || error)))
  const entry = state && states.get(state)
  if (!entry || entry.expires < Date.now()) {
    if (state) states.delete(state)
    return res.status(400).send(popupClose('授權連結已失效，請重新開始。'))
  }
  states.delete(state)
  const auth = await resolveRole(entry.key)
  if (!auth) return res.status(401).send(popupClose('授權失敗：登入狀態無效。'))

  try {
    await ensureTable()
    const shortUrl = `${FB_API_BASE}/oauth/access_token`
      + '?client_id=' + encodeURIComponent(FB_APP_ID)
      + '&client_secret=' + encodeURIComponent(FB_APP_SECRET)
      + '&redirect_uri=' + encodeURIComponent(redirectUri(req))
      + '&code=' + encodeURIComponent(String(code))
    const shortData = await (await fetch(shortUrl)).json()
    if (!shortData.access_token) throw new Error(shortData.error?.message || JSON.stringify(shortData))

    const longUrl = `${FB_API_BASE}/oauth/access_token`
      + '?grant_type=fb_exchange_token'
      + '&client_id=' + encodeURIComponent(FB_APP_ID)
      + '&client_secret=' + encodeURIComponent(FB_APP_SECRET)
      + '&fb_exchange_token=' + encodeURIComponent(shortData.access_token)
    const longData = await (await fetch(longUrl)).json()
    const userToken = longData.access_token || shortData.access_token
    const expiresIn = Number(longData.expires_in || shortData.expires_in || 0)
    const tokenExpiresAt = expiresIn ? new Date(Date.now() + expiresIn * 1000) : null

    const me = await (await fetch(`${FB_API_BASE}/me?fields=id,name&access_token=${encodeURIComponent(userToken)}`)).json()
    if (me.error) throw new Error(me.error.message)
    const pages = await fetchPages(userToken)
    const o = ownerKey(auth)
    await prisma.$executeRawUnsafe(
      `INSERT INTO fb_user_auth_tokens
        (id, "ownerType", "ownerId", "fbUserId", "fbName", "userToken", "tokenExpiresAt", "pagesJson", "createdAt", "updatedAt")
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW(), NOW())
       ON CONFLICT ("ownerType", "ownerId") DO UPDATE SET
        "fbUserId" = $4,
        "fbName" = $5,
        "userToken" = $6,
        "tokenExpiresAt" = $7,
        "pagesJson" = $8,
        "updatedAt" = NOW()`,
      crypto.randomBytes(12).toString('hex'),
      o.ownerType,
      o.ownerId,
      me.id || null,
      me.name || null,
      userToken,
      tokenExpiresAt,
      JSON.stringify(pages)
    )
    res.send(popupClose('Facebook 個人授權已保存。'))
  } catch (e) {
    res.status(500).send(popupClose('連結失敗：' + e.message))
  }
})

router.post('/admin/api/fb-user-token/refresh-pages', async (req, res) => {
  const auth = await resolveRole(req.query.key)
  if (!auth) return res.status(401).json({ error: 'unauthorized' })
  try {
    const saved = await getSaved(auth)
    if (!saved) return res.status(404).json({ error: '尚未保存 Facebook user token' })
    const pages = await fetchPages(saved.userToken)
    const o = ownerKey(auth)
    await prisma.$executeRawUnsafe(
      `UPDATE fb_user_auth_tokens SET "pagesJson" = $1, "updatedAt" = NOW() WHERE "ownerType" = $2 AND "ownerId" = $3`,
      JSON.stringify(pages),
      o.ownerType,
      o.ownerId
    )
    res.json({ ok: true, pages })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

router.post('/admin/api/fb-user-token/disconnect', async (req, res) => {
  const auth = await resolveRole(req.query.key)
  if (!auth) return res.status(401).json({ error: 'unauthorized' })
  try {
    await ensureTable()
    const o = ownerKey(auth)
    await prisma.$executeRawUnsafe(`DELETE FROM fb_user_auth_tokens WHERE "ownerType" = $1 AND "ownerId" = $2`, o.ownerType, o.ownerId)
    res.json({ ok: true })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

module.exports = router
