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

// 取得某租約可用的 LINE Client 清單（依序嘗試）：
// 已承租房客多在「客服 Bot」→ 優先客服 Bot，再退主 Bot，最後才用環境變數主 Bot。
async function getLeaseClients(lease) {
  const clients = []
  try {
    const mp = await prisma.managedProperty.findUnique({
      where: { id: lease.managedPropertyId },
      select: { landlordId: true },
    })
    if (mp?.landlordId) {
      const landlord = await prisma.landlord.findUnique({
        where: { id: mp.landlordId },
        select: {
          lineChannelToken: true, lineChannelSecret: true,
          supportChannelToken: true, supportChannelSecret: true, supportBotEnabled: true,
        },
      })
      if (landlord) {
        if (landlord.supportChannelToken && landlord.supportBotEnabled !== false) {
          clients.push({ name: '客服Bot', client: new Client({ channelAccessToken: landlord.supportChannelToken, channelSecret: landlord.supportChannelSecret || '' }) })
        }
        if (landlord.lineChannelToken) {
          clients.push({ name: '主Bot', client: new Client({ channelAccessToken: landlord.lineChannelToken, channelSecret: landlord.lineChannelSecret || '' }) })
        }
      }
    }
  } catch (e) {
    console.error('取得租約 Bot 失敗:', e.message)
  }
  if (process.env.LINE_CHANNEL_ACCESS_TOKEN) {
    clients.push({ name: '系統Bot', client: new Client({ channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN, channelSecret: process.env.LINE_CHANNEL_SECRET || '' }) })
  }
  return clients
}

// 推播給租約綁定的房客：依序嘗試各 Bot，任一成功即回傳；全部失敗則丟出含 LINE 詳細訊息的錯誤。
async function pushToLeaseTenant(lease, message) {
  if (!lease.lineUserId) throw new Error('此租約尚未綁定 LINE 租客（LINE userID 為空）')
  const clients = await getLeaseClients(lease)
  if (!clients.length) throw new Error('此房東尚未設定任何 LINE Bot')
  let lastErr = null
  for (const c of clients) {
    try {
      await c.client.pushMessage(lease.lineUserId, message)
      return { ok: true, via: c.name }
    } catch (e) {
      const data = e && e.originalError && e.originalError.response && e.originalError.response.data
      const msg = (data && (data.message || (data.details && JSON.stringify(data.details)))) || e.message
      lastErr = new Error(`[${c.name}] ${msg}`)
      console.error(`推播失敗（${c.name} / ${lease.tenantName}）:`, msg)
    }
  }
  throw lastErr || new Error('推播失敗')
}

// 是否同月已推過（避免重複）
function alreadyRemindedThisMonth(lastDate) {
  if (!lastDate) return false
  const last = new Date(lastDate)
  const now = new Date()
  return last.getFullYear() === now.getFullYear() && last.getMonth() === now.getMonth()
}

// 日期 → 台北 YYYY/MM/DD
function fmtYMD(d) {
  if (!d) return '—'
  const t = new Date(new Date(d).getTime() + 8 * 3600 * 1000)
  return t.getUTCFullYear() + '/' + String(t.getUTCMonth() + 1).padStart(2, '0') + '/' + String(t.getUTCDate()).padStart(2, '0')
}

// 明細列（左標籤、右值，貼齊右側）
function remRow(label, value, opts) {
  opts = opts || {}
  return { type: 'box', layout: 'baseline', spacing: 'sm', margin: 'md', contents: [
    { type: 'text', text: label, size: 'sm', color: '#A6A093', flex: 3 },
    { type: 'text', text: String(value), size: 'sm', color: opts.color || '#4A473F', weight: opts.bold ? 'bold' : 'regular', flex: 9, align: 'end', wrap: true },
  ]}
}

// 繳費提醒卡片：統一的高級排版（頭部色帶＋金額主視覺＋明細）
function reminderBubble(o) {
  const body = [
    { type: 'text', text: o.tenant + ' 您好', weight: 'bold', size: 'md', color: '#2B2B2B' },
    { type: 'text', text: o.intro, size: 'sm', color: '#8C877D', wrap: true, margin: 'xs' },
    // 金額主視覺卡
    { type: 'box', layout: 'vertical', backgroundColor: o.tint, cornerRadius: '14px', paddingAll: '16px', margin: 'lg', spacing: 'none', contents: [
      { type: 'text', text: o.amountLabel, size: 'xs', color: o.deep },
      { type: 'text', text: 'NT$ ' + Number(o.amount || 0).toLocaleString(), size: 'xl', color: o.deep, weight: 'bold', margin: 'xs', wrap: true },
      o.dueStr
        ? { type: 'box', layout: 'baseline', margin: 'md', contents: [
            { type: 'text', text: '應繳日期', size: 'xs', color: o.deep, flex: 3 },
            { type: 'text', text: o.dueStr, size: 'sm', color: o.deep, weight: 'bold', flex: 6, align: 'end' },
          ]}
        : { type: 'filler' },
    ]},
  ]
  if (o.rows && o.rows.length) {
    body.push({ type: 'text', text: o.detailTitle, size: 'xs', color: '#B0A891', weight: 'bold', margin: 'xl' })
    body.push({ type: 'separator', margin: 'sm', color: '#ECE6DA' })
    o.rows.forEach(function (rw) { body.push(rw) })
  }
  return {
    type: 'flex',
    altText: o.alt,
    contents: {
      type: 'bubble', size: 'mega',
      header: {
        type: 'box', layout: 'vertical', backgroundColor: o.accent, paddingAll: '20px', spacing: 'xs',
        contents: [
          { type: 'text', text: o.title, color: '#FFFFFF', weight: 'bold', size: 'lg' },
          { type: 'text', text: o.subtitle, color: o.subColor, size: 'sm' },
        ],
      },
      body: { type: 'box', layout: 'vertical', paddingAll: '20px', spacing: 'none', contents: body },
      footer: {
        type: 'box', layout: 'vertical', paddingAll: '16px',
        contents: [{ type: 'text', text: o.footer, size: 'xs', color: '#AEA89C', wrap: true, align: 'center' }],
      },
      styles: { footer: { separator: true } },
    },
  }
}

const CYCLE_LABEL = { MONTHLY: '月繳', BIMONTHLY: '雙月繳', QUARTERLY: '季繳', SEMIANNUAL: '半年繳', YEARLY: '年繳' }

// 租金提醒訊息（含租期期間、繳費週期明細）
function rentReminderFlex(lease) {
  const dueStr = lease.dueDateStr ? fmtYMD(lease.dueDateStr) : (lease.rentPayDay ? ('每月 ' + lease.rentPayDay + ' 號') : null)
  const rows = []
  if (lease.periodStartStr && lease.periodEndStr) {
    rows.push(remRow('租金期間', fmtYMD(lease.periodStartStr) + ' → ' + fmtYMD(lease.periodEndStr)))
  }
  if (lease.paymentCycle && CYCLE_LABEL[lease.paymentCycle]) {
    rows.push(remRow('繳費週期', CYCLE_LABEL[lease.paymentCycle]))
  }
  if (lease.payMethod) rows.push(remRow('繳費方式', String(lease.payMethod)))
  return reminderBubble({
    alt: '租金繳費通知', title: '租金繳費通知',
    subtitle: lease.managedTitle + (lease.roomLabel ? '  ·  ' + lease.roomLabel : ''),
    subColor: '#DCEBDD', accent: '#5E8663', tint: '#EFF5EF', deep: '#3E6144',
    tenant: lease.tenantName, intro: '提醒您本期租金即將到期',
    amountLabel: '本期應繳租金', amount: Number(lease.rent || 0), dueStr: dueStr,
    detailTitle: '租金明細', rows: rows,
    footer: '請於期限前完成繳費，謝謝您',
  })
}

// 水電提醒訊息（含抄表明細：起算日/度數、結算日/度數、使用度數、費率）
function utilReminderFlex(lease) {
  const r = lease.reading || null
  const amount = r ? (r.amount || 0) : (lease.utilAmount || 0)
  const dueRaw = (r && r.dueDate) ? r.dueDate : (lease.dueDateStr || null)
  const rows = []
  if (r) {
    rows.push(remRow('抄表期間', fmtYMD(r.startDate) + ' → ' + fmtYMD(r.endDate)))
    rows.push(remRow('度數', Number(r.startDegree || 0).toLocaleString() + ' → ' + Number(r.endDegree || 0).toLocaleString() + ' 度'))
    rows.push(remRow('本期使用', Number(r.usedDegree || 0).toLocaleString() + ' 度', { bold: true, color: '#A9781E' }))
    if (r.rate) rows.push(remRow('每度費率', 'NT$ ' + Number(r.rate).toLocaleString()))
  }
  return reminderBubble({
    alt: '水電費繳費通知', title: '水電費繳費通知',
    subtitle: lease.managedTitle + (lease.roomLabel ? '  ·  ' + lease.roomLabel : ''),
    subColor: '#F3E6C6', accent: '#C6982E', tint: '#FBF4E4', deep: '#A9781E',
    tenant: lease.tenantName, intro: '以下為本期水電費繳費明細',
    amountLabel: '本期應繳金額', amount: amount, dueStr: dueRaw ? fmtYMD(dueRaw) : null,
    detailTitle: '用電明細', rows: rows,
    footer: '請於期限前完成繳費，感謝您的配合',
  })
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
        try {
          await pushToLeaseTenant(lease, rentReminderFlex(data))
          await prisma.lease.update({ where: { id: lease.id }, data: { lastRentRemind: new Date() } })
          console.log(`✅ 已推租金提醒：${lease.tenantName}`)
        } catch (e) {
          console.error(`租金提醒推播失敗（${lease.tenantName}）:`, e.message)
        }
      }
    }

    // 水電提醒：繳費日前 3 天
    if (lease.utilRemindOn && lease.utilPayDay) {
      const remindDay = ((lease.utilPayDay - REMIND_BEFORE - 1 + 31) % 31) + 1
      if (today === remindDay && !alreadyRemindedThisMonth(lease.lastUtilRemind)) {
        try {
          await pushToLeaseTenant(lease, utilReminderFlex(data))
          await prisma.lease.update({ where: { id: lease.id }, data: { lastUtilRemind: new Date() } })
          console.log(`✅ 已推水電提醒：${lease.tenantName}`)
        } catch (e) {
          console.error(`水電提醒推播失敗（${lease.tenantName}）:`, e.message)
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

module.exports = { startLeaseReminders, checkLeaseReminders, getClientForLease, getLeaseClients, pushToLeaseTenant, rentReminderFlex, utilReminderFlex }
