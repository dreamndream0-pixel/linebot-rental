// src/leaseReminder.js — 代管租約的租金/水電繳費 LINE 提醒
const cron = require('node-cron')
const { Client } = require('@line/bot-sdk')
const prisma = require('./db')

// 取得某租約對應的 LINE Client（用該物業所屬房東的 Bot；沒有則用主 Bot）
async function getClientForLease(lease) {
  try {
    const mp = await prisma.managedProperty.findUnique({
      where: { id: lease.managedPropertyId },
      select: { landlordId: true },
    })
    if (mp?.landlordId) {
      const landlord = await prisma.landlord.findUnique({
        where: { id: mp.landlordId },
        select: { lineChannelToken: true, lineChannelSecret: true },
      })
      if (landlord?.lineChannelToken) {
        return new Client({
          channelAccessToken: landlord.lineChannelToken,
          channelSecret: landlord.lineChannelSecret || '',
        })
      }
    }
  } catch (e) {
    console.error('取得租約 Bot 失敗:', e.message)
  }
  // fallback 主 Bot
  if (process.env.LINE_CHANNEL_ACCESS_TOKEN) {
    return new Client({
      channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
      channelSecret: process.env.LINE_CHANNEL_SECRET || '',
    })
  }
  return null
}

// 是否同月已推過（避免重複）
function alreadyRemindedThisMonth(lastDate) {
  if (!lastDate) return false
  const last = new Date(lastDate)
  const now = new Date()
  return last.getFullYear() === now.getFullYear() && last.getMonth() === now.getMonth()
}

// 租金提醒訊息
function rentReminderFlex(lease) {
  return {
    type: 'flex',
    altText: '🏠 租金繳費提醒',
    contents: {
      type: 'bubble',
      header: {
        type: 'box', layout: 'vertical', backgroundColor: '#7A9E7E', paddingAll: '16px',
        contents: [{ type: 'text', text: '🏠 租金繳費提醒', weight: 'bold', size: 'lg', color: '#ffffff' }],
      },
      body: {
        type: 'box', layout: 'vertical', spacing: 'sm',
        contents: [
          { type: 'text', text: lease.tenantName + ' 您好', weight: 'bold', size: 'md' },
          { type: 'text', text: '提醒您本月租金即將到期', size: 'sm', color: '#666666', wrap: true },
          { type: 'separator', margin: 'md' },
          { type: 'box', layout: 'baseline', margin: 'md', contents: [
            { type: 'text', text: '房源', size: 'sm', color: '#999999', flex: 2 },
            { type: 'text', text: lease.managedTitle + (lease.roomLabel ? ' ' + lease.roomLabel : ''), size: 'sm', flex: 5, wrap: true },
          ]},
          { type: 'box', layout: 'baseline', contents: [
            { type: 'text', text: '租金', size: 'sm', color: '#999999', flex: 2 },
            { type: 'text', text: 'NT$ ' + Number(lease.rent).toLocaleString(), size: 'sm', flex: 5, weight: 'bold', color: '#4A6741' },
          ]},
          { type: 'box', layout: 'baseline', contents: [
            { type: 'text', text: '繳費日', size: 'sm', color: '#999999', flex: 2 },
            { type: 'text', text: '每月 ' + lease.rentPayDay + ' 號', size: 'sm', flex: 5 },
          ]},
          { type: 'text', text: '請記得準時繳費，謝謝您 🙏', size: 'xs', color: '#aaaaaa', margin: 'md', wrap: true },
        ],
      },
    },
  }
}

// 水電提醒訊息
function utilReminderFlex(lease) {
  const amountLine = lease.utilAmount > 0
    ? [{ type: 'box', layout: 'baseline', contents: [
        { type: 'text', text: '金額', size: 'sm', color: '#999999', flex: 2 },
        { type: 'text', text: 'NT$ ' + Number(lease.utilAmount).toLocaleString(), size: 'sm', flex: 5, weight: 'bold', color: '#C9913A' },
      ]}]
    : []
  return {
    type: 'flex',
    altText: '💡 水電繳費提醒',
    contents: {
      type: 'bubble',
      header: {
        type: 'box', layout: 'vertical', backgroundColor: '#C9913A', paddingAll: '16px',
        contents: [{ type: 'text', text: '💡 水電繳費提醒', weight: 'bold', size: 'lg', color: '#ffffff' }],
      },
      body: {
        type: 'box', layout: 'vertical', spacing: 'sm',
        contents: [
          { type: 'text', text: lease.tenantName + ' 您好', weight: 'bold', size: 'md' },
          { type: 'text', text: '提醒您本月水電費即將到期', size: 'sm', color: '#666666', wrap: true },
          { type: 'separator', margin: 'md' },
          { type: 'box', layout: 'baseline', margin: 'md', contents: [
            { type: 'text', text: '房源', size: 'sm', color: '#999999', flex: 2 },
            { type: 'text', text: lease.managedTitle + (lease.roomLabel ? ' ' + lease.roomLabel : ''), size: 'sm', flex: 5, wrap: true },
          ]},
          ...amountLine,
          { type: 'box', layout: 'baseline', contents: [
            { type: 'text', text: '繳費日', size: 'sm', color: '#999999', flex: 2 },
            { type: 'text', text: '每月 ' + lease.utilPayDay + ' 號', size: 'sm', flex: 5 },
          ]},
          { type: 'text', text: '請記得準時繳費，謝謝您 🙏', size: 'xs', color: '#aaaaaa', margin: 'md', wrap: true },
        ],
      },
    },
  }
}

// 主檢查：每天跑，找出今天該提醒的租約
async function checkLeaseReminders() {
  const today = new Date().getDate()  // 今天幾號
  console.log(`📅 檢查租約繳費提醒（今天 ${today} 號）...`)

  // 提前 3 天提醒（繳費日前 3 天推）
  const REMIND_BEFORE = 3

  const leases = await prisma.lease.findMany({
    where: { status: 'ACTIVE', lineUserId: { not: null } },
    include: { managedProperty: { select: { title: true, landlordId: true } } },
  })

  for (const lease of leases) {
    const data = {
      ...lease,
      managedTitle: lease.managedProperty.title,
    }

    // 租金提醒：繳費日前 3 天
    if (lease.rentRemindOn && lease.rentPayDay) {
      const remindDay = ((lease.rentPayDay - REMIND_BEFORE - 1 + 31) % 31) + 1
      if (today === remindDay && !alreadyRemindedThisMonth(lease.lastRentRemind)) {
        const client = await getClientForLease(lease)
        if (client) {
          try {
            await client.pushMessage(lease.lineUserId, rentReminderFlex(data))
            await prisma.lease.update({ where: { id: lease.id }, data: { lastRentRemind: new Date() } })
            console.log(`✅ 已推租金提醒：${lease.tenantName}`)
          } catch (e) {
            console.error(`租金提醒推播失敗（${lease.tenantName}）:`, e.message)
          }
        }
      }
    }

    // 水電提醒：繳費日前 3 天
    if (lease.utilRemindOn && lease.utilPayDay) {
      const remindDay = ((lease.utilPayDay - REMIND_BEFORE - 1 + 31) % 31) + 1
      if (today === remindDay && !alreadyRemindedThisMonth(lease.lastUtilRemind)) {
        const client = await getClientForLease(lease)
        if (client) {
          try {
            await client.pushMessage(lease.lineUserId, utilReminderFlex(data))
            await prisma.lease.update({ where: { id: lease.id }, data: { lastUtilRemind: new Date() } })
            console.log(`✅ 已推水電提醒：${lease.tenantName}`)
          } catch (e) {
            console.error(`水電提醒推播失敗（${lease.tenantName}）:`, e.message)
          }
        }
      }
    }
  }
  console.log('📅 租約繳費提醒檢查完成')
}

// 啟動排程：每天早上 9 點檢查
function startLeaseReminders() {
  cron.schedule('0 9 * * *', async () => {
    try { await checkLeaseReminders() } catch (e) { console.error('租約提醒排程錯誤:', e.message) }
  })
  console.log('✅ 租約繳費提醒排程已啟動（每日 9:00 檢查）')
}

module.exports = { startLeaseReminders, checkLeaseReminders }
