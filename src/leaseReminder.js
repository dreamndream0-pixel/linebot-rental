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
  // 用 horizontal（非 baseline）以支援文字換行，避免較長標籤（如「合約結束日」「－ 未收電費」）被截斷成「…」
  return { type: 'box', layout: 'horizontal', spacing: 'sm', margin: 'sm', contents: [
    { type: 'text', text: label, size: 'sm', color: '#A6A093', flex: 4, wrap: true },
    { type: 'text', text: String(value), size: 'sm', color: opts.color || '#4A473F', weight: opts.bold ? 'bold' : 'regular', flex: 8, align: 'end', wrap: true },
  ]}
}

// 金額項目列（左：項目名稱，可換行；右：帶正負號與顏色的金額）
function moneyRow(label, amount, sign) {
  const color = sign === '-' ? '#B5544C' : '#2E7D46'
  const txt = (sign || '') + ' NT$ ' + Number(Math.abs(amount) || 0).toLocaleString()
  return { type: 'box', layout: 'horizontal', spacing: 'sm', margin: 'sm', contents: [
    { type: 'text', text: String(label), size: 'sm', color: '#6B6658', flex: 7, wrap: true },
    { type: 'text', text: txt, size: 'sm', color: color, weight: 'bold', flex: 5, align: 'end', wrap: false },
  ]}
}

// 屋主姓名：第二個字以 O 隱藏（黃爵卿 → 黃O卿；王明 → 王O）
function maskOwnerName(name) {
  const s = String(name || '').trim()
  if (s.length < 2) return s
  return s[0] + 'O' + s.slice(2)
}

// 組出繳費卡片的收款帳戶資訊（戶名／銀行／帳號）：
// 以委託物業的屋主匯款銀行＋帳號為主；未填則退用房東共用匯款資訊（純字串）。
function buildPayInfo(mp, fallbackRaw) {
  const bank = ((mp && mp.ownerBankName) || '').trim()
  const account = ((mp && mp.ownerBank) || '').trim()
  if (bank || account) {
    return { name: maskOwnerName(mp && mp.ownerName), bank, account }
  }
  if (fallbackRaw) return { raw: String(fallbackRaw) }
  return null
}

// 繳費提醒卡片：統一的高級排版（頭部色帶＋金額主視覺＋明細）
function reminderBubble(o) {
  const body = [
    { type: 'text', text: o.tenant + ' 您好', weight: 'bold', size: 'md', color: '#2B2B2B' },
    { type: 'text', text: o.intro, size: 'sm', color: '#8C877D', wrap: true, margin: 'xs' },
    // 金額主視覺卡
    { type: 'box', layout: 'vertical', backgroundColor: o.tint, cornerRadius: '12px', paddingAll: '13px', margin: 'md', spacing: 'none', contents: [
      { type: 'text', text: o.amountLabel, size: 'xs', color: o.deep },
      { type: 'text', text: 'NT$ ' + Number(o.amount || 0).toLocaleString(), size: 'xl', color: o.deep, weight: 'bold', margin: 'xs', wrap: true },
      o.dueStr
        ? { type: 'box', layout: 'baseline', margin: 'sm', contents: [
            { type: 'text', text: '應繳日期', size: 'xs', color: o.deep, flex: 3 },
            { type: 'text', text: o.dueStr, size: 'sm', color: o.deep, weight: 'bold', flex: 6, align: 'end' },
          ]}
        : { type: 'filler' },
    ]},
  ]
  if (o.rows && o.rows.length) {
    body.push({ type: 'text', text: o.detailTitle, size: 'xs', color: '#B0A891', weight: 'bold', margin: 'lg' })
    body.push({ type: 'separator', margin: 'sm', color: '#ECE6DA' })
    o.rows.forEach(function (rw) { body.push(rw) })
  }
  // 匯款資訊區塊（房客轉帳用）：戶名／銀行／帳號
  if (o.payInfo) {
    const pi = o.payInfo
    const lines = [{ type: 'text', text: '匯款資訊', size: 'xs', color: '#9A927F', weight: 'bold' }]
    if (typeof pi === 'string') {
      lines.push({ type: 'text', text: pi, size: 'sm', color: '#43413B', wrap: true })
    } else if (pi.raw) {
      lines.push({ type: 'text', text: pi.raw, size: 'sm', color: '#43413B', wrap: true })
    } else {
      if (pi.name) lines.push({ type: 'text', text: '戶名：' + pi.name, size: 'sm', color: '#43413B', wrap: true })
      if (pi.bank) lines.push({ type: 'text', text: '銀行：' + pi.bank, size: 'sm', color: '#43413B', wrap: true })
      if (pi.account) lines.push({ type: 'text', text: '帳號：' + pi.account, size: 'sm', color: '#43413B', wrap: true })
    }
    body.push({ type: 'box', layout: 'vertical', backgroundColor: '#F6F4EF', cornerRadius: '10px', paddingAll: '10px', margin: 'md', spacing: 'xs', contents: lines })
  }
  return {
    type: 'flex',
    altText: o.alt,
    contents: {
      type: 'bubble', size: 'mega',
      header: {
        type: 'box', layout: 'vertical', backgroundColor: o.accent, paddingAll: '15px', spacing: 'xs',
        contents: [
          { type: 'text', text: o.title, color: '#FFFFFF', weight: 'bold', size: 'lg' },
          { type: 'text', text: o.subtitle, color: o.subColor, size: 'sm' },
        ],
      },
      body: { type: 'box', layout: 'vertical', paddingAll: '15px', spacing: 'none', contents: body },
      footer: {
        type: 'box', layout: 'vertical', paddingAll: '11px',
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
    detailTitle: '租金明細', rows: rows, payInfo: lease.rentPayInfo || null,
    footer: '請於期限前完成繳費，謝謝您',
  })
}

// 租金收款確認（房東登記收款後推播給房客）
function rentReceiptFlex(lease) {
  const rows = []
  if (lease.periodStartStr && lease.periodEndStr) rows.push(remRow('租金期間', fmtYMD(lease.periodStartStr) + ' → ' + fmtYMD(lease.periodEndStr)))
  if (lease.paidDateStr) rows.push(remRow('繳款日期', fmtYMD(lease.paidDateStr)))
  if (lease.payMethod) rows.push(remRow('繳費方式', String(lease.payMethod)))
  return reminderBubble({
    alt: '租金收款確認', title: '租金收款確認',
    subtitle: lease.managedTitle + (lease.roomLabel ? '  ·  ' + lease.roomLabel : ''),
    subColor: '#DCEBDD', accent: '#5E8663', tint: '#EFF5EF', deep: '#3E6144',
    tenant: lease.tenantName, intro: '已收到您的租金，感謝您的配合',
    amountLabel: '本次已收金額', amount: Number(lease.paidAmount || 0), dueStr: null,
    detailTitle: '繳費明細', rows: rows,
    footer: '如有疑問請與我們聯繫，謝謝您',
  })
}

// 水電收款確認（房東登記收款後推播給房客）
function utilReceiptFlex(lease) {
  const r = lease.reading || null
  const rows = []
  if (r) {
    rows.push(remRow('抄表期間', fmtYMD(r.startDate) + ' → ' + fmtYMD(r.endDate)))
    rows.push(remRow('度數', Number(r.startDegree || 0).toLocaleString() + ' → ' + Number(r.endDegree || 0).toLocaleString() + ' 度'))
    rows.push(remRow('本期使用', Number(r.usedDegree || 0).toLocaleString() + ' 度', { bold: true, color: '#A9781E' }))
    if (r.rate) rows.push(remRow('每度費率', 'NT$ ' + Number(r.rate).toLocaleString()))
  }
  if (lease.paidDateStr) rows.push(remRow('繳款日期', fmtYMD(lease.paidDateStr)))
  if (lease.payMethod) rows.push(remRow('繳費方式', String(lease.payMethod)))
  return reminderBubble({
    alt: '水電費收款確認', title: '水電費收款確認',
    subtitle: lease.managedTitle + (lease.roomLabel ? '  ·  ' + lease.roomLabel : ''),
    subColor: '#F3E6C6', accent: '#C6982E', tint: '#FBF4E4', deep: '#A9781E',
    tenant: lease.tenantName, intro: '已收到您的水電費，感謝您的配合',
    amountLabel: '本次已收金額', amount: Number(lease.paidAmount || 0), dueStr: null,
    detailTitle: '繳費明細', rows: rows,
    footer: '如有疑問請與我們聯繫，謝謝您',
  })
}

// 合約結算明細（房東結算後推播給房客）
function settleReceiptFlex(lease) {
  const deposit = Number(lease.settleDeposit || 0)
  const prepaid = Number(lease.settlePrepaid || 0)
  const deductions = Array.isArray(lease.settleDeductions) ? lease.settleDeductions : []
  const deductTotal = deductions.reduce((s, d) => s + (Number(d.amount) || 0), 0)
  const refund = (lease.settleRefund != null) ? Number(lease.settleRefund) : (deposit + prepaid - deductTotal)
  // 正數＝應扣費用；負數＝退款項（例如按日退租金）
  const charges = deductions.filter(d => (Number(d.amount) || 0) >= 0)
  const refundItems = deductions.filter(d => (Number(d.amount) || 0) < 0)
  const rows = []
  if (lease.settledAt) rows.push(remRow('結算日期', fmtYMD(lease.settledAt)))
  if (lease.endedAt) rows.push(remRow('合約結束日', fmtYMD(lease.endedAt)))
  // 金額項目（＋押金／＋預收／＋退款；－應扣），正負號與顏色置於金額側，項目名稱獨佔左欄
  rows.push(moneyRow('押金', deposit, '+'))
  if (prepaid > 0) rows.push(moneyRow('預收費用', prepaid, '+'))
  refundItems.forEach(function (d) { rows.push(moneyRow(d.name || '退款', d.amount, '+')) })
  charges.forEach(function (d) { rows.push(moneyRow(d.name || '應扣費用', d.amount, '-')) })
  // 電費明細（結算抄表）：起訖日/度數、使用度數、費率，讓房客了解電費如何計算
  const r = lease.reading || null
  if (r) {
    rows.push({ type: 'separator', margin: 'lg', color: '#ECE6DA' })
    rows.push({ type: 'text', text: '電費明細（結算抄表）', size: 'xs', color: '#B0A891', weight: 'bold', margin: 'sm' })
    rows.push(remRow('抄表期間', fmtYMD(r.startDate) + ' → ' + fmtYMD(r.endDate)))
    rows.push(remRow('度數', Number(r.startDegree || 0).toLocaleString() + ' → ' + Number(r.endDegree || 0).toLocaleString() + ' 度'))
    rows.push(remRow('本期使用', Number(r.usedDegree || 0).toLocaleString() + ' 度', { bold: true, color: '#A9781E' }))
    if (r.rate) rows.push(remRow('每度費率', 'NT$ ' + Number(r.rate).toLocaleString()))
    if (r.amount) rows.push(remRow('電費金額', 'NT$ ' + Number(r.amount).toLocaleString(), { bold: true, color: '#B5544C' }))
  }
  const positive = refund >= 0
  return reminderBubble({
    alt: '合約結算明細', title: '合約結算明細',
    subtitle: lease.managedTitle + (lease.roomLabel ? '  ·  ' + lease.roomLabel : ''),
    subColor: '#D8DFE6', accent: '#5A6B7B', tint: '#EEF1F4', deep: '#3C4A57',
    tenant: lease.tenantName, intro: '您的合約已完成結算，以下為結算明細',
    amountLabel: positive ? '應退還您的金額' : '尚需補繳金額', amount: Math.abs(refund), dueStr: null,
    detailTitle: '結算明細', rows: rows,
    footer: positive ? '退款將依約定方式辦理，感謝您的承租' : '請於結算後儘速完成補繳，感謝您的配合',
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
    detailTitle: '用電明細', rows: rows, payInfo: lease.rentPayInfo || null,
    footer: '請於期限前完成繳費，感謝您的配合',
  })
}

// 自動租金提醒：提前天數（繳費日前 N 天）
const REMIND_BEFORE = 7

// 自動租金提醒模式：off＝關閉、auto＝直接發給房客、confirm＝先推播給房東確認再送
// 每位房東各自設定（key: rent_reminder_mode:<landlordId>）；未設定時退回全域預設
// （auto_rent_reminder_mode，由總管理員設定），再退回 'auto'。
function normMode(v) { return (v === 'off' || v === 'confirm' || v === 'auto') ? v : null }
async function getRentReminderMode(landlordId) {
  try {
    if (landlordId) {
      const row = await prisma.siteSetting.findUnique({ where: { key: `rent_reminder_mode:${landlordId}` } })
      const v = normMode(row && row.value)
      if (v) return v
    }
    const g = await prisma.siteSetting.findUnique({ where: { key: 'auto_rent_reminder_mode' } })
    return normMode(g && g.value) || 'auto'
  } catch (e) { return 'auto' }
}

function mainReminderClient() {
  return new Client({ channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN, channelSecret: process.env.LINE_CHANNEL_SECRET })
}

// 寫入操作紀錄（讓自動/確認送出的租金提醒也能在後台被查到）
async function writeReminderAudit(lease, amount, actorLabel, actorRole, action) {
  try {
    await prisma.auditLog.create({
      data: {
        actorLabel, actorRole,
        landlordId: lease.managedProperty ? lease.managedProperty.landlordId : (lease.landlordId || null),
        method: 'SYSTEM', path: '/auto/rent-reminder', action,
        summary: JSON.stringify({ tenant: lease.tenantName || '', room: lease.roomLabel || '', amount, leaseId: lease.id }),
        status: 200,
      },
    })
  } catch (e) { console.error('租金提醒操作紀錄寫入失敗:', e.message) }
}

// 找出「本期尚未繳清」的租金期別（應繳日 15 天內或已逾期）；全繳清回傳 null
async function findDueUnpaidRow(lease) {
  try {
    const { buildRentSchedule } = require('./admin/routes/managedProperty')
    const rps = await prisma.rentPayment.findMany({ where: { leaseId: lease.id } })
    const sched = buildRentSchedule(lease, rps)
    const startOfToday = new Date(); startOfToday.setHours(0, 0, 0, 0)
    return sched.find(s => {
      if ((s.unpaid || 0) <= 0) return false
      if (!s.dueDate) return true
      const d = new Date(s.dueDate); d.setHours(0, 0, 0, 0)
      return Math.round((d.getTime() - startOfToday.getTime()) / 86400000) <= 15
    }) || null
  } catch (e) {
    console.error('租金排程計算失敗，改用合約月租金額:', e.message)
    return { amount: Number(lease.rent || 0) }
  }
}

// 決定「租金提醒待確認」要用哪個 Bot 推播、推給哪個 LINE ID。
// LINE 的 userId 是「各 Bot 各自」的，因此推播 Bot 必須與目標 ID 成對：
// 優先用「客服 Bot → 客服通知 ID」，退回「出租 Bot → 通知 ID」，再退回系統 Bot。
function pickApprovalChannel(landlord) {
  if (!landlord) return null
  if (landlord.supportChannelToken && landlord.supportBotEnabled !== false && landlord.supportNotifyLineUserId) {
    return { token: landlord.supportChannelToken, secret: landlord.supportChannelSecret || '', target: landlord.supportNotifyLineUserId, via: '客服Bot' }
  }
  if (landlord.lineChannelToken && landlord.notifyLineUserId) {
    return { token: landlord.lineChannelToken, secret: landlord.lineChannelSecret || '', target: landlord.notifyLineUserId, via: '出租Bot' }
  }
  if (landlord.notifyLineUserId) {
    return { token: process.env.LINE_CHANNEL_ACCESS_TOKEN, secret: process.env.LINE_CHANNEL_SECRET, target: landlord.notifyLineUserId, via: '系統Bot' }
  }
  return null
}

// confirm 模式：把待發送的租金提醒先推播給房東（優先客服 Bot），附「確認送出／略過」按鈕
async function sendRentApprovalToLandlord(lease, landlord, dueRow) {
  const ch = pickApprovalChannel(landlord)
  if (!ch) {
    console.log(`⏭️ 房東未設定客服/通知 LINE，略過確認推播：${lease.tenantName}`)
    return false
  }
  const amount = Number((dueRow && dueRow.amount) || lease.rent || 0)
  const client = new Client({ channelAccessToken: ch.token, channelSecret: ch.secret })
  // 預覽卡片：與實際發給房客的內容完全一致（同一個 rentReminderFlex）
  const mp = lease.managedProperty
  const cardData = {
    ...lease,
    managedTitle: mp ? mp.title : (lease.managedTitle || ''),
    rentPayInfo: buildPayInfo(mp || {}, mp && mp.landlord ? mp.landlord.rentPayInfo : null),
    rent: amount,
  }
  const previewCard = rentReminderFlex(cardData)
  const confirmMsg = {
    type: 'template',
    altText: '租金提醒待確認',
    template: {
      type: 'buttons',
      text: `☝️ 以上為將發送給「${lease.tenantName || '房客'}」的租金提醒，確認送出？`.slice(0, 160),
      actions: [
        { type: 'postback', label: '✅ 確認送出', data: `RR_CONFIRM_${lease.id}`, displayText: '確認送出租金提醒' },
        { type: 'postback', label: '✕ 略過', data: `RR_SKIP_${lease.id}`, displayText: '略過' },
      ],
    },
  }
  try {
    await client.pushMessage(ch.target, [previewCard, confirmMsg])
    console.log(`📋 已推播租金提醒待確認給房東（${ch.via}）：${lease.tenantName}`)
    return true
  } catch (e) {
    console.error(`租金提醒待確認推播失敗（${lease.tenantName}）:`, e.message)
    return false
  }
}

// 測試：立即挑一筆「房東已設定通知 LINE ID」的承租中租約，推播一則「租金提醒待確認」給房東
async function sendRentReminderTest(landlordId) {
  const where = { status: 'ACTIVE', lineUserId: { not: null } }
  if (landlordId) where.managedProperty = { landlordId }
  const leases = await prisma.lease.findMany({
    where,
    include: { managedProperty: { select: { title: true, landlordId: true, ownerName: true, ownerBankName: true, ownerBank: true, landlord: { select: { rentPayInfo: true, notifyLineUserId: true, lineChannelToken: true, lineChannelSecret: true, name: true, supportChannelToken: true, supportChannelSecret: true, supportNotifyLineUserId: true, supportBotEnabled: true } } } } },
    take: 100,
  })
  const lease = leases.find(l => l.managedProperty && pickApprovalChannel(l.managedProperty.landlord))
  if (!lease) return { ok: false, error: '找不到可推播確認訊息的承租中租約。請先為房東設定「客服 Bot 的通知 LINE ID」（supportNotifyLineUserId）或「通知 LINE User ID」。' }
  const dueRow = (await findDueUnpaidRow(lease)) || { amount: Number(lease.rent || 0), dueDate: null }
  const sent = await sendRentApprovalToLandlord(lease, lease.managedProperty.landlord, dueRow)
  if (!sent) return { ok: false, error: '推播失敗：房東的通知 LINE ID 可能尚未加入該 Bot 好友，或設定有誤。' }
  return {
    ok: true,
    tenant: lease.tenantName || '',
    room: lease.roomLabel || '',
    amount: Number(dueRow.amount || lease.rent || 0),
    landlordName: lease.managedProperty.landlord.name || '',
  }
}

// 房東在 LINE 按下「確認送出／略過」時呼叫（由 handler.js 的 postback 觸發）
async function handleRentReminderApproval(leaseId, isConfirm) {
  if (!isConfirm) return '已略過，未發送給房客。'
  const lease = await prisma.lease.findUnique({
    where: { id: leaseId },
    include: { managedProperty: { select: { title: true, landlordId: true, ownerName: true, ownerBankName: true, ownerBank: true, landlord: { select: { rentPayInfo: true } } } } },
  })
  if (!lease) return '找不到此租約。'
  if (!lease.lineUserId) return '此租約未綁定 LINE 房客，無法發送。'
  const dueRow = await findDueUnpaidRow(lease)
  if (!dueRow) return `${lease.tenantName || '房客'} 本期已繳清，未發送提醒。`
  const mp = lease.managedProperty
  const data = {
    ...lease, managedTitle: mp.title,
    rentPayInfo: buildPayInfo(mp, mp.landlord ? mp.landlord.rentPayInfo : null),
    rent: Number(dueRow.amount || lease.rent || 0),
  }
  await pushToLeaseTenant(lease, rentReminderFlex(data))
  await prisma.lease.update({ where: { id: lease.id }, data: { lastRentRemind: new Date() } })
  await writeReminderAudit(lease, data.rent, '房東確認送出', 'landlord', '租金提醒（確認送出）')
  return `✅ 已發送租金提醒給 ${lease.tenantName || '房客'}（NT$ ${Number(data.rent).toLocaleString()}）。`
}

// 主檢查：每天跑，找出今天該提醒的租約
async function checkLeaseReminders() {
  const today = new Date().getDate()  // 今天幾號
  console.log(`📅 檢查租約繳費提醒（今天 ${today} 號）...`)

  // 每次執行內快取各房東的提醒模式（避免同房東重複打 DB）
  const _modeCache = new Map()
  const modeFor = async (landlordId) => {
    const k = landlordId || '__none__'
    if (_modeCache.has(k)) return _modeCache.get(k)
    const m = await getRentReminderMode(landlordId)
    _modeCache.set(k, m)
    return m
  }

  const leases = await prisma.lease.findMany({
    where: { status: 'ACTIVE', lineUserId: { not: null } },
    include: { managedProperty: { select: { title: true, landlordId: true, ownerName: true, ownerBankName: true, ownerBank: true, landlord: { select: { rentPayInfo: true, notifyLineUserId: true, lineChannelToken: true, lineChannelSecret: true, name: true, supportChannelToken: true, supportChannelSecret: true, supportNotifyLineUserId: true, supportBotEnabled: true } } } } },
  })

  for (const lease of leases) {
    const mp = lease.managedProperty
    // 收款帳戶：以委託物業的屋主匯款銀行＋帳號為主，未填才退用房東共用匯款資訊
    const data = {
      ...lease,
      managedTitle: mp.title,
      rentPayInfo: buildPayInfo(mp, mp.landlord ? mp.landlord.rentPayInfo : null),
    }

    // 租金提醒：繳費日前 N 天（只在「本期尚未繳清」時處理，金額以正確期別為準）
    const mode = await modeFor(mp ? mp.landlordId : null)
    if (lease.rentRemindOn && lease.rentPayDay && mode !== 'off') {
      const remindDay = ((lease.rentPayDay - REMIND_BEFORE - 1 + 31) % 31) + 1
      if (today === remindDay && !alreadyRemindedThisMonth(lease.lastRentRemind)) {
        const dueRow = await findDueUnpaidRow(lease)
        if (!dueRow) {
          console.log(`⏭️ 本期已繳清，略過租金提醒：${lease.tenantName}`)
        } else if (mode === 'confirm') {
          // 先推播給房東確認，房東按「確認送出」才會發給房客
          const ok = await sendRentApprovalToLandlord(lease, mp.landlord, dueRow)
          if (ok) await prisma.lease.update({ where: { id: lease.id }, data: { lastRentRemind: new Date() } })
        } else {
          // auto：直接發給房客 + 寫操作紀錄
          const remindData = { ...data, rent: Number(dueRow.amount || lease.rent || 0) }
          try {
            await pushToLeaseTenant(lease, rentReminderFlex(remindData))
            await prisma.lease.update({ where: { id: lease.id }, data: { lastRentRemind: new Date() } })
            await writeReminderAudit(lease, remindData.rent, '系統自動', 'system', '租金提醒（自動發送）')
            console.log(`✅ 已推租金提醒：${lease.tenantName}`)
          } catch (e) {
            console.error(`租金提醒推播失敗（${lease.tenantName}）:`, e.message)
          }
        }
      }
    }

    // 水電提醒：繳費日前 N 天
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

module.exports = { startLeaseReminders, checkLeaseReminders, getClientForLease, getLeaseClients, pushToLeaseTenant, rentReminderFlex, utilReminderFlex, rentReceiptFlex, utilReceiptFlex, settleReceiptFlex, buildPayInfo, handleRentReminderApproval, sendRentReminderTest }
