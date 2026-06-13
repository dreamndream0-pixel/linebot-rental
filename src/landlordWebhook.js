// 房東動態 Webhook 路由
// 一個端點 /webhook/landlord/:landlordId 接所有房東的 LINE Bot
// 用各房東自己的 Channel Secret 驗證簽章

const crypto = require('crypto')
const { Client } = require('@line/bot-sdk')
const express = require('express')
const prisma = require('./db')
const { handleMessage } = require('./handler')

// 快取房東設定，減少 DB 查詢（每 60 秒過期）
const configCache = new Map()
const CACHE_TTL = 60 * 1000

async function getLandlordConfig(landlordId) {
  const cached = configCache.get(landlordId)
  if (cached && Date.now() - cached.at < CACHE_TTL) return cached.data

  const landlord = await prisma.landlord.findUnique({
    where: { id: landlordId },
    select: { id: true, name: true, lineChannelSecret: true, lineChannelToken: true, isActive: true }
  })
  configCache.set(landlordId, { at: Date.now(), data: landlord })
  return landlord
}

// 驗證 LINE 簽章
function validateSignature(body, channelSecret, signature) {
  const hash = crypto.createHmac('sha256', channelSecret).update(body).digest('base64')
  return hash === signature
}

function registerLandlordWebhooks(app) {
  // 用 raw body 才能驗證簽章
  app.post('/webhook/landlord/:landlordId',
    express.raw({ type: '*/*' }),
    async (req, res) => {
      const { landlordId } = req.params

      let landlord
      try {
        landlord = await getLandlordConfig(landlordId)
      } catch (e) {
        console.error('查詢房東設定失敗:', e.message)
        return res.sendStatus(500)
      }

      if (!landlord || !landlord.isActive || !landlord.lineChannelSecret || !landlord.lineChannelToken) {
        console.log(`⚠️ 房東 ${landlordId} 未設定 Bot 或已停用`)
        return res.sendStatus(404)
      }

      // 驗證簽章
      const signature = req.headers['x-line-signature']
      const bodyStr = req.body.toString('utf-8')
      if (!validateSignature(bodyStr, landlord.lineChannelSecret, signature)) {
        console.log(`⚠️ 房東 ${landlord.name} 簽章驗證失敗`)
        return res.sendStatus(401)
      }

      res.json({ status: 'ok' })

      // 建立該房東專屬的 client
      const client = new Client({
        channelAccessToken: landlord.lineChannelToken,
        channelSecret: landlord.lineChannelSecret,
      })

      const body = JSON.parse(bodyStr)
      const events = body.events || []
      events.forEach(async (event) => {
        try {
          if (event.type === 'message' && event.message.type === 'text') {
            // 帶入 landlordId，讓 handler 知道是哪個房東的 Bot
            await handleMessage(event, client, landlord.id)
          } else if (event.type === 'follow') {
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
              update: { isActive: true, landlordId: landlord.id, ...profileData },
              create: { lineUserId: userId, landlordId: landlord.id, ...profileData }
            })
            await client.replyMessage(event.replyToken, {
              type: 'text',
              text: `👋 歡迎加入${landlord.name}！\n\n輸入「選單」開始使用服務。`
            })
          }
        } catch (err) {
          console.error(`[${landlord.name}] 事件處理錯誤:`, err.message)
        }
      })
    }
  )

  console.log('✅ 房東動態 Webhook 已啟動：/webhook/landlord/:landlordId')
}

// 清除某房東的設定快取（後台更新 Bot 設定後呼叫）
function clearConfigCache(landlordId) {
  configCache.delete(landlordId)
}

module.exports = { registerLandlordWebhooks, clearConfigCache }
