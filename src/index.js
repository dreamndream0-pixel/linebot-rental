require('dotenv').config()
const express = require('express')
const { Client, middleware } = require('@line/bot-sdk')
const { handleMessage, handlePostback } = require('./handler')
const { startCronJobs } = require('./cron')
const prisma = require('./db')
const adminRouter = require('./admin')
const { registerExtraChannels } = require('./extraChannels')
const { registerLandlordWebhooks } = require('./landlordWebhook')

const config = {
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.LINE_CHANNEL_SECRET,
}

const client = new Client(config)
const app = express()

// ── 管理後台 ───────────────────────────────────────────────────
app.use(adminRouter)

// ── 其他官方帳號的輕量 Webhook（只抓 userId） ─────────────────
registerExtraChannels(app)

// ── 房東動態 Webhook（B-1：多房東各自的 Bot） ─────────────────
registerLandlordWebhooks(app)

// ── 主帳號 Webhook ─────────────────────────────────────────────
app.post('/webhook', middleware(config), (req, res) => {
  res.json({ status: 'ok' })

  const events = req.body.events
  events.forEach(async (event) => {
    try {
      if (event.type === 'message' && event.message.type === 'text') {
        await handleMessage(event, client)
      } else if (event.type === 'postback') {
        await handlePostback(event, client)
      } else if (event.type === 'follow') {
        // 新好友加入：抓取資料並記錄
        const userId = event.source.userId
        let profileData = {}
        try {
          const profile = await client.getProfile(userId)
          profileData = {
            name: profile.displayName,
            avatarUrl: profile.pictureUrl || null,
            statusMessage: profile.statusMessage || null,
          }
        } catch (e) {
          console.log('無法取得新好友資料:', e.message)
        }
        await prisma.tenant.upsert({
          where: { lineUserId: userId },
          update: { isActive: true, ...profileData },
          create: { lineUserId: userId, ...profileData }
        })
        console.log('👋 新好友:', userId, profileData.name || '')

        await client.replyMessage(event.replyToken, {
          type: 'text',
          text: '👋 歡迎加入小蝸出租！\n\n輸入「選單」開始使用服務。'
        })
      }
    } catch (err) {
      console.error('事件處理錯誤：', err)
    }
  })
})

// ── 健康檢查 ───────────────────────────────────────────────────
app.get('/', (req, res) => {
  res.json({ status: 'running', name: '小蝸出租 LINE Bot' })
})

// ── 啟動 ───────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000

async function main() {
  await prisma.$connect()
  console.log('✅ 資料庫已連線')

  startCronJobs(client)

  app.listen(PORT, () => {
    console.log(`🚀 小蝸出租 LINE Bot 啟動於 port ${PORT}`)
  })
}

main().catch((err) => {
  console.error('啟動失敗：', err)
  process.exit(1)
})
