// src/admin/helpers.js — 共用工具函式
const { Client } = require('@line/bot-sdk')
const cloudinary = require('cloudinary').v2
const crypto = require('crypto')
const prisma = require('../db')

const ADMIN_KEY = process.env.ADMIN_KEY
const SESSION_COOKIE_NAME = 'xiaowo_admin_session'
const SESSION_MAX_AGE_MS = 8 * 60 * 60 * 1000

function sessionSecret() {
  return process.env.ADMIN_SESSION_SECRET || ADMIN_KEY || 'xiaowo-admin-session'
}

function b64url(input) {
  return Buffer.from(input).toString('base64url')
}

function signPayload(payload) {
  return crypto.createHmac('sha256', sessionSecret()).update(payload).digest('base64url')
}

function hashAdminKey(key) {
  return crypto.createHmac('sha256', sessionSecret()).update(String(key || '')).digest('hex')
}

function makeSessionToken(auth) {
  const payload = b64url(JSON.stringify({
    role: auth.role,
    landlordId: auth.landlordId || null,
    label: auth.label || '',
    source: auth.source || null,
    exp: Date.now() + SESSION_MAX_AGE_MS,
    nonce: crypto.randomBytes(12).toString('base64url'),
  }))
  return `${payload}.${signPayload(payload)}`
}

async function verifySessionToken(token) {
  if (!token || !token.includes('.')) return null
  const [payload, sig] = token.split('.')
  if (!payload || !sig || signPayload(payload) !== sig) return null
  let data
  try {
    data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'))
  } catch (_) {
    return null
  }
  if (!data.exp || Date.now() > data.exp) return null
  if (data.role === 'super') return { role: 'super', landlordId: null, label: '總管理員' }
  if (data.role === 'landlord' && data.landlordId) {
    try {
      const landlord = await prisma.landlord.findUnique({ where: { id: data.landlordId } })
      if (landlord && landlord.isActive) {
        return { role: 'landlord', landlordId: landlord.id, label: landlord.name, source: landlord.source }
      }
    } catch (e) {
      console.error('verifySessionToken 查詢房東失敗:', e.message)
    }
  }
  return null
}

async function createAdminSession(key) {
  const auth = await resolveRole(key)
  if (!auth) return null
  return { auth, token: makeSessionToken(auth), maxAgeMs: SESSION_MAX_AGE_MS }
}

// ── 權限解析（含 60 秒記憶體快取，避免每個 API 請求都打 DB）────────
const _roleCache = new Map() // key → { auth, exp }
const ROLE_CACHE_TTL = 60_000

async function resolveRole(key) {
  if (!key || !ADMIN_KEY) return null
  if (key.startsWith('SESSION:')) return verifySessionToken(key.slice('SESSION:'.length))
  if (key === ADMIN_KEY) return { role: 'super', landlordId: null, label: '總管理員' }

  const now = Date.now()
  const cached = _roleCache.get(key)
  if (cached && cached.exp > now) return cached.auth

  try {
    const keyHash = hashAdminKey(key)
    let landlord = null
    try {
      landlord = await prisma.landlord.findFirst({ where: { adminKeyHash: keyHash } })
    } catch (e) {
      console.error('adminKeyHash 查詢失敗，改用舊欄位嘗試:', e.message)
    }
    if (!landlord) {
      try {
        landlord = await prisma.landlord.findUnique({ where: { adminKey: key } })
      } catch (e) {
        console.error('adminKey 舊欄位查詢失敗:', e.message)
      }
      if (landlord) {
        await prisma.landlord.update({
          where: { id: landlord.id },
          data: { adminKeyHash: keyHash, adminKey: null },
        }).catch(e => console.error('adminKey 遷移失敗:', e.message))
      }
    }
    if (landlord && landlord.isActive) {
      const auth = { role: 'landlord', landlordId: landlord.id, label: landlord.name, source: landlord.source }
      _roleCache.set(key, { auth, exp: now + ROLE_CACHE_TTL })
      return auth
    }
  } catch (e) {
    console.error('resolveRole 查詢房東失敗:', e.message)
  }
  return null
}

function landlordFilter(auth) {
  return auth.role === 'super' ? {} : { landlordId: auth.landlordId }
}

function ownsRecord(auth, record) {
  if (auth.role === 'super') return true
  return record && record.landlordId === auth.landlordId
}

// ── ISR 重新驗證 ─────────────────────────────────────────────────
async function revalidateSite(paths, tags = []) {
  const siteUrl = process.env.SITE_URL
  const secret = process.env.REVALIDATE_SECRET
  if (!siteUrl || !secret) return
  try {
    await fetch(`${siteUrl}/api/revalidate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      // 每次更新房源時，同步清除標籤快取
      body: JSON.stringify({ secret, paths, tags: ['all-tags', ...tags] }),
    })
  } catch (_) {}
}

// ── Cloudinary 清除 ──────────────────────────────────────────────
function cloudinaryPublicId(url) {
  try {
    const u = new URL(url)
    const parts = u.pathname.split('/')
    const uploadIdx = parts.indexOf('upload')
    if (uploadIdx === -1) return null
    const afterUpload = parts.slice(uploadIdx + 1)
    if (afterUpload[0]?.startsWith('v')) afterUpload.shift()
    return afterUpload.join('/').replace(/\.[^.]+$/, '')
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

// ── 預約狀態通知租客 ─────────────────────────────────────────────
async function notifyBookingTenant(booking, status, rejectReason = null) {
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
        config = { channelAccessToken: landlord.lineChannelToken, channelSecret: landlord.lineChannelSecret || '' }
      }
    } else if (process.env.LINE_CHANNEL_ACCESS_TOKEN) {
      config = { channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN, channelSecret: process.env.LINE_CHANNEL_SECRET || '' }
    }
  } catch (e) {
    console.error('讀取預約通知 Bot 設定失敗:', e.message)
    return { notified: false, reason: 'bot-config-failed' }
  }

  if (!config) return { notified: false, reason: 'bot-not-configured' }

  const date = new Date(booking.date).toLocaleDateString('zh-TW', { timeZone: 'Asia/Taipei' })
  const rejectNote = rejectReason ? `\n\n📝 房東回覆：${rejectReason}` : ''
  const messages = {
    CONFIRMED: `✅ 看房預約已確認\n\n🏠 ${booking.property.title}\n📅 ${date} ${booking.timeslot}\n\n請準時抵達，如需調整請直接聯絡房東。`,
    CANCELLED: `❌ 看房預約已取消\n\n🏠 ${booking.property.title}\n📅 ${date} ${booking.timeslot}\n\n如需重新預約，請回到選單再次選擇。`,
    REJECTED: `😢 看房預約未能成立\n\n🏠 ${booking.property.title}\n📅 ${date} ${booking.timeslot}${rejectNote}\n\n歡迎回到選單改約其他時段，謝謝您！`,
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

module.exports = {
  resolveRole,
  landlordFilter,
  ownsRecord,
  revalidateSite,
  deleteCloudinaryImages,
  notifyBookingTenant,
  createAdminSession,
  hashAdminKey,
  SESSION_COOKIE_NAME,
  SESSION_MAX_AGE_MS,
}
