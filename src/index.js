require('dotenv').config()
const express = require('express')
const { Client, middleware } = require('@line/bot-sdk')
const { handleMessage, handlePostback } = require('./handler')
const { startCronJobs } = require('./cron')
const prisma = require('./db')
const { upsertLineTenant } = require('./tenantStore')
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
        await upsertLineTenant({
          lineUserId: userId,
          data: { isActive: true, ...profileData }
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

// 先監聽 port（讓 Render 偵測到），再連 DB
app.listen(PORT, () => {
  console.log(`🚀 小蝸出租 LINE Bot 啟動於 port ${PORT}`)
})

// 非同步連線 DB（不阻塞 port 啟動）
prisma.$connect()
  .then(async () => {
    console.log('✅ 資料庫已連線')
    // 安全登入必要欄位：部署環境不一定會自動跑 prisma db push，所以啟動時補齊。
    try {
      await prisma.$executeRawUnsafe(`ALTER TABLE landlords ADD COLUMN IF NOT EXISTS "adminKeyHash" TEXT`)
      await prisma.$executeRawUnsafe(`ALTER TABLE landlords ALTER COLUMN "adminKey" DROP NOT NULL`)
      await prisma.$executeRawUnsafe(`CREATE UNIQUE INDEX IF NOT EXISTS "landlords_adminKeyHash_key" ON landlords ("adminKeyHash")`)
      console.log('✅ 後台金鑰安全欄位已確認')
    } catch (e) {
      console.error('⚠️ 後台金鑰安全欄位確認失敗:', e.message)
    }
    // Runtime DDL can be blocked by production DB locks/timeouts. Run it only when explicitly requested.
    if (process.env.RUN_SCHEMA_CHECK === 'true') {
      try {
        await prisma.$executeRawUnsafe(`
          CREATE TABLE IF NOT EXISTS communities (
            id           TEXT PRIMARY KEY,
            "ownerId"    TEXT,
            name         TEXT NOT NULL,
            description  TEXT NOT NULL DEFAULT '',
            photos       TEXT NOT NULL DEFAULT '[]',
            "mapUrl"     TEXT,
            "createdAt"  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            "updatedAt"  TIMESTAMPTZ NOT NULL DEFAULT NOW()
          )
        `)
        await prisma.$executeRawUnsafe(`ALTER TABLE properties ADD COLUMN IF NOT EXISTS "communityId" TEXT`)
        await prisma.$executeRawUnsafe(`ALTER TABLE communities ALTER COLUMN "ownerId" DROP NOT NULL`)
        await prisma.$executeRawUnsafe(`
          CREATE TABLE IF NOT EXISTS site_settings (
            key          TEXT PRIMARY KEY,
            value        TEXT NOT NULL,
            "updatedAt"  TIMESTAMPTZ NOT NULL DEFAULT NOW()
          )
        `)
        await prisma.$executeRawUnsafe(`ALTER TABLE landlords ADD COLUMN IF NOT EXISTS features TEXT`)
        await prisma.$executeRawUnsafe(`ALTER TABLE properties ADD COLUMN IF NOT EXISTS "siteFeatured" BOOLEAN NOT NULL DEFAULT false`)
        await prisma.$executeRawUnsafe(`ALTER TABLE landlords ADD COLUMN IF NOT EXISTS "socialConfig" TEXT`)
        console.log('✅ 資料表結構已確認')
      } catch(e) {
        console.error('⚠️ 資料表確認時發生警告（通常可忽略）:', e.message)
      }
    } else {
      console.log('ℹ️ 已略過啟動時資料表結構確認（RUN_SCHEMA_CHECK 未啟用）')
    }
    startCronJobs(client)
    try {
      const { startLeaseReminders } = require('./leaseReminder')
      startLeaseReminders()
    } catch (e) {
      console.error('租約提醒排程啟動失敗:', e.message)
    }
  })
  .catch((err) => {
    console.error('❌ 資料庫連線失敗：', err.message)
    // 不 process.exit，讓 server 繼續運行（Render 健康檢查才能通過）
  })
