// src/admin/routes/contactNotify.js
// 接收來自 xiaowo 的內部通知，推送 LINE 訊息給管理員
const express = require('express')
const router = express.Router()
const { Client } = require('@line/bot-sdk')
const prisma = require('../../db')

router.post('/api/internal/contact-notify', express.json(), async (req, res) => {
  const { secret, text } = req.body
  const REVALIDATE_SECRET = process.env.REVALIDATE_SECRET

  if (!secret || secret !== REVALIDATE_SECRET) {
    return res.status(401).json({ error: 'unauthorized' })
  }
  if (!text) return res.status(400).json({ error: 'missing text' })

  res.json({ ok: true }) // 先回應，再非同步推送

  try {
    // 找所有有設定 notifyLineUserId 的房東（或主 Bot 管理員）
    const landlords = await prisma.landlord.findMany({
      where: { isActive: true, notifyLineUserId: { not: null } },
      select: { notifyLineUserId: true, lineChannelToken: true },
    })

    const mainToken = process.env.LINE_CHANNEL_ACCESS_TOKEN
    const mainNotifyId = process.env.ADMIN_NOTIFY_LINE_USER_ID

    // 推給主帳號管理員
    if (mainToken && mainNotifyId) {
      const client = new Client({ channelAccessToken: mainToken, channelSecret: process.env.LINE_CHANNEL_SECRET || '' })
      await client.pushMessage(mainNotifyId, { type: 'text', text }).catch(e => console.error('主帳號通知失敗:', e.message))
    }

    // 推給各有設定的房東（如果用自己 Bot）
    for (const l of landlords) {
      if (!l.notifyLineUserId) continue
      const token = l.lineChannelToken || mainToken
      if (!token) continue
      const client = new Client({ channelAccessToken: token, channelSecret: '' })
      await client.pushMessage(l.notifyLineUserId, { type: 'text', text }).catch(() => {})
    }
  } catch (e) {
    console.error('contact-notify 推送失敗:', e.message)
  }
})

module.exports = router
