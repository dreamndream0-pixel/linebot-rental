// src/smartlock.js — 智慧門鎖（TTLock）房客自助取密碼
// 移植自 rubyclean：以「房間 → 門鎖」為單位，後台每個房間可填一個房客 LINE User ID。
// 房客在 LINE 輸入「密碼」→ 依其 User ID 找到對應房間 → 回傳當日密碼。
//   - keypad（普通密碼鎖）：依房號＋日期用固定算式計算（免呼叫 API）
//   - ttlock（TTLock 電子鎖）：呼叫 TTLock API 產生當日限時密碼
//   - traditional（傳統喇叭鎖）：無密碼，提示聯絡房東
// 每個房東各自一組 TTLock 帳號（存於 landlord.ttlockConfig）
const crypto = require('crypto')
const prisma = require('./db')
const { findLineTenant } = require('./tenantStore')

const TTLOCK_BASE = 'https://euapi.ttlock.com'
const FREE_QUOTA = 3          // 每年免費次數
const CHARGE_AMOUNT = 50      // 超過後每次作業費（元）

function md5(input) {
  return crypto.createHash('md5').update(String(input), 'utf8').digest('hex')
}

// ── 建物 / 房號清單（移植自 rubyclean）──
const BUILDINGS = [
  { id: 'HB11', label: '紅寶石 11號', rooms: ['101','102','201','202','301','302','501','502','601','602'] },
  { id: 'HB21', label: '紅寶石 21號', rooms: ['101','102','103','201','202','203','205','301','302','303','305','501','502','503','505','601','602','603','605','801','802'] },
  { id: 'HB28', label: '紅寶石 28號', rooms: ['101','102','103','201','202','203','205','301','302','303','305','501','502','601'] },
  { id: 'ZF22', label: '致富讚 22號', rooms: ['101','102','103','201','202','203','205','301','302','303','305','501','502','503','505','601','602'] },
  { id: 'QY',   label: '青雲巷 25-21號', rooms: ['101','102','201','202','301','302','401','402'] },
]

// ── 門鎖預設值（移植自 rubyclean DEFAULT_LOCK_DB）──
// type: 'keypad' | 'ttlock' | 'traditional'；ids: TTLock lockId（可多把）
const DEFAULT_LOCK_DB = {
  'HB11_101':{ type:'keypad' },
  'HB11_102':{ type:'ttlock', ids:[12753002] },
  'HB11_201':{ type:'keypad' },
  'HB11_202':{ type:'keypad' },
  'HB11_301':{ type:'keypad' },
  'HB11_302':{ type:'keypad' },
  'HB11_501':{ type:'keypad' },
  'HB11_502':{ type:'ttlock', ids:[32882028] },
  'HB11_601':{ type:'keypad' },
  'HB11_602':{ type:'keypad' },
  'HB21_101':{ type:'ttlock', ids:[13800282] },
  'HB21_102':{ type:'ttlock', ids:[32878932] },
  'HB21_103':{ type:'keypad' },
  'HB21_201':{ type:'keypad' },
  'HB21_202':{ type:'keypad' },
  'HB21_203':{ type:'ttlock', ids:[32880434] },
  'HB21_205':{ type:'keypad' },
  'HB21_301':{ type:'ttlock', ids:[24395270] },
  'HB21_302':{ type:'ttlock', ids:[10999534] },
  'HB21_303':{ type:'ttlock', ids:[6376868] },
  'HB21_305':{ type:'ttlock', ids:[16918742] },
  'HB21_501':{ type:'ttlock', ids:[15632352] },
  'HB21_502':{ type:'keypad' },
  'HB21_503':{ type:'ttlock', ids:[20489980] },
  'HB21_505':{ type:'ttlock', ids:[33791528] },
  'HB21_601':{ type:'ttlock', ids:[13604176] },
  'HB21_602':{ type:'ttlock', ids:[10246462] },
  'HB21_603':{ type:'keypad' },
  'HB21_605':{ type:'ttlock', ids:[10767426] },
  'HB21_801':{ type:'ttlock', ids:[13414546] },
  'HB21_802':{ type:'ttlock', ids:[15477822,23388358] },
  'HB28_101':{ type:'traditional' },
  'HB28_102':{ type:'traditional' },
  'HB28_103':{ type:'traditional' },
  'HB28_201':{ type:'traditional' },
  'HB28_202':{ type:'traditional' },
  'HB28_203':{ type:'traditional' },
  'HB28_205':{ type:'traditional' },
  'HB28_301':{ type:'traditional' },
  'HB28_302':{ type:'traditional' },
  'HB28_303':{ type:'traditional' },
  'HB28_305':{ type:'traditional' },
  'HB28_501':{ type:'traditional' },
  'HB28_502':{ type:'traditional' },
  'HB28_601':{ type:'traditional' },
  'ZF22_101':{ type:'ttlock', ids:[5581676] },
  'ZF22_102':{ type:'ttlock', ids:[5581754] },
  'ZF22_103':{ type:'ttlock', ids:[5564488] },
  'ZF22_201':{ type:'ttlock', ids:[9752434] },
  'ZF22_202':{ type:'ttlock', ids:[5581690] },
  'ZF22_203':{ type:'ttlock', ids:[5564320] },
  'ZF22_205':{ type:'ttlock', ids:[5581600] },
  'ZF22_301':{ type:'ttlock', ids:[5564472] },
  'ZF22_302':{ type:'ttlock', ids:[5581734] },
  'ZF22_303':{ type:'ttlock', ids:[5564492] },
  'ZF22_305':{ type:'keypad' },
  'ZF22_501':{ type:'keypad' },
  'ZF22_502':{ type:'keypad' },
  'ZF22_503':{ type:'keypad' },
  'ZF22_505':{ type:'keypad' },
  'ZF22_601':{ type:'keypad' },
  'ZF22_602':{ type:'keypad' },
  'QY_101':{ type:'keypad' },
  'QY_102':{ type:'keypad' },
  'QY_201':{ type:'keypad' },
  'QY_202':{ type:'keypad' },
  'QY_301':{ type:'keypad' },
  'QY_302':{ type:'keypad' },
  'QY_401':{ type:'keypad' },
  'QY_402':{ type:'keypad' },
}

// roomKey（HB11_101）→ 建物 label（紅寶石 11號）
function buildingLabelOf(roomKey) {
  const bid = String(roomKey || '').split('_')[0]
  const b = BUILDINGS.find(x => x.id === bid)
  return b ? b.label : ''
}

// 普通密碼鎖：依房號＋日期計算固定密碼（移植自 rubyclean calcKeypadPassword）
function calcKeypadPassword(room, dateObj) {
  const d = dateObj || new Date()
  const dow = d.getDay() === 0 ? 7 : d.getDay()
  const roomStr = String(room).replace(/[^0-9]/g, '')
  const r1 = parseInt(roomStr[0]) || 0
  const r3 = parseInt(roomStr[2]) || 0
  const isOdd = dow % 2 === 1
  const d1 = isOdd ? dow - 1 : dow + 1
  const reversed = roomStr.split('').reverse().join('')
  const raw = isOdd ? r1 - r3 : r1 + r3
  const d5 = ((raw % 10) + 10) % 10
  const d6 = d1 + 1
  return `${d1}${reversed}${d5}${d6}#`
}

// 台北時區日期字串 YYYY-MM-DD
function taipeiDateStr(ms = Date.now()) {
  const d = new Date(ms + 8 * 3600 * 1000)
  return d.getUTCFullYear() + '-' +
    String(d.getUTCMonth() + 1).padStart(2, '0') + '-' +
    String(d.getUTCDate()).padStart(2, '0')
}

// 台北「現在」時間（getDay() 依台北星期計算密碼鎖）
function taipeiNow(ms = Date.now()) {
  return new Date(ms + 8 * 3600 * 1000)
}

// 今日 TTLock 密碼有效區間：現在 → 台北「隔天 00:00」（涵蓋整個今天）
// 註：TTLock 會把 endDate 無條件捨去（觀察到 23:59:59 被砍成 23:30 提早失效），
// 故 end 用隔天 00:00 的整點邊界，確保全天到午夜都有效。
function taipeiTodayWindow() {
  const now = Date.now()
  const d = new Date(now + 8 * 3600 * 1000)
  const endUtc = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1, 0, 0, 0) - 8 * 3600 * 1000
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

// 解析房東的門鎖房間設定（{ roomKey: { type, ids, userId } }）
function parseRooms(landlord) {
  if (!landlord || !landlord.lockRooms) return {}
  try {
    const r = JSON.parse(landlord.lockRooms)
    return (r && typeof r === 'object') ? r : {}
  } catch { return {} }
}

// 解析房東的門鎖用量／帳款（{ userId: { year, issued, todayDate, todayData, charges } }）
function parseUsage(landlord) {
  if (!landlord || !landlord.lockUsage) return {}
  try {
    const u = JSON.parse(landlord.lockUsage)
    return (u && typeof u === 'object') ? u : {}
  } catch { return {} }
}

function unpaidTotal(charges) {
  if (!Array.isArray(charges)) return 0
  return charges.filter(c => !c.paid).reduce((s, c) => s + (c.amount || 0), 0)
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

// 確認索取（第二步）的關鍵字
const CONFIRM_TEXT = '確認索取密碼'
function isPasscodeConfirm(text) {
  return /確認索取密碼|确认索取密码|確認取密碼/.test(text || '')
}

// 是否為索取密碼的訊息（第一步）；排除「確認索取」關鍵字
function isPasscodeRequest(text) {
  if (isPasscodeConfirm(text)) return false
  return /密碼|密码|門鎖密碼|门锁密码|開門|开门|開鎖|开锁/.test(text || '')
}

// 第一步：房客索取密碼 → 回傳「確認索取」卡片（顯示次數，不產生密碼、不計次）
// 回傳：LINE message 物件；房東未授權 → null
async function handleTenantPasscodePrompt(landlordId, lineUserId) {
  if (!landlordId || !lineUserId) return null
  let landlord
  try {
    landlord = await prisma.landlord.findUnique({
      where: { id: landlordId },
      select: { id: true, features: true, lockRooms: true, lockUsage: true },
    })
  } catch (e) { return null }
  if (!landlordHasSmartlock(landlord)) return null

  let tenantName = ''
  try { const t = await findLineTenant(lineUserId, landlordId); if (t) tenantName = t.customName || t.name || '' } catch (e) {}
  const who = tenantName || '房客'

  const rooms = parseRooms(landlord)
  const matched = Object.keys(rooms).filter(k => rooms[k] && rooms[k].userId && String(rooms[k].userId).trim() === String(lineUserId).trim())
  if (matched.length === 0) {
    return { type: 'text', text: `${who} 您好，您尚未綁定門鎖，請聯絡房東為您設定後即可自助取當日密碼。` }
  }

  const today = taipeiDateStr()
  const year = Number(today.slice(0, 4))
  const usage = parseUsage(landlord)
  const u = usage[lineUserId] || {}
  const alreadyToday = !!(u.todayDate === today && u.todayData)
  const issuedThisYear = (u.year === year) ? (u.issued || 0) : 0

  let infoText
  if (alreadyToday) {
    infoText = '您今日已索取過，將顯示同一組密碼（不另計次、不重複收費）。'
  } else {
    const n = issuedThisYear + 1
    const charged = n > FREE_QUOTA
    infoText = `本年度已索取 ${issuedThisYear} 次（每年前 ${FREE_QUOTA} 次免費）。\n本次為第 ${n} 次，` +
      (charged ? `需收取作業費 ${CHARGE_AMOUNT} 元。` : '免費。')
  }

  return {
    type: 'flex',
    altText: '請確認索取門鎖密碼',
    contents: {
      type: 'bubble',
      header: {
        type: 'box', layout: 'vertical', backgroundColor: '#6B5A9A', paddingAll: '16px',
        contents: [{ type: 'text', text: '🔐 索取門鎖密碼', weight: 'bold', size: 'lg', color: '#ffffff' }],
      },
      body: {
        type: 'box', layout: 'vertical', spacing: 'sm',
        contents: [
          { type: 'text', text: `${who} 您好`, weight: 'bold', size: 'md' },
          { type: 'text', text: infoText, size: 'sm', color: '#666666', wrap: true, margin: 'sm' },
          { type: 'text', text: '確認後將顯示今日門鎖密碼。', size: 'xs', color: '#999999', margin: 'md', wrap: true },
        ],
      },
      footer: {
        type: 'box', layout: 'vertical',
        contents: [{
          type: 'button', style: 'primary', color: '#6B5A9A',
          action: { type: 'message', label: '確認索取密碼', text: CONFIRM_TEXT },
        }],
      },
    },
  }
}

// 核心：房客索取密碼
// 回傳：LINE message 物件；若房東未授權 smartlock → 回傳 null（讓 Bot 略過此訊息）
async function handleTenantPasscode(landlordId, lineUserId) {
  if (!landlordId || !lineUserId) return null

  let landlord
  try {
    landlord = await prisma.landlord.findUnique({
      where: { id: landlordId },
      select: { id: true, features: true, ttlockConfig: true, lockRooms: true, lockUsage: true },
    })
  } catch (e) { return null }

  // 功能未授權 → 略過（不回應，避免干擾其他房東）
  if (!landlordHasSmartlock(landlord)) return null

  // 房客 LINE 名稱（優先用房東備註名，其次 LINE 顯示名）
  let tenantName = ''
  try {
    const t = await findLineTenant(lineUserId, landlordId)
    if (t) tenantName = t.customName || t.name || ''
  } catch (e) {}
  const who = tenantName || '房客'

  const rooms = parseRooms(landlord)
  // 找出所有綁定此 User ID 的房間
  const matched = Object.keys(rooms)
    .filter(k => rooms[k] && rooms[k].userId && String(rooms[k].userId).trim() === String(lineUserId).trim())
    .map(k => ({ key: k, type: rooms[k].type, ids: rooms[k].ids }))

  if (matched.length === 0) {
    return { type: 'text', text: `${who} 您好，您尚未綁定門鎖，請聯絡房東為您設定後即可自助取當日密碼。` }
  }

  const today = taipeiDateStr()
  const now = taipeiNow()
  const year = Number(today.slice(0, 4))

  // 同一天重複索取 → 回傳同一組密碼，不計次、不重複收費
  const usage = parseUsage(landlord)
  const u = usage[lineUserId] || {}
  if (u.todayDate === today && u.todayData) {
    // 同一天重複索取 → 回同一組密碼，不計次、不重複收費
    let entries = Array.isArray(u.todayData.entries) ? u.todayData.entries : null
    // 相容舊版快取（只存 lines 字串陣列）
    if (!entries && Array.isArray(u.todayData.lines)) {
      entries = u.todayData.lines.map(function (l) {
        const i = String(l).indexOf('：')
        return i >= 0 ? { label: l.slice(0, i), value: l.slice(i + 1) } : { label: '', value: String(l) }
      })
    }
    if (entries && entries.length) {
      return renderPasscodeReply(who, entries, today, u.todayData.n, u.todayData.charged)
    }
  }

  // 有 TTLock 房間才連線取 token
  const needsTtlock = matched.some(r => r.type === 'ttlock' && Array.isArray(r.ids) && r.ids.length)
  let creds = null, token = null
  if (needsTtlock) {
    creds = parseCreds(landlord)
    if (!creds) return { type: 'text', text: '門鎖服務尚未設定完成，請聯絡房東。' }
    token = await getToken(creds)
    if (!token.access_token) {
      return { type: 'text', text: '系統暫時無法連線門鎖服務，請稍後再試。' }
    }
  }

  const { startDate, endDate } = taipeiTodayWindow()
  const entries = []   // { label, value, muted? }
  for (const r of matched) {
    const roomNo = r.key.split('_').slice(1).join('_')
    const bl = buildingLabelOf(r.key)
    const label = (bl ? bl + ' ' : '') + roomNo
    if (r.type === 'keypad') {
      entries.push({ label, value: calcKeypadPassword(roomNo, now) })
    } else if (r.type === 'ttlock' && Array.isArray(r.ids) && r.ids.length) {
      for (let i = 0; i < r.ids.length; i++) {
        const name = `房客密碼-${today}` + (r.ids.length > 1 ? `-${i + 1}` : '')
        const pw = await generatePasscode(token.access_token, creds, r.ids[i], startDate, endDate, name)
        const rlabel = label + (r.ids.length > 1 ? `（門鎖 ${i + 1}）` : '')
        if (!pw || !pw.keyboardPwd) {
          entries.push({ label: rlabel, value: '產生失敗，請稍後再試', muted: true })
        } else {
          entries.push({ label: rlabel, value: pw.keyboardPwd + '#' })
        }
      }
    } else {
      entries.push({ label, value: '傳統鎖，無密碼', muted: true })
    }
  }

  // 計次／計費（每年重置；前 FREE_QUOTA 次免費，之後每次 CHARGE_AMOUNT 元）
  const issuedBase = (u.year === year) ? (u.issued || 0) : 0
  const n = issuedBase + 1
  const charged = n > FREE_QUOTA
  const charges = (u.year === year && Array.isArray(u.charges)) ? u.charges.slice() : []
  if (charged) charges.push({ date: today, amount: CHARGE_AMOUNT, paid: false })

  usage[lineUserId] = {
    name: who,
    year,
    issued: n,
    todayDate: today,
    todayData: { entries, n, charged },
    charges,
  }
  try {
    await prisma.landlord.update({ where: { id: landlordId }, data: { lockUsage: JSON.stringify(usage) } })
  } catch (e) { console.error('更新門鎖用量失敗:', e.message) }

  return renderPasscodeReply(who, entries, today, n, charged)
}

// 組回覆訊息（Flex 卡片，風格比照租金/水電繳費提醒）
function renderPasscodeReply(who, entries, today, n, charged) {
  const rows = entries.map(e => ({
    type: 'box', layout: 'baseline', margin: 'md', contents: [
      { type: 'text', text: e.label, size: 'sm', color: '#999999', flex: 4, wrap: true },
      { type: 'text', text: e.value, size: e.muted ? 'sm' : 'lg', flex: 5, weight: 'bold', wrap: true,
        color: e.muted ? '#aaaaaa' : '#6B5A9A' },
    ],
  }))
  const feeText = charged
    ? `⚠️ 本年度第 ${n} 次索取，已收取作業費 ${CHARGE_AMOUNT} 元並記入帳款。`
    : `本年度第 ${n} 次（每年前 ${FREE_QUOTA} 次免費，尚餘 ${Math.max(0, FREE_QUOTA - n)} 次）`
  const altPw = entries.map(e => `${e.label}：${e.value}`).join('\n')
  return {
    type: 'flex',
    altText: `🔐 門鎖密碼\n${altPw}`,
    contents: {
      type: 'bubble',
      header: {
        type: 'box', layout: 'vertical', backgroundColor: '#6B5A9A', paddingAll: '16px',
        contents: [{ type: 'text', text: '🔐 門鎖密碼', weight: 'bold', size: 'lg', color: '#ffffff' }],
      },
      body: {
        type: 'box', layout: 'vertical', spacing: 'sm',
        contents: [
          { type: 'text', text: `${who} 您好`, weight: 'bold', size: 'md' },
          { type: 'text', text: `以下是您 ${today} 的門鎖密碼`, size: 'sm', color: '#666666', wrap: true },
          { type: 'separator', margin: 'md' },
          ...rows,
          { type: 'separator', margin: 'md' },
          { type: 'text', text: '有效至今日 23:59', size: 'xs', color: '#999999', margin: 'md' },
          { type: 'text', text: feeText, size: 'xs', color: charged ? '#C0504D' : '#aaaaaa', margin: 'sm', wrap: true },
        ],
      },
    },
  }
}

module.exports = {
  md5,
  taipeiDateStr,
  taipeiNow,
  taipeiTodayWindow,
  parseCreds,
  parseRooms,
  parseUsage,
  unpaidTotal,
  landlordHasSmartlock,
  getToken,
  listLocks,
  generatePasscode,
  calcKeypadPassword,
  isPasscodeRequest,
  isPasscodeConfirm,
  handleTenantPasscodePrompt,
  handleTenantPasscode,
  BUILDINGS,
  DEFAULT_LOCK_DB,
  buildingLabelOf,
  FREE_QUOTA,
  CHARGE_AMOUNT,
}
