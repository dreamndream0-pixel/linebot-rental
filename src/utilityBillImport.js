// src/utilityBillImport.js — 從 Gmail 匯入台電電費帳單，建立為委託物業的支出
// 依賴（延遲載入，避免未安裝時影響啟動）：imapflow、mailparser
const prisma = require('./db')

const TAIPOWER_FROM = 'ebill@ebppsmtp.taipower.com.tw'

// 全形數字→半形
function normDigits(s) {
  return String(s || '').replace(/[０-９]/g, c => String.fromCharCode(c.charCodeAt(0) - 0xFEE0))
}
// 地址正規化：全形轉半形、去空白、去遮罩星號（＊/*）
function normAddr(s) {
  return normDigits(s).replace(/[＊*\s]/g, '')
}

// 解析台電 e-bill 純文字，取出每個電號的金額與用電地址、期別
// 支援「繳費憑證(繳付金額)」與「電費通知(應繳總金額)」兩種格式
function parseTaipowerText(text, subject) {
  const t = String(text || '')
  const subj = String(subject || '')
  // 期別（民國年月）：主旨或內文「115 年 6 月」
  let period = null
  const pm = (subj + ' ' + t).match(/(\d{3})\s*年\s*(\d{1,2})\s*月/)
  if (pm) {
    const year = parseInt(pm[1]) + 1911  // 民國→西元
    period = { year, month: parseInt(pm[2]), key: year + '-' + String(parseInt(pm[2])).padStart(2, '0') }
  }
  const lines = t.split(/\r?\n/).map(l => l.trim())
  const bills = []
  for (let i = 0; i < lines.length; i++) {
    if (!/^\d{10,12}$/.test(lines[i])) continue  // 電號為 11 碼數字（保留 10~12 容錯）
    const elecNo = lines[i]
    let amount = null, address = null
    for (let j = i + 1; j < Math.min(i + 10, lines.length); j++) {
      const ln = lines[j]
      // 金額：純數字（可含千分位逗號），排除含斜線的日期、含星號的帳號
      if (amount == null && /^[\d,]+$/.test(ln) && ln.replace(/[^\d]/g, '').length >= 2) {
        amount = parseInt(ln.replace(/,/g, '')) || null
      }
      if (ln === '用電地址' && lines[j + 1]) { address = lines[j + 1]; break }
    }
    if (amount != null) bills.push({ elecNo, amount, address: address || '' })
  }
  return { period, bills }
}

// 從地址取門牌號（巷XX號 的 XX；支援 25-21 這種）
function extractDoorNo(addr) {
  const a = normAddr(addr)
  const m = a.match(/巷(\d+(?:-\d+)?)號/) || a.match(/(\d+(?:-\d+)?)號/)
  return m ? m[1] : null
}
// 台電帳單地址 → 委託物業
function matchProperty(address, properties) {
  const no = extractDoorNo(address)
  if (!no) return null
  const key = '巷' + no + '號'
  let p = properties.find(x => normAddr(x.address).includes(key))
  if (p) return p
  p = properties.find(x => normAddr(x.title).includes(no + '號') || normAddr(x.address).includes(no + '號'))
  return p || null
}

// 讀 Gmail 台電信 → 回傳 [{ subject, text, date }]
async function fetchTaipowerEmails(sinceDays = 150, limit = 24) {
  const user = process.env.GMAIL_IMAP_USER
  const pass = process.env.GMAIL_IMAP_PASSWORD
  if (!user || !pass) { const e = new Error('Gmail 未設定（缺 GMAIL_IMAP_USER / GMAIL_IMAP_PASSWORD 環境變數）'); e.code = 'NO_CONFIG'; throw e }
  const { ImapFlow } = require('imapflow')
  const { simpleParser } = require('mailparser')
  const client = new ImapFlow({
    host: process.env.GMAIL_IMAP_HOST || 'imap.gmail.com',
    port: 993, secure: true, auth: { user, pass }, logger: false,
  })
  const out = []
  await client.connect()
  try {
    await client.mailboxOpen('INBOX')
    const since = new Date(Date.now() - sinceDays * 86400000)
    const uids = await client.search({ from: TAIPOWER_FROM, since }, { uid: true })
    const pick = (uids || []).slice(-limit)
    for (const uid of pick) {
      const msg = await client.fetchOne(uid, { source: true }, { uid: true })
      if (!msg || !msg.source) continue
      const parsed = await simpleParser(msg.source)
      out.push({ subject: parsed.subject || '', text: parsed.text || '', date: parsed.date || null })
    }
  } finally {
    try { await client.logout() } catch (e) { /* ignore */ }
  }
  return out
}

// 匯入主流程：讀信→解析→對物業→（預覽或建立）支出
// opts: { properties, apply }
async function importTaipowerBills({ properties, apply = false }) {
  const emails = await fetchTaipowerEmails()
  // 以「物業 + 期別」彙總同址各電號金額
  const groups = {}   // key: propId|periodKey
  const unmatched = []
  for (const em of emails) {
    const { period, bills } = parseTaipowerText(em.text, em.subject)
    const pkey = period ? period.key : (em.date ? new Date(em.date).toISOString().slice(0, 7) : '未知')
    for (const b of bills) {
      const prop = matchProperty(b.address, properties)
      if (!prop) { unmatched.push({ address: b.address, elecNo: b.elecNo, amount: b.amount, period: pkey }); continue }
      const gk = prop.id + '|' + pkey
      if (!groups[gk]) groups[gk] = { propertyId: prop.id, propertyTitle: prop.title, period: pkey, periodObj: period, amount: 0, elecNos: [] }
      groups[gk].amount += b.amount
      groups[gk].elecNos.push(b.elecNo)
    }
  }
  const items = Object.values(groups)
  // 標記是否已匯入（依 description 前綴防重複）
  const results = []
  for (const it of items) {
    const marker = '[台電匯入 ' + it.period + ']'
    const existing = await prisma.managementRecord.findFirst({
      where: { managedPropertyId: it.propertyId, type: 'EXPENSE', category: 'UTILITY', description: { startsWith: marker } },
      select: { id: true },
    })
    const already = !!existing
    let created = false
    if (apply && !already && it.amount > 0) {
      const [y, m] = it.period.split('-').map(Number)
      const recordDate = (y && m) ? new Date(y, m - 1, 15) : new Date()
      await prisma.managementRecord.create({
        data: {
          managedPropertyId: it.propertyId, leaseId: null,
          type: 'EXPENSE', category: 'UTILITY', amount: it.amount, recordDate,
          description: marker + ' 台電電費（電號 ' + it.elecNos.join('、') + '）',
        },
      })
      created = true
    }
    results.push({ ...it, already, created })
  }
  results.sort((a, b) => (a.propertyTitle + a.period).localeCompare(b.propertyTitle + b.period))
  return {
    ok: true, emailCount: emails.length,
    items: results, unmatched,
    createdCount: results.filter(r => r.created).length,
    skippedCount: results.filter(r => r.already).length,
  }
}

module.exports = { importTaipowerBills, parseTaipowerText, matchProperty, extractDoorNo, normAddr }
