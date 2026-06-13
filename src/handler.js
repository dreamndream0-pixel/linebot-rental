const prisma = require('./db')

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
          menuButton(t.btnListRooms || '🏠 查詢空房', 'ACTION_LIST_ROOMS'),
          menuButton(t.btnBookVisit || '📅 預約看房', 'ACTION_BOOK_VISIT'),
          menuButton(t.btnReportRepair || '🔧 維修回報', 'ACTION_REPORT_REPAIR'),
          menuButton(t.btnMyBookings || '📋 我的預約', 'ACTION_MY_BOOKINGS'),
          { type: 'separator', margin: 'md' },
          { type: 'text', text: t.searchHint || '💡 也可直接輸入條件搜尋', size: 'xs', color: '#888888', margin: 'md', wrap: true },
          { type: 'text', text: t.searchExample || '例如：台中市 沙鹿區 5000-8000', size: 'xs', color: '#aaaaaa', wrap: true },
        ]
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

// ── 空房列表（讀取統一資料庫的 AVAILABLE 房源） ──────────────────
const TYPE_LABEL = { SUITE: '套房', ROOM: '雅房', WHOLE_FLOOR: '整層住家', SHARED_SUITE: '分租套房' }

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
        contents: [{
          type: 'button',
          action: { type: 'message', label: t.bookButtonLabel || '預約看這間', text: `BOOK_ROOM_${room.id}` },
          style: 'primary',
          color: '#7A9E7E',
          height: 'sm'
        }]
      }
    }
  })

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
// 支援：「台中市 沙鹿區 5000-8000」「沙鹿 8000以下」「5000-8000」「沙鹿區」
function parseSearchQuery(text) {
  const result = { city: null, district: null, minPrice: null, maxPrice: null }
  let rest = text

  // 城市（台中市 / 台中）
  const cityMatch = rest.match(/(台北|新北|桃園|台中|臺中|台南|臺南|高雄|基隆|新竹|苗栗|彰化|南投|雲林|嘉義|屏東|宜蘭|花蓮|台東|臺東|澎湖|金門|連江)市?/)
  if (cityMatch) {
    result.city = cityMatch[1].replace('臺', '台') + '市'
    rest = rest.replace(cityMatch[0], ' ')
  }

  // 區域（XX區 / XX鄉 / XX鎮 / XX市）
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

  // 若已抓到價格但還沒抓到區域，把剩下的中文詞當區域（如「沙鹿 8000以下」）
  if (!result.district && (result.minPrice || result.maxPrice)) {
    const loose = rest.match(/[\u4e00-\u9fa5]{2,4}/)
    if (loose) result.district = loose[0]
  }

  // 完全沒有任何可辨識條件（城市/區域/價格）→ 不當搜尋，避免閒聊誤判
  const hasAny = result.city || result.district || result.minPrice || result.maxPrice
  return hasAny ? result : null
}

// ── 關鍵字搜尋房源 ────────────────────────────────────────────────
async function searchRooms(parsed, landlordId = null, t = {}) {
  const where = { status: 'AVAILABLE', deletedAt: null }
  if (landlordId) where.ownerId = landlordId
  if (parsed.city) where.city = parsed.city
  if (parsed.district) where.district = { contains: parsed.district.replace(/(區|鄉|鎮)$/, '') }
  if (parsed.minPrice || parsed.maxPrice) {
    where.price = {}
    if (parsed.minPrice) where.price.gte = parsed.minPrice
    if (parsed.maxPrice) where.price.lte = parsed.maxPrice
  }

  const rooms = await prisma.property.findMany({
    where,
    include: { images: { orderBy: [{ isCover: 'desc' }, { order: 'asc' }] } },
    orderBy: { price: 'asc' },
    take: 10
  })

  // 組合搜尋條件描述
  const parts = []
  if (parsed.city) parts.push(parsed.city)
  if (parsed.district) parts.push(parsed.district)
  if (parsed.minPrice && parsed.maxPrice) parts.push(`${parsed.minPrice}-${parsed.maxPrice}元`)
  else if (parsed.maxPrice) parts.push(`${parsed.maxPrice}元以下`)
  else if (parsed.minPrice) parts.push(`${parsed.minPrice}元以上`)
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
          repairButton('💧 漏水問題', 'REPAIR_漏水問題'),
          repairButton('💡 電氣問題', 'REPAIR_電氣問題'),
          repairButton('🚿 衛浴設備', 'REPAIR_衛浴設備'),
          repairButton('🔒 門鎖問題', 'REPAIR_門鎖問題'),
          repairButton('❄️ 冷氣問題', 'REPAIR_冷氣問題'),
          repairButton('📝 其他問題', 'REPAIR_其他問題'),
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
async function myBookings(lineUserId, t = {}) {
  const tenant = await prisma.tenant.findUnique({ where: { lineUserId } })
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

async function handleMessage(event, client, landlordId = null) {
  const userId = event.source.userId
  const text = event.message?.text?.trim() || ''
  const state = userState.get(userId) || {}

  // 載入該房東的 Bot 文字設定 + 開關狀態
  const { getBotText } = require('./botText')
  const t = await getBotText(landlordId)

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
  const tenantData = landlordId ? { ...profileData, landlordId } : profileData
  await prisma.tenant.upsert({
    where: { lineUserId: userId },
    update: tenantData,
    create: { lineUserId: userId, ...tenantData }
  })

  let reply

  // ── 多步驟流程中 ──
  if (state.flow === 'booking' && (state.step === 'select_date' || text.startsWith('TIME_'))) {
    reply = await handleBookingFlow(userId, text, state, client, landlordId, t)
  } else if (state.flow === 'repair') {
    reply = await handleRepairFlow(userId, text, state, client, landlordId, t)
  }
  // ── 主要指令 ──
  else if (text === 'ACTION_LIST_ROOMS' || text === '查詢空房') {
    reply = await listAvailableRooms(landlordId, t)
  } else if (text === 'ACTION_BOOK_VISIT' || text === '預約看房') {
    reply = await listAvailableRooms(landlordId, t)
  } else if (text === 'ACTION_REPORT_REPAIR' || text === '維修回報') {
    reply = repairMenu(t)
  } else if (text === 'ACTION_MY_BOOKINGS' || text === '我的預約') {
    reply = await myBookings(userId, t)
  }
  else if (text.startsWith('BOOK_ROOM_')) {
    const propertyId = text.replace('BOOK_ROOM_', '')
    userState.set(userId, { flow: 'booking', step: 'select_date', propertyId })
    reply = { type: 'text', text: t.askDate }
  }
  else if (text.startsWith('REPAIR_')) {
    const category = text.replace('REPAIR_', '')
    userState.set(userId, { flow: 'repair', step: 'describe', category })
    reply = { type: 'text', text: `🔧 ${category}\n\n${t.askRepairDesc}` }
  }
  else {
    // 嘗試把訊息當作搜尋關鍵字解析
    const parsed = parseSearchQuery(text)
    if (parsed) {
      reply = await searchRooms(parsed, landlordId, t)
    } else {
      reply = mainMenu(t)
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

// ── 看房預約流程 ──────────────────────────────────────────────────
async function handleBookingFlow(userId, text, state, client, landlordId = null, t = {}) {
  const { step, propertyId } = state

  if (step === 'select_date') {
    const dateRegex = /^(\d{4})[\/\-](\d{1,2})[\/\-](\d{1,2})$/
    if (!dateRegex.test(text)) {
      return { type: 'text', text: t.dateError || '❌ 日期格式不對，請輸入如：2026/06/15' }
    }
    userState.set(userId, { ...state, step: 'select_time', visitDate: text })
    return {
      type: 'flex',
      altText: '選擇看房時段',
      contents: {
        type: 'bubble',
        body: {
          type: 'box',
          layout: 'vertical',
          spacing: 'sm',
          contents: [
            { type: 'text', text: t.askTime || '⏰ 請選擇看房時間', weight: 'bold' },
            ...['10:00', '11:00', '14:00', '15:00', '16:00'].map(slot => ({
              type: 'button',
              action: { type: 'message', label: slot, text: `TIME_${slot}` },
              style: 'secondary', height: 'sm', margin: 'xs'
            }))
          ]
        }
      }
    }
  }

  if (step === 'select_time' && text.startsWith('TIME_')) {
    const timeslot = text.replace('TIME_', '')
    const { visitDate } = state

    const tenant = await prisma.tenant.findUnique({ where: { lineUserId: userId } })
    // 取得房源的歸屬房東
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

    const successMsg = (t.bookSuccess || '✅ 預約成功！\n\n房東確認後會通知您，感謝！')
    return {
      type: 'text',
      text: `${successMsg}\n\n🏠 ${booking.property.title}\n📅 ${visitDate} ${timeslot}`
    }
  }

  return null
}

// ── 維修回報流程 ──────────────────────────────────────────────────
async function handleRepairFlow(userId, text, state, client, landlordId = null, t = {}) {
  const { step, category } = state

  if (step === 'describe') {
    const tenant = await prisma.tenant.findUnique({ where: { lineUserId: userId } })

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

module.exports = { handleMessage }
