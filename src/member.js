// src/member.js — 會員中心（第三方登入 SSO 橋接 + 租客會員區）
// 前站（xiaowo-rental / NextAuth：Google / LINE / Facebook）登入後，
// 以 SSO_SHARED_SECRET 簽發一次性票券並導向此處；驗證後建立會員 session，
// 進入租客會員中心（我的收藏／客服等）。此 session 與後台管理員 session 完全獨立，
// 不具任何 /admin 管理權限。
const express = require('express')
const path = require('path')
const crypto = require('crypto')
const prisma = require('./db')
const { createAdminSession, createLandlordSessionById, hashAdminKey, SESSION_COOKIE_NAME, SESSION_MAX_AGE_MS } = require('./admin/helpers')

const router = express.Router()

const MEMBER_COOKIE = 'xiaowo_member'
const MEMBER_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000 // 會員登入保留 30 天

// 總管理員 email 允許清單（環境變數 SUPER_ADMIN_EMAILS，逗號分隔）。
// 名單內的 email 以社群登入後，可切換進「總管理員」後台。
function isSuperEmail(email) {
  if (!email) return false
  const list = String(process.env.SUPER_ADMIN_EMAILS || '')
    .split(',').map(s => s.trim().toLowerCase()).filter(Boolean)
  return list.includes(String(email).trim().toLowerCase())
}

// 以會員 email 找出對應且啟用中的房東帳號（房東模式的授權依據）
async function findLandlordByEmail(email) {
  if (!email) return null
  try {
    return await prisma.landlord.findFirst({
      where: { email: { equals: email, mode: 'insensitive' }, isActive: true },
      select: { id: true, name: true },
    })
  } catch (e) {
    console.error('findLandlordByEmail 失敗:', e.message)
    return null
  }
}

// 自動以會員資料建立房東帳號（社群登入者確認開通房東後台時使用）
async function autoCreateLandlord(user) {
  if (!user || !user.email) return null
  const key = 'LL-' + crypto.randomBytes(9).toString('base64url')
  const pwd = crypto.randomBytes(12).toString('base64url')
  const passwordHash = crypto.createHash('sha256').update(pwd).digest('hex')
  try {
    return await prisma.landlord.create({
      data: {
        name: user.name || user.email,
        email: String(user.email).toLowerCase(),
        passwordHash,
        adminKey: null,
        adminKeyHash: hashAdminKey(key),
      },
      select: { id: true, name: true },
    })
  } catch (e) {
    // email 已存在（競態或大小寫差異）→ 直接取回既有房東
    if (e.code === 'P2002') return findLandlordByEmail(user.email)
    console.error('autoCreateLandlord 失敗:', e.message)
    return null
  }
}

function ssoSecret() {
  return process.env.SSO_SHARED_SECRET || ''
}

function b64url(obj) {
  return Buffer.from(JSON.stringify(obj)).toString('base64url')
}
function sign(payload, secret) {
  return crypto.createHmac('sha256', secret).update(payload).digest('base64url')
}
function makeToken(data, secret, maxAgeMs) {
  const payload = b64url({ ...data, exp: Date.now() + maxAgeMs })
  return `${payload}.${sign(payload, secret)}`
}
function verifyToken(token, secret) {
  if (!token || !secret || typeof token !== 'string' || !token.includes('.')) return null
  const [payload, sig] = token.split('.')
  if (!payload || !sig) return null
  const expected = sign(payload, secret)
  const a = Buffer.from(sig)
  const b = Buffer.from(expected)
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null
  let data
  try { data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) } catch { return null }
  if (!data.exp || Date.now() > data.exp) return null
  return data
}

function parseCookies(req) {
  return Object.fromEntries(String(req.headers.cookie || '')
    .split(';')
    .map(v => v.trim())
    .filter(Boolean)
    .map(v => {
      const idx = v.indexOf('=')
      return idx === -1 ? [v, ''] : [v.slice(0, idx), decodeURIComponent(v.slice(idx + 1))]
    }))
}

function cookieOptions(maxAgeSeconds) {
  const secure = process.env.NODE_ENV === 'production' ? '; Secure' : ''
  return `HttpOnly; Path=/member; Max-Age=${maxAgeSeconds}; SameSite=Lax${secure}`
}
function setMemberCookie(res, token) {
  res.setHeader('Set-Cookie', `${MEMBER_COOKIE}=${encodeURIComponent(token)}; ${cookieOptions(Math.floor(MEMBER_MAX_AGE_MS / 1000))}`)
}
function clearMemberCookie(res) {
  res.setHeader('Set-Cookie', `${MEMBER_COOKIE}=; ${cookieOptions(0)}`)
}

// 讀取目前會員 session（回傳 { uid } 或 null）
function currentMember(req) {
  const token = parseCookies(req)[MEMBER_COOKIE]
  return verifyToken(token, ssoSecret())
}

const FRONT_URL = () => (process.env.SITE_URL || 'https://xiaowo-rental.vercel.app').replace(/\/$/, '')

// GET /member/sso?token=... — 驗證前站簽發的一次性票券 → 建立會員 session
router.get('/member/sso', async (req, res) => {
  const secret = ssoSecret()
  if (!secret) return res.status(500).send('SSO_SHARED_SECRET 未設定')
  const data = verifyToken(req.query.token, secret)
  if (!data || !data.uid) {
    return res.redirect(`/member?err=sso`)
  }
  // 確認使用者存在（票券只帶 uid，資料一律以資料庫為準）
  let user = null
  try {
    user = await prisma.user.findUnique({ where: { id: data.uid }, select: { id: true } })
  } catch (e) {
    console.error('會員 SSO 查詢使用者失敗:', e.message)
  }
  if (!user) return res.redirect(`/member?err=nouser`)
  setMemberCookie(res, makeToken({ uid: user.id }, secret, MEMBER_MAX_AGE_MS))
  res.redirect('/member')
})

// POST /member/api/logout — 登出會員
router.post('/member/api/logout', (_req, res) => {
  clearMemberCookie(res)
  res.json({ ok: true })
})

// GET /member/api/me — 目前登入會員的基本資料
router.get('/member/api/me', async (req, res) => {
  const m = currentMember(req)
  if (!m) return res.status(401).json({ error: 'unauthorized', loginUrl: `${FRONT_URL()}/login?callbackUrl=/api/sso/linebot` })
  try {
    const user = await prisma.user.findUnique({
      where: { id: m.uid },
      select: { id: true, name: true, email: true, avatar: true, phone: true, createdAt: true },
    })
    if (!user) return res.status(401).json({ error: 'unauthorized' })
    const favCount = await prisma.favorite.count({ where: { userId: user.id } })
    const isSuper = isSuperEmail(user.email)
    const landlord = isSuper ? null : await findLandlordByEmail(user.email)
    const canManage = isSuper || !!landlord
    res.json({ ok: true, user, favCount, isLandlord: !!landlord, isSuper, canManage })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

// GET /member/api/favorites — 目前會員的收藏房源
router.get('/member/api/favorites', async (req, res) => {
  const m = currentMember(req)
  if (!m) return res.status(401).json({ error: 'unauthorized' })
  try {
    const favs = await prisma.favorite.findMany({
      where: { userId: m.uid },
      orderBy: { createdAt: 'desc' },
      include: {
        property: {
          select: {
            id: true, title: true, city: true, district: true, address: true,
            price: true, status: true, deletedAt: true,
            images: { orderBy: [{ isCover: 'desc' }, { order: 'asc' }], take: 1, select: { url: true } },
          },
        },
      },
    })
    const list = favs
      .filter(f => f.property && !f.property.deletedAt)
      .map(f => ({
        id: f.property.id,
        title: f.property.title,
        area: `${f.property.city || ''}${f.property.district || ''}`,
        price: f.property.price,
        status: f.property.status,
        image: f.property.images[0] ? f.property.images[0].url : null,
      }))
    res.json({ ok: true, list })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

// DELETE /member/api/favorites — 移除收藏
router.delete('/member/api/favorites', express.json(), async (req, res) => {
  const m = currentMember(req)
  if (!m) return res.status(401).json({ error: 'unauthorized' })
  const propertyId = String(req.body?.propertyId || '')
  if (!propertyId) return res.status(400).json({ error: 'propertyId 必填' })
  try {
    await prisma.favorite.deleteMany({ where: { userId: m.uid, propertyId } })
    res.json({ ok: true })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

// GET /member/api/history — 目前會員的瀏覽記錄（最近瀏覽的房源，去重、新到舊）
router.get('/member/api/history', async (req, res) => {
  const m = currentMember(req)
  if (!m) return res.status(401).json({ error: 'unauthorized' })
  try {
    const views = await prisma.propertyView.findMany({
      where: { userId: m.uid },
      orderBy: { viewedAt: 'desc' },
      take: 30,
    })
    const ids = views.map(v => v.propertyId)
    if (!ids.length) return res.json({ ok: true, list: [] })
    const props = await prisma.property.findMany({
      where: { id: { in: ids }, deletedAt: null },
      select: {
        id: true, title: true, city: true, district: true, price: true, status: true,
        images: { orderBy: [{ isCover: 'desc' }, { order: 'asc' }], take: 1, select: { url: true } },
      },
    })
    const byId = {}
    props.forEach(p => { byId[p.id] = p })
    const list = ids
      .map(id => byId[id])
      .filter(Boolean)
      .map(p => ({
        id: p.id,
        title: p.title,
        area: `${p.city || ''}${p.district || ''}`,
        price: p.price,
        status: p.status,
        image: p.images[0] ? p.images[0].url : null,
      }))
    res.json({ ok: true, list })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

// POST /member/api/switch-to-landlord — 房東模式：以 email 對應房東帳號 → 建立後台 session
// 會員身分已由 SSO 登入證明（掌握該社群帳號）；email 相符且房東帳號啟用中才放行。
router.post('/member/api/switch-to-landlord', async (req, res) => {
  const m = currentMember(req)
  if (!m) return res.status(401).json({ error: 'unauthorized' })
  let user = null
  try {
    user = await prisma.user.findUnique({ where: { id: m.uid }, select: { email: true, name: true } })
  } catch (e) {
    return res.status(500).json({ error: e.message })
  }
  const email = user && user.email
  let session = null
  if (isSuperEmail(email)) {
    // 總管理員 email 允許清單 → 建立總管理員 session
    if (!process.env.ADMIN_KEY) return res.status(500).json({ error: 'ADMIN_KEY 未設定' })
    session = await createAdminSession(process.env.ADMIN_KEY)
  } else {
    // 已是房東 → 進自己的後台；還不是房東 → 自動建立房東帳號後進入
    let landlord = await findLandlordByEmail(email)
    if (!landlord) landlord = await autoCreateLandlord(user)
    if (landlord) session = await createLandlordSessionById(landlord.id)
  }
  if (!session) return res.status(403).json({ error: 'not_landlord' })
  // 後台管理員 session cookie（Path=/admin，與 admin 端一致）
  const secure = process.env.NODE_ENV === 'production' ? '; Secure' : ''
  res.setHeader('Set-Cookie',
    `${SESSION_COOKIE_NAME}=${encodeURIComponent(session.token)}; HttpOnly; Path=/admin; Max-Age=${Math.floor(SESSION_MAX_AGE_MS / 1000)}; SameSite=Lax${secure}`)
  res.json({ ok: true, redirect: '/admin', name: session.name })
})

// GET /member — 會員中心頁面
router.get('/member', (_req, res) => {
  res.sendFile(path.join(__dirname, 'member/views/member.html'))
})

module.exports = router
