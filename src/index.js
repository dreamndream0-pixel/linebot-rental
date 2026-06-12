require('dotenv').config()
const express = require('express')
const { Client, middleware } = require('@line/bot-sdk')
const { handleMessage } = require('./handler')
const { startCronJobs } = require('./cron')
const prisma = require('./db')

const config = {
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.LINE_CHANNEL_SECRET,
}

const client = new Client(config)
const app = express()

// ── Webhook 端點 ───────────────────────────────────────────────
app.post('/webhook', middleware(config), (req, res) => {
  res.json({ status: 'ok' })

  const events = req.body.events
  events.forEach(async (event) => {
    try {
      if (event.type === 'message' && event.message.type === 'text') {
        await handleMessage(event, client)
      } else if (event.type === 'follow') {
        const prisma = require('./db')
        await prisma.tenant.upsert({ where: { lineUserId: event.source.userId }, update: { isActive: true }, create: { lineUserId: event.source.userId } })
        console.log('👋 新好友:', event.source.userId)
        // 新用戶加入時
        await client.replyMessage(event.replyToken, {
          type: 'text',
          text: '👋 歡迎加入小蝸出租！\n\n輸入「選單」或點下方按鈕開始使用服務。'
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
    console.log(`📡 Webhook URL: https://你的網域/webhook`)
  })
}

main().catch((err) => {
  console.error('啟動失敗：', err)
  process.exit(1)
})
