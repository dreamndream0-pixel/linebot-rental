// src/admin/routes/tenant.js
const express = require('express')
const router = express.Router()
const { Client } = require('@line/bot-sdk')
const prisma = require('../../db')
const { resolveRole, ownsRecord } = require('../helpers')

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

// 取得某租客對應 Bot 的 LINE Client（房東 Bot 優先，否則主 Bot）
async function lineClientForTenant(tenant) {
  if (tenant.landlordId) {
    const landlord = await prisma.landlord.findUnique({
      where: { id: tenant.landlordId },
      select: { lineChannelToken: true, lineChannelSecret: true },
    })
    if (landlord?.lineChannelToken) {
      return new Client({ channelAccessToken: landlord.lineChannelToken, channelSecret: landlord.lineChannelSecret || '' })
    }
    return null
  }
  if (process.env.LINE_CHANNEL_ACCESS_TOKEN) {
    return new Client({ channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN, channelSecret: process.env.LINE_CHANNEL_SECRET || '' })
  }
  return null
}

// 重新向 LINE 抓取單一租客的名稱／頭像（回填未命名／無頭貼者）
router.post('/admin/api/tenant/:id/refresh-profile', express.json(), async (req, res) => {
  const auth = await resolveRole(req.query.key)
  if (!auth) return res.status(401).json({ error: 'unauthorized' })

  const tenant = await prisma.tenant.findUnique({ where: { id: req.params.id } })
  if (!tenant) return res.status(404).json({ error: 'not found' })
  if (!ownsRecord(auth, tenant)) return res.status(403).json({ error: 'forbidden' })

  const client = await lineClientForTenant(tenant)
  if (!client) return res.status(400).json({ error: '此租客對應的 LINE Bot 尚未設定 Token' })

  try {
    const profile = await client.getProfile(tenant.lineUserId)
    const updated = await prisma.tenant.update({
      where: { id: tenant.id },
      data: {
        name: profile.displayName || tenant.name,
        avatarUrl: profile.pictureUrl || tenant.avatarUrl,
        statusMessage: profile.statusMessage || tenant.statusMessage,
      },
    })
    res.json({ ok: true, tenant: updated })
  } catch (e) {
    // getProfile 失敗常見原因：用戶已封鎖/未加好友、或 Token 失效
    res.status(502).json({ error: 'LINE 讀取失敗：' + e.message + '（用戶可能已封鎖官方帳號，或 Bot Token 需重設）' })
  }
})

// 批次回填：把名下所有「未命名」租客重新抓一次（有延遲避免觸發速率限制）
router.post('/admin/api/tenants/refresh-unnamed', express.json(), async (req, res) => {
  const auth = await resolveRole(req.query.key)
  if (!auth) return res.status(401).json({ error: 'unauthorized' })

  const where = { OR: [{ name: null }, { name: '' }] }
  if (auth.role === 'landlord') where.landlordId = auth.landlordId
  const targets = await prisma.tenant.findMany({ where, take: 200 })

  let updated = 0, failed = 0
  for (const tenant of targets) {
    const client = await lineClientForTenant(tenant)
    if (!client) { failed++; continue }
    try {
      const profile = await client.getProfile(tenant.lineUserId)
      if (profile.displayName) {
        await prisma.tenant.update({
          where: { id: tenant.id },
          data: {
            name: profile.displayName,
            avatarUrl: profile.pictureUrl || tenant.avatarUrl,
            statusMessage: profile.statusMessage || tenant.statusMessage,
          },
        })
        updated++
      }
    } catch (_) { failed++ }
    await new Promise(r => setTimeout(r, 120))
  }
  res.json({ ok: true, total: targets.length, updated, failed })
})

module.exports = router
