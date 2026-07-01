const prisma = require('./db')
const { findLineTenant, upsertLineTenant } = require('./tenantStore')

// ── 流量限制：每位用戶每分鐘最多 10 則訊息 ──────────────────────
const rateLimitMap = new Map() // userId → { count, resetAt }
function isRateLimited(userId) {
  const now = Date.now()
  const entry = rateLimitMap.get(userId)
  if (!entry || now > entry.resetAt) {
    rateLimitMap.set(userId, { count: 1, resetAt: now + 60_000 })
    return false
  }
  entry.count++
  if (entry.count > 10) return true
  return false
}
// 每小時清除過期記錄，避免 Map 無限增長
setInterval(() => {
  const now = Date.now()
  for (const [id, e] of rateLimitMap) {
    if (now > e.resetAt) rateLimitMap.delete(id)
  }
}, 3_600_000)

// ── 通知房東（依房源歸屬，找不到則退回主帳號 OWNER） ────────────
// landlordId: 房源的歸屬房東；client: 該房東 Bot 的 client（可推給該房東）
async function notifyLandlord(landlordId, message, fallbackClient) {
  // 找房東的接收 ID
  let landlord = null
  if (landlordId) {
    try {
      landlord = await prisma.landlord.findUnique({
        where: { id: landlordId },
        select: { notifyLineUserId: true, lineChannelToken: true, lineChannelSecret: true }
      })
    } catch (e) { console.error('查房東通知設定失敗:', e.message) }
  }

  // 優先：房東有設定接收 ID + 自己的 Bot → 用房東自己的 Bot 推給房東
  if (landlord && landlord.notifyLineUserId && landlord.lineChannelToken) {
    try {
      const { Client } = require('@line/bot-sdk')
      const llClient = new Client({
        channelAccessToken: landlord.lineChannelToken,
        channelSecret: landlord.lineChannelSecret || '',
      })
      await llClient.pushMessage(landlord.notifyLineUserId, { type: 'text', text: message })
      return
    } catch (e) { console.error('通知房東失敗（房東 Bot）:', e.message) }
  }

  // 退回：推給主帳號 OWNER（你）
  if (process.env.OWNER_LINE_USER_ID && fallbackClient) {
    try {
      await fallbackClient.pushMessage(process.env.OWNER_LINE_USER_ID, { type: 'text', text: message })
    } catch (e) { console.error('通知房東失敗（fallback）:', e.message) }
  }
}

// ── 主選單 Flex Message ──────────────────────────────────────────
function mainMenu(t = {}) {
  return {
    type: 'flex',
    altText: '小蝸出租 - 主選單',
    contents: {
      type: 'bubble',
      size: 'mega',
      header: {
        type: 'box',
        layout: 'vertical',
        contents: [
          { type: 'text', text: t.menuTitle || '🐌 小蝸出租', weight: 'bold', size: 'xl', color: '#ffffff' },
          { type: 'text', text: t.menuSubtitle || '請選擇服務項目', size: 'sm', color: '#ffffff99' }
        ],
        backgroundColor: '#7A9E7E',
        paddingAll: '20px'
      },
      body: {
        type: 'box',
        layout: 'vertical',
        spacing: 'sm',
        contents: [
          t.showListRooms !== false ? menuButton(t.btnListRooms || '🏠 查詢空房', '查詢空房') : null,
          t.showBookVisit !== false ? menuButton(t.btnBookVisit || '📅 預約看房', '預約看房') : null,
          t.showReportRepair !== false ? menuButton(t.btnReportRepair || '🔧 維修回報', '維修回報') : null,
          t.showMyBookings !== false ? menuButton(t.btnMyBookings || '📋 我的預約', '我的預約') : null,
          t.showMoreRooms !== false && t._siteUrl ? menuUriButton(t.btnMoreRooms || '🔗 更多房源', t._siteUrl) : null,
          { type: 'separator', margin: 'md' },
          { type: 'text', text: t.searchHint || '💡 也可直接輸入條件搜尋', size: 'xs', color: '#888888', margin: 'md', wrap: true },
          { type: 'text', text: t.searchExample || '例如：台中市 沙鹿區 5000-8000', size: 'xs', color: '#aaaaaa', wrap: true },
        ].filter(Boolean)
      }
    }
  }
}

function menuButton(label, action) {
  return {
    type: 'button',
    action: { type: 'message', label, text: action },
    style: 'secondary',
    height: 'sm',
    margin: 'sm'
  }
}

function menuUriButton(label, uri) {
  return {
    type: 'button',
    action: { type: 'uri', label, uri },
    style: 'secondary',
    height: 'sm',
    margin: 'sm'
  }
}

// ── 空房列表（讀取統一資料庫的 AVAILABLE 房源） ──────────────────
const TYPE_LABEL = { SUITE: '套房', ROOM: '雅房', WHOLE_FLOOR: '整層住家', SHARED_SUITE: '分租套房', STUDIO: '獨立套房', STORE: '店面', OFFICE: '辦公', LIVE_OFFICE: '住辦', FACTORY: '廠房', PARKING: '車位', LAND: '土地', OTHER: '其他' }
const SITE_URL = process.env.SITE_URL || 'https://xiaowo-rental.vercel.app'

// ── 把房源陣列轉成 Flex 卡片輪播（list 與 search 共用） ──────────
function roomsToCarousel(rooms, altText, t = {}) {
  const bubbles = rooms.map(room => {
    // 只接受有效的 https 圖片網址，否則不放 hero（避免 LINE 400 錯誤）
    const firstUrl = room.images && room.images[0] ? room.images[0].url : null
    const coverUrl = (firstUrl && typeof firstUrl === 'string' && firstUrl.startsWith('https://')) ? firstUrl : null
    return {
      type: 'bubble',
      size: 'kilo',
      hero: coverUrl ? {
        type: 'image',
        url: coverUrl,
        size: 'full',
        aspectRatio: '20:13',
        aspectMode: 'cover'
      } : undefined,
      body: {
        type: 'box',
        layout: 'vertical',
        spacing: 'sm',
        contents: [
          { type: 'text', text: room.title, weight: 'bold', size: 'lg', wrap: true },
          { type: 'text', text: `${room.city}${room.district} · ${TYPE_LABEL[room.type] || ''}`, size: 'xs', color: '#aaaaaa' },
          {
            type: 'box', layout: 'horizontal', contents: [
              { type: 'text', text: `💰 NT$ ${room.price.toLocaleString()} / 月`, size: 'sm', color: '#7A9E7E', flex: 1 },
              room.size ? { type: 'text', text: `📐 ${room.size} 坪`, size: 'sm', color: '#888888', flex: 1 } : null
            ].filter(Boolean)
          },
        ].filter(Boolean)
      },
      footer: {
        type: 'box',
        layout: 'vertical',
        spacing: 'sm',
        contents: [
          {
            type: 'button',
            action: {
              type: 'uri',
              label: '🔍 查看詳情',
              uri: `${SITE_URL}/property/${room.id}${room.ownerId ? '?site=' + room.ownerId : ''}`
            },
            style: 'secondary',
            height: 'sm'
          },
          {
            type: 'button',
            action: { type: 'postback', label: t.bookButtonLabel || '📅 預約看房', data: `BOOK_${room.id}`, displayText: `預約 ${room.title}` },
            style: 'primary',
            color: '#7A9E7E',
            height: 'sm'
          }
        ]
      }
    }
  })

  // 最後一張：「看更多房型」連結到房東官網（僅限有 siteUrl 的房東 Bot）
  if (t._siteUrl) {
    bubbles.push({
      type: 'bubble',
      size: 'kilo',
      styles: { body: { backgroundColor: '#F4F8F4' } },
      body: {
        type: 'box',
        layout: 'vertical',
        paddingAll: 'xl',
        paddingTop: 'xxl',
        contents: [
          { type: 'text', text: '🏘️', size: '3xl', align: 'center' },
          { type: 'text', text: t.btnMoreRooms || '看更多房型', weight: 'bold', size: 'xl', align: 'center', margin: 'lg', color: '#2F6B46' },
          { type: 'text', text: '前往官網瀏覽所有最新房源', size: 'sm', color: '#888888', align: 'center', wrap: true, margin: 'sm' }
        ]
      },
      footer: {
        type: 'box',
        layout: 'vertical',
        contents: [
          {
            type: 'button',
            action: { type: 'uri', label: '🌐 前往官網', uri: t._siteUrl },
            style: 'primary',
            color: '#7A9E7E',
            height: 'sm'
          }
        ]
      }
    })
  }

  return {
    type: 'flex',
    altText,
    contents: { type: 'carousel', contents: bubbles }
  }
}

async function listAvailableRooms(landlordId = null, t = {}) {
  const where = { status: 'AVAILABLE', deletedAt: null }
  if (landlordId) where.ownerId = landlordId
  const rooms = await prisma.property.findMany({
    where,
    include: { images: { orderBy: [{ isCover: 'desc' }, { order: 'asc' }] } },
    orderBy: { price: 'asc' },
    take: 10
  })

  if (rooms.length === 0) {
    return { type: 'text', text: t.noRooms || '😔 目前沒有空房，歡迎留下聯絡方式，有空房第一時間通知您！' }
  }

  return roomsToCarousel(rooms, `目前有 ${rooms.length} 間空房`, t)
}

// ── 關鍵字解析 ────────────────────────────────────────────────────
// 支援多元條件，例如：
//   「台中市 沙鹿區 5000-8000」「沙鹿 8000以下」「沙鹿 套房 冷氣 5000以下」
//   「10坪以上」「5-8坪 雅房」「電梯 機車位」「近火車站」
// 中文房型 → Prisma enum（先比對長詞，避免「套房」吃掉「獨立套房」）
// 註：刻意不放「車位/土地」，避免「機車位」等附屬設備關鍵字被誤判成房型
const TYPE_MAP = [
  ['獨立套房', 'STUDIO'], ['分租套房', 'SHARED_SUITE'], ['整層住家', 'WHOLE_FLOOR'],
  ['整層', 'WHOLE_FLOOR'], ['套房', 'SUITE'], ['雅房', 'ROOM'],
  ['店面', 'STORE'], ['住辦', 'LIVE_OFFICE'], ['辦公', 'OFFICE'], ['廠房', 'FACTORY'],
]
// 過濾掉非實質的功能詞
const KW_STOP = ['我要','想要','想找','請問','有沒有','有無','幫我','可以','麻煩','謝謝','你好','哈囉',
  '租屋','找房','房子','房間','租金','預算','左右','附近','以下','以上','以內','元']

// 明確搜尋指令：/s xxx、/搜尋 xxx、搜尋 xxx、/search xxx
// （/s 必須有斜線且後面非英文字母，避免吃掉 /search 或一般英文字）
const SEARCH_CMD_RE = /^(?:[\/／]\s*s(?![a-zA-Z])|[\/／]?\s*(?:搜尋|搜索|search))\s*[:：]?\s*([\s\S]*)$/i

// force=true（使用者明確下「/s」搜尋指令）時，有任何 1 個條件或關鍵字即搜尋；
// force=false（一般訊息）時，需至少 1 個結構化條件、且總條件數 ≥ 2 才自動觸發，
// 避免單一條件（如只打價格、只打設備）就跳房源卡
function parseSearchQuery(text, force = false) {
  const result = { city: null, district: null, minPrice: null, maxPrice: null, minSize: null, maxSize: null, type: null, keywords: [] }
  let rest = text

  // 坪數（先抽，含「坪」字，避免與價格數字混淆）
  const sizeRange = rest.match(/(\d+(?:\.\d+)?)\s*[-~到至]\s*(\d+(?:\.\d+)?)\s*坪/)
  if (sizeRange) {
    result.minSize = parseFloat(sizeRange[1]); result.maxSize = parseFloat(sizeRange[2])
    rest = rest.replace(sizeRange[0], ' ')
  } else {
    const sizeUnder = rest.match(/(\d+(?:\.\d+)?)\s*坪\s*(以下|以內|內)/)
    if (sizeUnder) { result.maxSize = parseFloat(sizeUnder[1]); rest = rest.replace(sizeUnder[0], ' ') }
    const sizeOver = rest.match(/(\d+(?:\.\d+)?)\s*坪\s*(以上)/)
    if (sizeOver) { result.minSize = parseFloat(sizeOver[1]); rest = rest.replace(sizeOver[0], ' ') }
    // 單純「X坪」→ 視為至少 X 坪
    const sizeExact = rest.match(/(\d+(?:\.\d+)?)\s*坪/)
    if (sizeExact && result.minSize == null && result.maxSize == null) {
      result.minSize = parseFloat(sizeExact[1]); rest = rest.replace(sizeExact[0], ' ')
    }
  }

  // 城市（台中市 / 台中）
  const cityMatch = rest.match(/(台北|新北|桃園|台中|臺中|台南|臺南|高雄|基隆|新竹|苗栗|彰化|南投|雲林|嘉義|屏東|宜蘭|花蓮|台東|臺東|澎湖|金門|連江)市?/)
  if (cityMatch) {
    result.city = cityMatch[1].replace('臺', '台') + '市'
    rest = rest.replace(cityMatch[0], ' ')
  }

  // 區域（XX區 / XX鄉 / XX鎮）
  const distMatch = rest.match(/([\u4e00-\u9fa5]{1,4})(區|鄉|鎮)/)
  if (distMatch) {
    result.district = distMatch[1] + distMatch[2]
    rest = rest.replace(distMatch[0], ' ')
  }

  // 租金範圍：5000-8000 / 5000~8000 / 5000到8000
  const rangeMatch = rest.match(/(\d{3,6})\s*[-~到至]\s*(\d{3,6})/)
  if (rangeMatch) {
    result.minPrice = parseInt(rangeMatch[1])
    result.maxPrice = parseInt(rangeMatch[2])
    rest = rest.replace(rangeMatch[0], ' ')
  } else {
    // XX以下 / XX以內
    const underMatch = rest.match(/(\d{3,6})\s*(元)?\s*(以下|以內|內)/)
    if (underMatch) {
      result.maxPrice = parseInt(underMatch[1])
      rest = rest.replace(underMatch[0], ' ')
    }
    // XX以上
    const overMatch = rest.match(/(\d{3,6})\s*(元)?\s*(以上)/)
    if (overMatch) {
      result.minPrice = parseInt(overMatch[1])
      rest = rest.replace(overMatch[0], ' ')
    }
  }

  // 房型（先比對長詞）
  for (const [word, enumVal] of TYPE_MAP) {
    if (rest.includes(word)) { result.type = enumVal; rest = rest.replace(word, ' '); break }
  }

  // 剩餘中文／英文詞當「通用關鍵字」：之後同時比對 區域/名稱/描述/地址/標籤/設備
  const kwMatches = rest.match(/[\u4e00-\u9fa5a-zA-Z]{2,}/g) || []
  result.keywords = [...new Set(kwMatches.filter(w => !KW_STOP.includes(w)))]

  // 觸發判斷：計算條件數量
  const structuredCount =
    (result.city ? 1 : 0) +
    (result.district ? 1 : 0) +
    ((result.minPrice || result.maxPrice) ? 1 : 0) +
    ((result.minSize != null || result.maxSize != null) ? 1 : 0) +
    (result.type ? 1 : 0)
  const totalCount = structuredCount + result.keywords.length

  if (force) {
    // 明確 /s 指令：有任何 1 個條件或關鍵字就搜尋
    return totalCount >= 1 ? result : null
  }
  // 一般訊息：需至少 1 個結構化條件、且總條件數 ≥ 2 才自動觸發
  // （單一條件不跳搜尋；純設備關鍵字也不會自動觸發）
  return (structuredCount >= 1 && totalCount >= 2) ? result : null
}

// ── 關鍵字搜尋房源 ────────────────────────────────────────────────
async function searchRooms(parsed, landlordId = null, t = {}) {
  const where = { status: 'AVAILABLE', deletedAt: null }
  if (landlordId) where.ownerId = landlordId
  if (parsed.city) where.city = parsed.city
  if (parsed.district) where.district = { contains: parsed.district.replace(/(區|鄉|鎮)$/, '') }
  if (parsed.type) where.type = parsed.type
  if (parsed.minPrice || parsed.maxPrice) {
    where.price = {}
    if (parsed.minPrice) where.price.gte = parsed.minPrice
    if (parsed.maxPrice) where.price.lte = parsed.maxPrice
  }
  if (parsed.minSize != null || parsed.maxSize != null) {
    where.size = {}
    if (parsed.minSize != null) where.size.gte = parsed.minSize
    if (parsed.maxSize != null) where.size.lte = parsed.maxSize
  }
  // 通用關鍵字：每個關鍵字都要命中（AND），但可落在 區域/名稱/描述/地址/標籤/設備 任一欄位（OR）
  if (parsed.keywords && parsed.keywords.length) {
    where.AND = parsed.keywords.map(kw => ({
      OR: [
        { district:    { contains: kw } },
        { title:       { contains: kw } },
        { description: { contains: kw } },
        { address:     { contains: kw } },
        { tags:        { some: { name: { contains: kw } } } },
        { amenities:   { some: { name: { contains: kw } } } },
      ],
    }))
  }

  const rooms = await prisma.property.findMany({
    where,
    include: { images: { orderBy: [{ isCover: 'desc' }, { order: 'asc' }] } },
    orderBy: { price: 'asc' },
    take: 10
  })

  // 組合搜尋條件描述
  const TYPE_LABELS = { SUITE: '套房', ROOM: '雅房', WHOLE_FLOOR: '整層住家', SHARED_SUITE: '分租套房', STUDIO: '獨立套房', STORE: '店面', OFFICE: '辦公', LIVE_OFFICE: '住辦', FACTORY: '廠房', PARKING: '車位', LAND: '土地', OTHER: '其他' }
  const parts = []
  if (parsed.city) parts.push(parsed.city)
  if (parsed.district) parts.push(parsed.district)
  if (parsed.type) parts.push(TYPE_LABELS[parsed.type] || parsed.type)
  if (parsed.minPrice && parsed.maxPrice) parts.push(`${parsed.minPrice}-${parsed.maxPrice}元`)
  else if (parsed.maxPrice) parts.push(`${parsed.maxPrice}元以下`)
  else if (parsed.minPrice) parts.push(`${parsed.minPrice}元以上`)
  if (parsed.minSize != null && parsed.maxSize != null) parts.push(`${parsed.minSize}-${parsed.maxSize}坪`)
  else if (parsed.maxSize != null) parts.push(`${parsed.maxSize}坪以下`)
  else if (parsed.minSize != null) parts.push(`${parsed.minSize}坪以上`)
  if (parsed.keywords && parsed.keywords.length) parts.push(parsed.keywords.join(' '))
  const condText = parts.join(' ')

  if (rooms.length === 0) {
    const msg = (t.searchNoResult || '🔍 找不到符合條件的空房。\n\n可以試試放寬條件，或輸入「查詢空房」看全部房源。')
    return { type: 'text', text: msg }
  }

  return roomsToCarousel(rooms, `找到 ${rooms.length} 間符合「${condText}」的房源`, t)
}

// ── 維修回報選單 ──────────────────────────────────────────────────
function repairMenu(t = {}) {
  return {
    type: 'flex',
    altText: '維修回報',
    contents: {
      type: 'bubble',
      body: {
        type: 'box',
        layout: 'vertical',
        spacing: 'sm',
        contents: [
          { type: 'text', text: t.repairTitle || '🔧 請選擇問題類型', weight: 'bold', size: 'md' },
          repairButton('💧 漏水問題', '漏水問題'),
          repairButton('💡 電氣問題', '電氣問題'),
          repairButton('🚿 衛浴設備', '衛浴設備'),
          repairButton('🔒 門鎖問題', '門鎖問題'),
          repairButton('❄️ 冷氣問題', '冷氣問題'),
          repairButton('📝 其他問題', '其他問題'),
        ]
      }
    }
  }
}

function repairButton(label, action) {
  return {
    type: 'button',
    action: { type: 'message', label, text: action },
    style: 'secondary',
    height: 'sm',
    margin: 'xs'
  }
}

// ── 我的預約 ──────────────────────────────────────────────────────
async function myBookings(lineUserId, landlordId = null, t = {}) {
  const tenant = await findLineTenant(lineUserId, landlordId)
  if (!tenant) {
    return { type: 'text', text: t.noBookingHistory || '您尚未有任何預約記錄。\n輸入「查詢空房」開始預約看房！' }
  }

  const bookings = await prisma.booking.findMany({
    where: { lineUserId: tenant.id, status: { in: ['PENDING', 'CONFIRMED'] } },
    include: { property: true },
    orderBy: { date: 'asc' }
  })

  if (bookings.length === 0) {
    return { type: 'text', text: t.noActiveBooking || '目前沒有進行中的預約。\n輸入「預約看房」來預約！' }
  }

  const statusLabel = { PENDING: '⏳ 待確認', CONFIRMED: '✅ 已確認' }
  const lines = bookings.map(b =>
    `${statusLabel[b.status]} ${b.property.title}\n📅 ${new Date(b.date).toLocaleDateString('zh-TW')} ${b.timeslot}`
  )

  return { type: 'text', text: `📋 您的預約：\n\n${lines.join('\n\n')}` }
}

// ── 用戶狀態（多步驟流程） ──────────────────────────────────────
const userState = new Map()

async function handlePostback(event, client, landlordId = null) {
  const userId = event.source.userId
  if (isRateLimited(userId)) return
  const data = event.postback?.data || ''
  const { getBotText } = require('./botText')
  const t = await getBotText(landlordId)

  if (data.startsWith('BOOK_')) {
    if (t.showBookVisit === false) {
      await client.replyMessage(event.replyToken, mainMenu(t))
      return
    }
    const propertyId = data.replace('BOOK_', '')
    userState.set(userId, { flow: 'booking', step: 'select_time_after_date', propertyId })

    // 用 datetimepicker 讓用戶選日期
    const today = new Date().toISOString().split('T')[0]
    await client.replyMessage(event.replyToken, {
      type: 'flex',
      altText: '請選擇看房日期',
      contents: {
        type: 'bubble',
        body: {
          type: 'box',
          layout: 'vertical',
          spacing: 'md',
          contents: [
            { type: 'text', text: t.askDate || '📅 請選擇想看房的日期', weight: 'bold', size: 'md' },
            {
              type: 'button',
              action: {
                type: 'datetimepicker',
                label: '點此選擇日期',
                data: `SELECT_DATE_${propertyId}`,
                mode: 'date',
                min: today,
              },
              style: 'primary',
              color: '#7A9E7E',
              height: 'sm',
              margin: 'md'
            }
          ]
        }
      }
    })
  }

  if (data.startsWith('SELECT_DATE_')) {
    const propertyId = data.replace('SELECT_DATE_', '')
    const visitDate = event.postback?.params?.date  // YYYY-MM-DD
    if (!visitDate) return

    userState.set(userId, { flow: 'booking', step: 'select_time', propertyId, visitDate })

    await client.replyMessage(event.replyToken, {
      type: 'flex',
      altText: '請選擇看房時段',
      contents: {
        type: 'bubble',
        body: {
          type: 'box',
          layout: 'vertical',
          spacing: 'md',
          contents: [
            { type: 'text', text: t.askTime || '⏰ 請選擇看房時間', weight: 'bold', size: 'md' },
            { type: 'text', text: `📅 ${visitDate}`, size: 'sm', color: '#888888' },
            {
              type: 'button',
              action: {
                type: 'datetimepicker',
                label: '點此選擇時間',
                data: `SELECT_TIME_${propertyId}`,
                mode: 'time',
                min: '09:00',
                max: '20:00',
              },
              style: 'primary',
              color: '#7A9E7E',
              height: 'sm',
              margin: 'md'
            }
          ]
        }
      }
    })
  }

  if (data.startsWith('SELECT_TIME_')) {
    const propertyId = data.replace('SELECT_TIME_', '')
    const timeslot = event.postback?.params?.time  // HH:mm
    if (!timeslot) return

    const state = userState.get(userId) || {}
    const visitDate = state.visitDate
    if (!visitDate) {
      await client.replyMessage(event.replyToken, { type: 'text', text: '⚠️ 請重新預約，選擇日期後再選時間。' })
      return
    }

    const tenant = await findLineTenant(userId, landlordId)
    const prop = await prisma.property.findUnique({ where: { id: propertyId }, select: { ownerId: true } })
    const booking = await prisma.booking.create({
      data: {
        lineUserId: tenant.id,
        propertyId,
        date: new Date(visitDate),
        timeslot,
        status: 'PENDING',
        landlordId: prop?.ownerId || null
      },
      include: { property: true }
    })

    userState.delete(userId)

    const ownerMsg = `📅 新看房預約！\n房源：${booking.property.title}\n時間：${visitDate} ${timeslot}\n用戶：${tenant.name || tenant.lineUserId}\n請至後台確認`
    await notifyLandlord(prop?.ownerId, ownerMsg, client)

    const successMsg = t.bookSuccess || '✅ 預約成功！\n\n房東確認後會通知您，感謝！'
    await client.replyMessage(event.replyToken, {
      type: 'text',
      text: `${successMsg}\n\n🏠 ${booking.property.title}\n📅 ${visitDate} ${timeslot}`
    })
  }
}

async function handleMessage(event, client, landlordId = null) {
  const userId = event.source.userId
  if (isRateLimited(userId)) return
  const text = event.message?.text?.trim() || ''
  const state = userState.get(userId) || {}

  // 載入該房東的 Bot 文字設定 + 開關狀態
  const { getBotText } = require('./botText')
  const t = await getBotText(landlordId)

  // 注入房東官網 URL（供「更多房源」按鈕使用）
  if (landlordId) {
    t._siteUrl = `${SITE_URL}/site/${landlordId}`
  }

  // Bot 已被房東關閉 → 回固定訊息，不處理功能
  if (landlordId && t._enabled === false) {
    try {
      await client.replyMessage(event.replyToken, { type: 'text', text: t.botDisabledMsg })
    } catch (e) { console.error('關閉訊息回覆失敗:', e.message) }
    return
  }

  // ── 確保 LINE 用戶存在 DB（抓取名稱、頭像、狀態消息） ──
  let profileData = {}
  try {
    const profile = await client.getProfile(userId)
    profileData = {
      name: profile.displayName,
      avatarUrl: profile.pictureUrl || null,
      statusMessage: profile.statusMessage || null,
    }
  } catch (e) {
    console.log('無法取得用戶名稱:', e.message)
  }

  // 若來自某房東的 Bot，將用戶歸屬到該房東
  await upsertLineTenant({ lineUserId: userId, landlordId, data: profileData })

  let reply

  // ── 中斷流程關鍵字（優先判斷，隨時可叫出選單或切換功能） ──
  const EXIT_KEYWORDS = ['選單', '主選單', 'menu', '取消', '返回', '查詢空房', '預約看房', '維修回報', '我的預約']
  const isExitKeyword = EXIT_KEYWORDS.some(k => text === k || text.toLowerCase() === k.toLowerCase())
  if (isExitKeyword && state.flow) {
    userState.delete(userId)
    // 直接走下方主要指令，不進流程
  }

  // ── 多步驟流程中 ──
  if (!isExitKeyword && state.flow === 'repair') {
    if (t.showReportRepair === false) { userState.delete(userId); reply = mainMenu(t) }
    else { reply = await handleRepairFlow(userId, text, state, client, landlordId, t) }
  }
  // ── 主要指令 ──
  else if (text === 'ACTION_LIST_ROOMS' || text === '查詢空房') {
    reply = t.showListRooms !== false ? await listAvailableRooms(landlordId, t) : mainMenu(t)
  } else if (text === 'ACTION_BOOK_VISIT' || text === '預約看房') {
    reply = t.showBookVisit !== false ? await listAvailableRooms(landlordId, t) : mainMenu(t)
  } else if (text === 'ACTION_REPORT_REPAIR' || text === '維修回報') {
    reply = t.showReportRepair !== false ? repairMenu(t) : mainMenu(t)
  } else if (text === 'ACTION_MY_BOOKINGS' || text === '我的預約') {
    reply = t.showMyBookings !== false ? await myBookings(userId, landlordId, t) : mainMenu(t)
  }
  else if (['漏水問題','電氣問題','衛浴設備','門鎖問題','冷氣問題','其他問題'].includes(text)) {
    if (t.showReportRepair === false) { reply = mainMenu(t) }
    else {
      const category = text
      userState.set(userId, { flow: 'repair', step: 'describe', category })
      reply = { type: 'text', text: `🔧 ${category}\n\n${t.askRepairDesc}` }
    }
  }
  // ── 明確呼叫選單 ──
  else if (['選單', '主選單', 'menu'].includes(text.toLowerCase())) {
    reply = mainMenu(t)
  }
  else {
    const cmdMatch = text.match(SEARCH_CMD_RE)
    if (cmdMatch) {
      // 明確搜尋指令（/s …）：即使只有單一條件或設備關鍵字也搜尋
      const query = (cmdMatch[1] || '').trim()
      const parsed = query ? parseSearchQuery(query, true) : null
      if (parsed) {
        reply = await searchRooms(parsed, landlordId, t)
      } else {
        reply = { type: 'text', text: '🔍 請在指令後輸入搜尋條件，例如：\n・/s 沙鹿 套房 5000以下\n・/s 10坪以上 電梯\n・/s 寵物 近火車站\n\n可用條件：地區、房型、租金、坪數、設備／機能關鍵字' }
      }
    } else {
      // 一般訊息：只有「結構化條件」(地區/租金/坪數/房型)才自動視為搜尋
      const parsed = parseSearchQuery(text)
      if (parsed) {
        reply = await searchRooms(parsed, landlordId, t)
      } else {
        // 看不懂的訊息：不回應，讓對話自然進行（底部圖文選單已固定顯示）
        reply = null
      }
    }
  }

  if (reply) {
    try {
      await client.replyMessage(event.replyToken, reply)
    } catch (err) {
      console.error('回覆訊息失敗:', err.statusCode, JSON.stringify(err.originalError?.response?.data || err.message))
      try {
        await client.replyMessage(event.replyToken, {
          type: 'text',
          text: '抱歉，顯示房源時發生問題😢\n請輸入「選單」重試，或直接聯絡房東。'
        })
      } catch (e2) {
        console.error('連純文字也回覆失敗:', e2.message)
      }
    }
  }
}

// ── 維修回報流程 ──────────────────────────────────────────────────
async function handleRepairFlow(userId, text, state, client, landlordId = null, t = {}) {
  const { step, category } = state

  if (step === 'describe') {
    const tenant = await findLineTenant(userId, landlordId)

    const property = tenant?.propertyId
      ? await prisma.property.findUnique({ where: { id: tenant.propertyId } })
      : null

    if (!property) {
      userState.delete(userId)
      return { type: 'text', text: t.repairNoProperty || '⚠️ 無法找到您的租住資訊，請聯絡房東確認。' }
    }

    await prisma.repair.create({
      data: {
        lineUserId: tenant.id,
        propertyId: property.id,
        title: category,
        description: text,
        status: 'PENDING',
        landlordId: property.ownerId || null
      }
    })

    userState.delete(userId)

    const ownerMsg = `🔧 維修回報！\n房源：${property.title}\n類型：${category}\n描述：${text}\n回報人：${tenant.name || tenant.lineUserId}`
    await notifyLandlord(property.ownerId, ownerMsg, client)

    const successMsg = (t.repairSuccess || '✅ 維修申請已送出！\n\n我們會盡快處理，感謝您的回報！')
    return {
      type: 'text',
      text: `${successMsg}\n\n問題類型：${category}\n描述：${text}`
    }
  }

  return null
}

module.exports = { handleMessage, handlePostback, parseSearchQuery }
