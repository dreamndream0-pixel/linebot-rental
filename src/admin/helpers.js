// src/admin/helpers.js — 共用工具函式
const { Client } = require('@line/bot-sdk')
const cloudinary = require('cloudinary').v2
const prisma = require('../db')

const ADMIN_KEY = process.env.ADMIN_KEY

// ── 權限解析 ─────────────────────────────────────────────────────
async function resolveRole(key) {
  if (!key || !ADMIN_KEY) return null
  if (key === ADMIN_KEY) return { role: 'super', landlordId: null, label: '總管理員' }

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

module.exports = { resolveRole, landlordFilter, ownsRecord, revalidateSite, deleteCloudinaryImages, notifyBookingTenant }
