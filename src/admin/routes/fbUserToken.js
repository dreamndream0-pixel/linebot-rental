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

function inviteSecret() {
  return process.env.FB_USER_LINK_SECRET || process.env.ADMIN_SESSION_SECRET || process.env.ADMIN_KEY || FB_APP_SECRET || 'xiaowo-fb-user-link'
}

function signInvite(payload) {
  return crypto.createHmac('sha256', inviteSecret()).update(payload).digest('base64url')
}

function makeInvite(ownerType, ownerId) {
  const payload = Buffer.from(JSON.stringify({ ownerType, ownerId })).toString('base64url')
  return `${payload}.${signInvite(payload)}`
}

function verifyInvite(token) {
  const [payload, sig] = String(token || '').split('.')
  if (!payload || !sig || signInvite(payload) !== sig) return null
  try {
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'))
    if (!data.ownerType || !data.ownerId) return null
    return data
  } catch (_) {
    return null
  }
}

async function ownerLabel(ownerType, ownerId) {
  if (ownerType === 'SUPER') return '總管理員'
  const landlord = await prisma.landlord.findUnique({ where: { id: ownerId }, select: { name: true, email: true, isActive: true } })
  if (!landlord || !landlord.isActive) return null
  return landlord.name || landlord.email || ownerId
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

function expose(row) {
  const data = mask(row)
  if (row?.userToken) data.userToken = row.userToken
  return data
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

router.get('/admin/api/fb-user-token/links', async (req, res) => {
  const auth = await resolveRole(req.query.key)
  if (!auth) return res.status(401).json({ error: 'unauthorized' })
  try {
    await ensureTable()
    if (auth.role === 'super') {
      const [landlords, rows] = await Promise.all([
        prisma.landlord.findMany({
          where: { isActive: true },
          orderBy: { createdAt: 'desc' },
          select: { id: true, name: true, email: true },
        }),
        prisma.$queryRawUnsafe(`SELECT * FROM fb_user_auth_tokens WHERE "ownerType" = 'LANDLORD'`),
      ])
      const byOwner = new Map(rows.map(r => [r.ownerId, r]))
      return res.json({
        items: landlords.map(l => ({
          ownerType: 'LANDLORD',
          ownerId: l.id,
          name: l.name,
          email: l.email,
          authUrl: `${publicBase(req)}/fb-user-auth/${makeInvite('LANDLORD', l.id)}`,
          token: expose(byOwner.get(l.id)),
        })),
      })
    }
    const saved = await getSaved(auth)
    res.json({
      items: [{
        ownerType: 'LANDLORD',
        ownerId: auth.landlordId,
        name: auth.label,
        email: '',
        authUrl: `${publicBase(req)}/fb-user-auth/${makeInvite('LANDLORD', auth.landlordId)}`,
        token: expose(saved),
      }],
    })
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

router.get('/fb-user-auth/:invite', async (req, res) => {
  const invite = verifyInvite(req.params.invite)
  if (!invite) return res.status(400).send('授權連結無效')
  const label = await ownerLabel(invite.ownerType, invite.ownerId)
  if (!label) return res.status(404).send('找不到可用房東')
  const connectUrl = `/admin/api/fb-user-token/public-connect?invite=${encodeURIComponent(req.params.invite)}`
  res.send(`<!doctype html><html lang="zh-TW"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Facebook 授權</title>
    <style>body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;background:#f7f5f1;margin:0;color:#1f2a24}.card{max-width:520px;margin:56px auto;background:#fff;border:1px solid #e5e0d5;border-radius:18px;padding:26px;box-shadow:0 12px 32px rgba(30,38,32,.08)}a{display:inline-block;background:#1877f2;color:#fff;text-decoration:none;border-radius:12px;padding:13px 18px;font-weight:700}p{line-height:1.7;color:#666}</style></head>
    <body><div class="card"><h1>Facebook 授權</h1><p>授權對象：<strong>${String(label).replace(/</g, '&lt;')}</strong></p><p>請點下方按鈕登入 Facebook 並同意授權。完成後系統會保存你的 Facebook 個人授權，用於後續重抓粉專清單。</p><a href="${connectUrl}">授權 Facebook</a></div></body></html>`)
})

router.get('/admin/api/fb-user-token/public-connect', async (req, res) => {
  const invite = verifyInvite(req.query.invite)
  if (!invite) return res.status(400).send(popupClose('授權連結無效。'))
  const label = await ownerLabel(invite.ownerType, invite.ownerId)
  if (!label) return res.status(404).send(popupClose('找不到可用房東。'))
  if (!FB_APP_ID || !FB_APP_SECRET) return res.status(500).send(popupClose('系統尚未設定 FB_APP_ID / FB_APP_SECRET。'))

  const state = crypto.randomBytes(16).toString('hex')
  states.set(state, { ownerType: invite.ownerType, ownerId: invite.ownerId, expires: Date.now() + 10 * 60 * 1000 })
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
  let owner
  if (entry.key) {
    const auth = await resolveRole(entry.key)
    if (!auth) return res.status(401).send(popupClose('授權失敗：登入狀態無效。'))
    owner = ownerKey(auth)
  } else {
    owner = { ownerType: entry.ownerType, ownerId: entry.ownerId }
    if (!(await ownerLabel(owner.ownerType, owner.ownerId))) return res.status(404).send(popupClose('找不到可用房東。'))
  }

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
      owner.ownerType,
      owner.ownerId,
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
