// 第二個（或更多）官方帳號的輕量 Webhook
// 功能：只記錄 userId + 名稱 + 頭像，不回覆訊息
//
// 環境變數設定方式（每個帳號一組，把「2」換成帳號代號）：
//   LINE2_CHANNEL_SECRET=xxx
//   LINE2_CHANNEL_ACCESS_TOKEN=xxx
//   LINE2_NAME=帳號名稱（後台顯示用，例如 parkoo）

const { Client, middleware } = require('@line/bot-sdk')
const { upsertLineTenant } = require('./tenantStore')

function registerExtraChannels(app) {
  // 掃描環境變數，找出所有 LINE<數字>_ 開頭的帳號設定
  const channelNumbers = new Set()
  for (const key of Object.keys(process.env)) {
    const m = key.match(/^LINE(\d+)_CHANNEL_SECRET$/)
    if (m) channelNumbers.add(m[1])
  }

  for (const num of channelNumbers) {
    const secret = process.env[`LINE${num}_CHANNEL_SECRET`]
    const token = process.env[`LINE${num}_CHANNEL_ACCESS_TOKEN`]
    const name = process.env[`LINE${num}_NAME`] || `channel${num}`

    if (!secret || !token) {
      console.log(`⚠️ LINE${num} 設定不完整，跳過`)
      continue
    }

    const config = { channelSecret: secret, channelAccessToken: token }
    const client = new Client(config)
    const path = `/webhook${num}`

    app.post(path, middleware(config), (req, res) => {
      res.json({ status: 'ok' })

      req.body.events.forEach(async (event) => {
        try {
          const userId = event.source?.userId
          if (!userId) return

          // 抓取用戶資料
          let profileData = {}
          try {
            const profile = await client.getProfile(userId)
            profileData = {
              name: profile.displayName,
              avatarUrl: profile.pictureUrl || null,
              statusMessage: profile.statusMessage || null,
            }
          } catch (e) {
            console.log(`[${name}] 無法取得用戶資料:`, e.message)
          }

          await upsertLineTenant({ lineUserId: userId, source: name, data: profileData })

          console.log(`✅ [${name}] 記錄用戶:`, userId, profileData.name || '')
        } catch (err) {
          console.error(`[${name}] 處理錯誤:`, err.message)
        }
      })
    })

    console.log(`📡 第二帳號 Webhook 已啟動：${path}（${name}）`)
  }
}

module.exports = { registerExtraChannels }
