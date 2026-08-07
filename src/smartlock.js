// src/smartlock.js — 智慧門鎖（TTLock）房客自助取密碼
// 每個房東各自一組 TTLock 帳號（存於 landlord.ttlockConfig）
// 房客綁定由後台手動維護（LockTenant），只有綁定的 LINE User ID 能索取
// 規則：密碼當天有效、同日同碼；免費 3 次/年（每年重置），第 4 次起每次收 50 元
const crypto = require('crypto')
const prisma = require('./db')

const TTLOCK_BASE = 'https://euapi.ttlock.com'
const FREE_QUOTA = 3          // 每年免費次數
const CHARGE_AMOUNT = 50      // 超過後每次作業費

function md5(input) {
  return crypto.createHash('md5').update(String(input), 'utf8').digest('hex')
}

// 台北時區日期字串 YYYY-MM-DD
function taipeiDateStr(ms = Date.now()) {
  const d = new Date(ms + 8 * 3600 * 1000)
  return d.getUTCFullYear() + '-' +
    String(d.getUTCMonth() + 1).padStart(2, '0') + '-' +
    String(d.getUTCDate()).padStart(2, '0')
}

// 今日密碼有效區間：現在 → 台北當日 23:59:59
function taipeiTodayWindow() {
  const now = Date.now()
  const d = new Date(now + 8 * 3600 * 1000)
  const endUtc = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 23, 59, 59) - 8 * 3600 * 1000
  return { startDate: now, endDate: endUtc }
}

// 解析房東的 TTLock 帳密
function parseCreds(landlord) {
  if (!landlord || !landlord.ttlockConfig) return null
  let c
  try { c = JSON.parse(landlord.ttlockConfig) } catch { return null }
  if (!c || !c.clientId || !c.clientSecret || !c.username || !c.password) return null
  return c
}

// 是否已授權 smartlock 功能
function landlordHasSmartlock(landlord) {
  if (!landlord) return false
  let f = {}
  try { f = landlord.features ? JSON.parse(landlord.features) : {} } catch { f = {} }
  return f.smartlock === true
}

// 取得 TTLock access token
async function getToken(creds) {
  const body = new URLSearchParams({
    clientId: creds.clientId,
    clientSecret: creds.clientSecret,
    username: creds.username,
    password: md5(creds.password),
    grant_type: 'password',
  })
  const resp = await fetch(`${TTLOCK_BASE}/oauth2/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  })
  return resp.json()
}

// 列出房東 TTLock 帳號下所有門鎖
async function listLocks(creds) {
  const token = await getToken(creds)
  if (!token.access_token) return { error: 'token failed', detail: token }
  const api = new URL(`${TTLOCK_BASE}/v3/lock/list`)
  api.searchParams.set('clientId', creds.clientId)
  api.searchParams.set('accessToken', token.access_token)
  api.searchParams.set('pageNo', '1')
  api.searchParams.set('pageSize', '200')
  api.searchParams.set('date', String(Date.now()))
  const resp = await fetch(api, { method: 'GET' })
  const data = await resp.json()
  const list = (data.list || []).map(l => ({
    lockId: l.lockId,
    name: l.lockAlias || l.lockName,
  }))
  return { total: data.total, count: list.length, list }
}

// 產生一組限時鍵盤密碼
async function generatePasscode(accessToken, creds, lockId, startDate, endDate, name) {
  const body = new URLSearchParams({
    clientId: creds.clientId,
    accessToken,
    lockId: String(lockId),
    keyboardPwdVersion: '4',
    keyboardPwdType: '3',
    keyboardPwdName: name,
    startDate: String(startDate),
    endDate: String(endDate),
    date: String(Date.now()),
  })
  const resp = await fetch(`${TTLOCK_BASE}/v3/keyboardPwd/get`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  })
  return resp.json()
}

// 組回覆訊息
function renderReply(passcodes, n, charged, dateStr) {
  const lines = passcodes.length > 1
    ? passcodes.map((p, i) => `門鎖 ${i + 1}：${p.pw}`).join('\n')
    : `門鎖密碼：${passcodes[0].pw}`
  let msg = `🔐 ${lines}\n有效至今日 23:59（${dateStr}）`
  if (charged) {
    msg += `\n⚠️ 本次為本年度第 ${n} 次索取，收取作業費 ${CHARGE_AMOUNT} 元，已記入您的帳款。`
  } else {
    msg += `\n（本年度第 ${n} 次，免費）`
  }
  return msg
}

// 是否為索取密碼的訊息
function isPasscodeRequest(text) {
  return /密碼|密码|門鎖密碼|门锁密码|開門|开门|開鎖|开锁/.test(text || '')
}

// 核心：房客索取密碼
// 回傳：LINE message 物件；若房東未授權 smartlock → 回傳 null（讓 Bot 略過此訊息）
async function handleTenantPasscode(landlordId, lineUserId) {
  if (!landlordId || !lineUserId) return null

  let landlord
  try {
    landlord = await prisma.landlord.findUnique({
      where: { id: landlordId },
      select: { id: true, features: true, ttlockConfig: true },
    })
  } catch (e) { return null }

  // 功能未授權 → 略過（不回應，避免干擾其他房東）
  if (!landlordHasSmartlock(landlord)) return null

  const creds = parseCreds(landlord)
  if (!creds) {
    return { type: 'text', text: '門鎖服務尚未設定完成，請聯絡房東。' }
  }

  const t = await prisma.lockTenant.findUnique({
    where: { landlordId_lineUserId: { landlordId, lineUserId } },
  })
  if (!t || !Array.isArray(t.lockIds) || t.lockIds.length === 0) {
    return { type: 'text', text: '您尚未開通門鎖密碼服務，請聯絡房東。' }
  }

  const today = taipeiDateStr()
  const year = Number(today.slice(0, 4))

  // 當天重複索取 → 回傳同一組密碼（不計次、不收費）
  if (t.todayDate === today && t.todayData && Array.isArray(t.todayData.passcodes) && t.todayData.passcodes.length) {
    return { type: 'text', text: renderReply(t.todayData.passcodes, t.todayData.n, t.todayData.charged, today) }
  }

  // 每年重置免費額度
  const issuedBase = (t.year === year) ? (t.issuedThisYear || 0) : 0
  const n = issuedBase + 1
  const charged = n > FREE_QUOTA

  const token = await getToken(creds)
  if (!token.access_token) {
    return { type: 'text', text: '系統暫時無法連線門鎖服務，請稍後再試。' }
  }

  const { startDate, endDate } = taipeiTodayWindow()
  const passcodes = []
  for (let i = 0; i < t.lockIds.length; i++) {
    const lockId = t.lockIds[i]
    const name = `房客密碼-${today}` + (t.lockIds.length > 1 ? `-${i + 1}` : '')
    const pw = await generatePasscode(token.access_token, creds, lockId, startDate, endDate, name)
    if (!pw || !pw.keyboardPwd) {
      return { type: 'text', text: '產生密碼失敗，請稍後再試或聯絡房東。' }
    }
    passcodes.push({ lockId, pw: pw.keyboardPwd + '#', keyboardPwdId: pw.keyboardPwdId })
  }

  // 產生成功才記次 / 記帳
  const charges = Array.isArray(t.charges) ? t.charges : []
  if (charged) charges.push({ date: today, amount: CHARGE_AMOUNT, paid: false })

  try {
    await prisma.lockTenant.update({
      where: { id: t.id },
      data: {
        year,
        issuedThisYear: n,
        todayDate: today,
        todayData: { passcodes, n, charged },
        charges,
      },
    })
  } catch (e) {
    console.error('更新門鎖用量失敗:', e.message)
  }

  return { type: 'text', text: renderReply(passcodes, n, charged, today) }
}

module.exports = {
  md5,
  taipeiDateStr,
  taipeiTodayWindow,
  parseCreds,
  landlordHasSmartlock,
  getToken,
  listLocks,
  generatePasscode,
  isPasscodeRequest,
  handleTenantPasscode,
  FREE_QUOTA,
  CHARGE_AMOUNT,
}
