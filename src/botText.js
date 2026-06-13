// Bot 文字內容設定
// 每個房東可在後台自訂；沒設定的項目用預設值（向下相容）

const prisma = require('./db')

// 預設文字（房東沒自訂時使用）
const DEFAULT_TEXT = {
  // 主選單
  menuTitle: '🐌 小蝸出租',
  menuSubtitle: '請選擇服務項目',
  btnListRooms: '🏠 查詢空房',
  btnBookVisit: '📅 預約看房',
  btnReportRepair: '🔧 維修回報',
  btnMyBookings: '📋 我的預約',
  searchHint: '💡 也可直接輸入條件搜尋',
  searchExample: '例如：台中市 沙鹿區 5000-8000',

  // 歡迎語（加好友）
  welcome: '👋 歡迎加入！\n\n輸入「選單」開始使用服務。',

  // 查空房
  noRooms: '😔 目前沒有空房，歡迎留下聯絡方式，有空房第一時間通知您！',
  searchNoResult: '🔍 找不到符合條件的空房。\n\n可以試試放寬條件，或輸入「查詢空房」看全部房源。',
  bookButtonLabel: '預約看這間',

  // 預約流程
  askDate: '📅 請輸入想看房的日期（格式：2026/06/15）',
  dateError: '❌ 日期格式不對，請輸入如：2026/06/15',
  askTime: '⏰ 請選擇看房時間',
  bookSuccess: '✅ 預約成功！\n\n房東確認後會通知您，感謝！',

  // 維修流程
  repairTitle: '🔧 請選擇問題類型',
  askRepairDesc: '請描述問題詳情（例如：浴室天花板漏水，已持續3天）',
  repairNoProperty: '⚠️ 無法找到您的租住資訊，請聯絡房東確認。',
  repairSuccess: '✅ 維修申請已送出！\n\n我們會盡快處理，感謝您的回報！',

  // 我的預約
  noBookingHistory: '您尚未有任何預約記錄。\n輸入「查詢空房」開始預約看房！',
  noActiveBooking: '目前沒有進行中的預約。\n輸入「預約看房」來預約！',

  // Bot 關閉時的回覆
  botDisabledMsg: '目前暫停服務，請稍後再試或直接聯絡房東 🙏',
}

// 快取房東文字設定（60 秒）
const textCache = new Map()
const TTL = 60 * 1000

// 取得房東的文字設定（合併預設值）
async function getBotText(landlordId) {
  if (!landlordId) return { ...DEFAULT_TEXT, _enabled: true }

  const cached = textCache.get(landlordId)
  if (cached && Date.now() - cached.at < TTL) return cached.data

  let custom = {}
  let enabled = true
  try {
    const landlord = await prisma.landlord.findUnique({
      where: { id: landlordId },
      select: { botTextConfig: true, botEnabled: true }
    })
    if (landlord) {
      if (landlord.botTextConfig) {
        try { custom = JSON.parse(landlord.botTextConfig) } catch (e) {}
      }
      enabled = landlord.botEnabled !== false  // 預設開啟
    }
  } catch (e) {
    console.error('取得 Bot 文字設定失敗:', e.message)
  }

  const merged = { ...DEFAULT_TEXT, ...custom, _enabled: enabled }
  textCache.set(landlordId, { at: Date.now(), data: merged })
  return merged
}

function clearTextCache(landlordId) {
  if (landlordId) textCache.delete(landlordId)
  else textCache.clear()
}

module.exports = { DEFAULT_TEXT, getBotText, clearTextCache }
