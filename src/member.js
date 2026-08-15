// src/member.js — 會員中心（第三方登入 SSO 橋接 + 租客會員區）
// 前站（xiaowo-rental / NextAuth：Google / LINE / Facebook）登入後，
// 以 SSO_SHARED_SECRET 簽發一次性票券並導向此處；驗證後建立會員 session，
// 進入租客會員中心（我的收藏／客服等）。此 session 與後台管理員 session 完全獨立，
// 不具任何 /admin 管理權限。
const express = require('express')
const path = require('path')
const crypto = require('crypto')
const prisma = require('./db')

const router = express.Router()

const MEMBER_COOKIE = 'xiaowo_member'
const MEMBER_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000 // 會員登入保留 30 天

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
    res.json({ ok: true, user, favCount })
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

// GET /member — 會員中心頁面
router.get('/member', (_req, res) => {
  res.sendFile(path.join(__dirname, 'member/views/member.html'))
})

module.exports = router
