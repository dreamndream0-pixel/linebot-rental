// 房東動態 Webhook 路由
// 一個端點 /webhook/landlord/:landlordId 接所有房東的 LINE Bot
// 用各房東自己的 Channel Secret 驗證簽章

const crypto = require('crypto')
const { Client } = require('@line/bot-sdk')
const express = require('express')
const prisma = require('./db')
const { upsertLineTenant } = require('./tenantStore')
const { handleMessage, handlePostback, recordIncomingMessage } = require('./handler')

// 快取房東設定，減少 DB 查詢（每 60 秒過期）
const configCache = new Map()
const CACHE_TTL = 60 * 1000

async function getLandlordConfig(landlordId) {
  const cached = configCache.get(landlordId)
  if (cached && Date.now() - cached.at < CACHE_TTL) return cached.data

  const landlord = await prisma.landlord.findUnique({
    where: { id: landlordId },
    select: {
      id: true, name: true, lineChannelSecret: true, lineChannelToken: true, isActive: true, botEnabled: true, features: true,
      botScope: true, supportChannelSecret: true, supportChannelToken: true, supportBotName: true, supportBotEnabled: true,
    }
  })
  configCache.set(landlordId, { at: Date.now(), data: landlord })
  return landlord
}

// 依 kind 取出對應 Bot 的憑證與功能範圍
function pickBot(landlord, kind) {
  if (kind === 'support') {
    return {
      secret: landlord.supportChannelSecret,
      token: landlord.supportChannelToken,
      name: landlord.supportBotName || (landlord.name + ' 客服'),
      enabled: landlord.supportBotEnabled !== false,
      scope: 'support',
    }
  }
  return {
    secret: landlord.lineChannelSecret,
    token: landlord.lineChannelToken,
    name: landlord.name,
    enabled: true,
    scope: landlord.botScope || 'all',
  }
}

function isLandlordBotEnabled(landlord) {
  if (!landlord || landlord.botEnabled === false) return false
  try {
    const features = landlord.features ? JSON.parse(landlord.features) : {}
    if (features.bot === false) return false
  } catch (_) {}
  return true
}

function isAutoReplyEnabled(landlord) {
  try {
    const features = landlord.features ? JSON.parse(landlord.features) : {}
    if (features.autoReply === false) return false
  } catch (_) {}
  return true
}

// 驗證 LINE 簽章
function validateSignature(body, channelSecret, signature) {
  const hash = crypto.createHmac('sha256', channelSecret).update(body).digest('base64')
  return hash === signature
}

function makeWebhookHandler(kind) {
  return async (req, res) => {
    const { landlordId } = req.params

    let landlord
    try {
      landlord = await getLandlordConfig(landlordId)
    } catch (e) {
      console.error('查詢房東設定失敗:', e.message)
      return res.sendStatus(500)
    }

    if (!landlord || !landlord.isActive) {
      console.log(`⚠️ 房東 ${landlordId} 不存在或已停用`)
      return res.sendStatus(404)
    }

    const bot = pickBot(landlord, kind)
    if (!bot.secret || !bot.token) {
      console.log(`⚠️ 房東 ${landlordId} 的 ${kind} Bot 未設定`)
      return res.sendStatus(404)
    }

    // 驗證簽章（用該 Bot 自己的 secret）
    const signature = req.headers['x-line-signature']
    const bodyStr = req.body.toString('utf-8')
    if (!validateSignature(bodyStr, bot.secret, signature)) {
      console.log(`⚠️ ${bot.name} 簽章驗證失敗`)
      return res.sendStatus(401)
    }

    res.json({ status: 'ok' })

    const client = new Client({ channelAccessToken: bot.token, channelSecret: bot.secret })

    const botActive = isLandlordBotEnabled(landlord) && bot.enabled
    const autoReply = botActive && isAutoReplyEnabled(landlord)
    if (!botActive) console.log(`ℹ️ ${bot.name} Bot 已關閉，僅記錄用戶資料`)
    else if (!autoReply) console.log(`ℹ️ ${bot.name} 自動回覆已關閉，僅記錄用戶資料`)

    const body = JSON.parse(bodyStr)
    const events = body.events || []
    events.forEach(async (event) => {
      try {
        await recordIncomingMessage(event, client, landlord.id, bot.scope)
        if (!autoReply) return

        if (event.type === 'message' && event.message.type === 'text') {
          await handleMessage(event, client, landlord.id, bot.scope)
        } else if (event.type === 'postback') {
          await handlePostback(event, client, landlord.id, bot.scope)
        } else if (event.type === 'follow') {
          const { getBotText } = require('./botText')
          const t = await getBotText(landlord.id)
          const base = bot.scope === 'support'
            ? '👋 歡迎加入客服帳號！\n\n有維修、繳費或門鎖密碼需求，輸入「選單」開始。'
            : (t.welcome || '👋 歡迎加入！\n\n輸入「選單」開始使用服務。').replace('歡迎加入！', `歡迎加入${landlord.name}！`)
          await client.replyMessage(event.replyToken, { type: 'text', text: base })
        }
      } catch (err) {
        console.error(`[${bot.name}] 事件處理錯誤:`, err.message)
      }
    })
  }
}

function registerLandlordWebhooks(app) {
  // 用 raw body 才能驗證簽章
  app.post('/webhook/landlord/:landlordId', express.raw({ type: '*/*' }), makeWebhookHandler('primary'))
  app.post('/webhook/landlord/:landlordId/support', express.raw({ type: '*/*' }), makeWebhookHandler('support'))
  console.log('✅ 房東動態 Webhook 已啟動：/webhook/landlord/:landlordId（+/support）')
}

// 清除某房東的設定快取（後台更新 Bot 設定後呼叫）
function clearConfigCache(landlordId) {
  configCache.delete(landlordId)
}

module.exports = { registerLandlordWebhooks, clearConfigCache }
