const prisma = require('./db')

// ── 主選單 Flex Message ──────────────────────────────────────────
function mainMenu() {
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
          { type: 'text', text: '🐌 小蝸出租', weight: 'bold', size: 'xl', color: '#ffffff' },
          { type: 'text', text: '請選擇服務項目', size: 'sm', color: '#ffffff99' }
        ],
        backgroundColor: '#7A9E7E',
        paddingAll: '20px'
      },
      body: {
        type: 'box',
        layout: 'vertical',
        spacing: 'sm',
        contents: [
          menuButton('🏠 查詢空房', 'ACTION_LIST_ROOMS'),
          menuButton('📅 預約看房', 'ACTION_BOOK_VISIT'),
          menuButton('🔧 維修回報', 'ACTION_REPORT_REPAIR'),
          menuButton('📋 我的預約', 'ACTION_MY_BOOKINGS'),
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

// ── 空房列表 ─────────────────────────────────────────────────────
async function listAvailableRooms() {
  const rooms = await prisma.property.findMany({
    where: { isAvailable: true },
    orderBy: { rent: 'asc' }
  })

  if (rooms.length === 0) {
    return { type: 'text', text: '😔 目前沒有空房，歡迎留下聯絡方式，有空房第一時間通知您！' }
  }

  const bubbles = rooms.map(room => ({
    type: 'bubble',
    size: 'kilo',
    hero: room.photos[0] ? {
      type: 'image',
      url: room.photos[0],
      size: 'full',
      aspectRatio: '20:13',
      aspectMode: 'cover'
    } : undefined,
    body: {
      type: 'box',
      layout: 'vertical',
      spacing: 'sm',
      contents: [
        { type: 'text', text: room.name, weight: 'bold', size: 'lg' },
        {
          type: 'box', layout: 'horizontal', contents: [
            { type: 'text', text: `💰 NT$ ${room.rent.toLocaleString()} / 月`, size: 'sm', color: '#7A9E7E', flex: 1 },
            { type: 'text', text: room.size ? `📐 ${room.size} 坪` : '', size: 'sm', color: '#888', flex: 1 }
          ]
        },
        room.description ? { type: 'text', text: room.description, size: 'xs', color: '#888', wrap: true } : null,
      ].filter(Boolean)
    },
    footer: {
      type: 'box',
      layout: 'vertical',
      contents: [{
        type: 'button',
        action: { type: 'message', label: '預約看這間', text: `BOOK_ROOM_${room.id}` },
        style: 'primary',
        color: '#7A9E7E',
        height: 'sm'
      }]
    }
  }))

  return {
    type: 'flex',
    altText: `目前有 ${rooms.length} 間空房`,
    contents: { type: 'carousel', contents: bubbles }
  }
}

// ── 維修回報流程 ──────────────────────────────────────────────────
function repairMenu() {
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
          { type: 'text', text: '🔧 請選擇問題類型', weight: 'bold', size: 'md' },
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
async function myBookings(lineUserId) {
  const tenant = await prisma.tenant.findUnique({ where: { lineUserId } })
  if (!tenant) {
    return { type: 'text', text: '您尚未有任何預約記錄。\n輸入「查詢空房」開始預約看房！' }
  }

  const bookings = await prisma.booking.findMany({
    where: { tenantId: tenant.id, status: { in: ['PENDING', 'CONFIRMED'] } },
    include: { property: true },
    orderBy: { visitDate: 'asc' }
  })

  if (bookings.length === 0) {
    return { type: 'text', text: '目前沒有進行中的預約。\n輸入「預約看房」來預約！' }
  }

  const statusLabel = { PENDING: '⏳ 待確認', CONFIRMED: '✅ 已確認', CANCELLED: '❌ 已取消', DONE: '🏁 已完成' }
  const lines = bookings.map(b =>
    `${statusLabel[b.status]} ${b.property.name}\n📅 ${new Date(b.visitDate).toLocaleDateString('zh-TW')} ${b.visitTime}`
  )

  return { type: 'text', text: `📋 您的預約：\n\n${lines.join('\n\n')}` }
}

// ── 處理用戶狀態（多步驟流程） ──────────────────────────────────
// 簡易 in-memory state（正式上線建議改用 Redis 或 DB）
const userState = new Map()

async function handleMessage(event, client) {
  const userId = event.source.userId
  const text = event.message?.text?.trim() || ''
  const state = userState.get(userId) || {}

  // ── 確保租客存在 DB（並抓取 LINE 顯示名稱） ──
  let displayName = null
  try {
    const profile = await client.getProfile(userId)
    displayName = profile.displayName
  } catch (e) {
    console.log('無法取得用戶名稱:', e.message)
  }

  await prisma.tenant.upsert({
    where: { lineUserId: userId },
    update: displayName ? { name: displayName } : {},
    create: { lineUserId: userId, name: displayName }
  })

  let reply

  // ── 多步驟流程中 ──
  if (state.flow === 'booking') {
    reply = await handleBookingFlow(userId, text, state, client)
  } else if (state.flow === 'repair') {
    reply = await handleRepairFlow(userId, text, state, client)
  }

  // ── 主要指令 ──
  else if (['開始', 'hi', 'hello', '你好', '選單', 'menu', 'ACTION_LIST_ROOMS', 'ACTION_BOOK_VISIT', 'ACTION_REPORT_REPAIR', 'ACTION_MY_BOOKINGS'].includes(text.toLowerCase()) || text === '開始') {
    if (text === 'ACTION_LIST_ROOMS' || text === '查詢空房') {
      reply = await listAvailableRooms()
    } else if (text === 'ACTION_BOOK_VISIT' || text === '預約看房') {
      userState.set(userId, { flow: 'booking', step: 'select_room' })
      reply = await listAvailableRooms()
    } else if (text === 'ACTION_REPORT_REPAIR' || text === '維修回報') {
      reply = repairMenu()
    } else if (text === 'ACTION_MY_BOOKINGS' || text === '我的預約') {
      reply = await myBookings(userId)
    } else {
      reply = mainMenu()
    }
  }
  else if (text.startsWith('BOOK_ROOM_')) {
    const propertyId = text.replace('BOOK_ROOM_', '')
    userState.set(userId, { flow: 'booking', step: 'select_date', propertyId })
    reply = { type: 'text', text: '📅 請輸入想看房的日期（格式：2025/06/15）' }
  }
  else if (text.startsWith('REPAIR_')) {
    const category = text.replace('REPAIR_', '')
    userState.set(userId, { flow: 'repair', step: 'describe', category })
    reply = { type: 'text', text: `🔧 ${category}\n\n請描述問題詳情（例如：浴室天花板漏水，已持續3天）` }
  }
  else {
    reply = mainMenu()
  }

  if (reply) {
    await client.replyMessage(event.replyToken, reply)
  }
}

// ── 看房預約流程 ──────────────────────────────────────────────────
async function handleBookingFlow(userId, text, state, client) {
  const { step, propertyId } = state

  if (step === 'select_date') {
    // 驗證日期格式
    const dateRegex = /^(\d{4})[\/\-](\d{1,2})[\/\-](\d{1,2})$/
    if (!dateRegex.test(text)) {
      return { type: 'text', text: '❌ 日期格式不對，請輸入如：2025/06/15' }
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
            { type: 'text', text: '⏰ 請選擇看房時間', weight: 'bold' },
            ...['10:00', '11:00', '14:00', '15:00', '16:00'].map(t => ({
              type: 'button',
              action: { type: 'message', label: t, text: `TIME_${t}` },
              style: 'secondary', height: 'sm', margin: 'xs'
            }))
          ]
        }
      }
    }
  }

  if (step === 'select_time' && text.startsWith('TIME_')) {
    const visitTime = text.replace('TIME_', '')
    const { visitDate } = state

    // 儲存預約
    const tenant = await prisma.tenant.findUnique({ where: { lineUserId: userId } })
    const booking = await prisma.booking.create({
      data: {
        tenantId: tenant.id,
        propertyId,
        visitDate: new Date(visitDate),
        visitTime,
        status: 'PENDING'
      },
      include: { property: true }
    })

    userState.delete(userId)

    // 通知房東
    const ownerMsg = `📅 新看房預約！\n房間：${booking.property.name}\n時間：${visitDate} ${visitTime}\n請至後台確認`
    if (process.env.OWNER_LINE_USER_ID) {
      await client.pushMessage(process.env.OWNER_LINE_USER_ID, { type: 'text', text: ownerMsg })
    }

    return {
      type: 'text',
      text: `✅ 預約成功！\n\n🏠 ${booking.property.name}\n📅 ${visitDate} ${visitTime}\n\n房東確認後會通知您，感謝！`
    }
  }

  return null
}

// ── 維修回報流程 ──────────────────────────────────────────────────
async function handleRepairFlow(userId, text, state, client) {
  const { step, category } = state

  if (step === 'describe') {
    const tenant = await prisma.tenant.findUnique({ where: { lineUserId: userId } })

    // 找到租客目前租住的房間
    const property = tenant?.propertyId
      ? await prisma.property.findUnique({ where: { id: tenant.propertyId } })
      : null

    if (!property) {
      userState.delete(userId)
      return { type: 'text', text: '⚠️ 無法找到您的租住資訊，請聯絡房東確認。' }
    }

    await prisma.repair.create({
      data: {
        tenantId: tenant.id,
        propertyId: property.id,
        title: category,
        description: text,
        status: 'PENDING'
      }
    })

    userState.delete(userId)

    // 通知房東
    const ownerMsg = `🔧 維修回報！\n房間：${property.name}\n類型：${category}\n描述：${text}`
    if (process.env.OWNER_LINE_USER_ID) {
      await client.pushMessage(process.env.OWNER_LINE_USER_ID, { type: 'text', text: ownerMsg })
    }

    return {
      type: 'text',
      text: `✅ 維修申請已送出！\n\n問題類型：${category}\n描述：${text}\n\n我們會盡快處理，感謝您的回報！`
    }
  }

  return null
}

module.exports = { handleMessage }
