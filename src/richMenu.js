// 圖文選單（Rich Menu）生成與上傳
// 用 SVG 畫選單圖 → sharp 轉 PNG → 上傳 LINE → 綁定為預設選單

const sharp = require('sharp')
const prisma = require('./db')

// LINE Rich Menu 標準尺寸
const W = 2500
const H = 1686  // 大尺寸（也可用 843 小尺寸，這裡統一用大的）

// 版型定義：每種版型的格子座標（比例 0~1）
const TEMPLATES = {
  '2': [ // 左右兩格
    { x: 0,   y: 0, w: 0.5, h: 1 },
    { x: 0.5, y: 0, w: 0.5, h: 1 },
  ],
  '3': [ // 橫向三格
    { x: 0,     y: 0, w: 1/3, h: 1 },
    { x: 1/3,   y: 0, w: 1/3, h: 1 },
    { x: 2/3,   y: 0, w: 1/3, h: 1 },
  ],
  '4': [ // 田字
    { x: 0,   y: 0,   w: 0.5, h: 0.5 },
    { x: 0.5, y: 0,   w: 0.5, h: 0.5 },
    { x: 0,   y: 0.5, w: 0.5, h: 0.5 },
    { x: 0.5, y: 0.5, w: 0.5, h: 0.5 },
  ],
  '6': [ // 2列3欄
    { x: 0,   y: 0,   w: 1/3, h: 0.5 },
    { x: 1/3, y: 0,   w: 1/3, h: 0.5 },
    { x: 2/3, y: 0,   w: 1/3, h: 0.5 },
    { x: 0,   y: 0.5, w: 1/3, h: 0.5 },
    { x: 1/3, y: 0.5, w: 1/3, h: 0.5 },
    { x: 2/3, y: 0.5, w: 1/3, h: 0.5 },
  ],
}

// 小蝸品牌色盤（每格輪流用）
const PALETTE = ['#7A9E7E', '#4E7153', '#A8C5AB', '#6B8E6F', '#5C8262', '#88AC8C']

function escapeXml(s) {
  return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

// 產生選單 SVG
function buildSvg(template, cells) {
  const layout = TEMPLATES[template]
  if (!layout) throw new Error('未知版型')

  let rects = ''
  layout.forEach((cell, i) => {
    const data = cells[i] || {}
    const x = cell.x * W, y = cell.y * H, w = cell.w * W, h = cell.h * H
    const color = data.color || PALETTE[i % PALETTE.length]
    const label = escapeXml(data.label || '')
    const icon = escapeXml(data.icon || '')
    const cx = x + w / 2, cy = y + h / 2
    const iconSize = Math.min(w, h) * 0.28
    const fontSize = Math.min(w, h) * 0.13

    rects += `
      <rect x="${x + 8}" y="${y + 8}" width="${w - 16}" height="${h - 16}" rx="28" fill="${color}"/>
      ${icon ? `<text x="${cx}" y="${cy - fontSize * 0.4}" font-size="${iconSize}" text-anchor="middle" dominant-baseline="middle">${icon}</text>` : ''}
      <text x="${cx}" y="${cy + (icon ? iconSize * 0.7 : 0)}" font-size="${fontSize}" fill="#ffffff" font-weight="bold" text-anchor="middle" dominant-baseline="middle" font-family="'Noto Sans TC',sans-serif">${label}</text>
    `
  })

  return `<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg">
    <rect width="${W}" height="${H}" fill="#F0EDE6"/>
    ${rects}
  </svg>`
}

// 產生 LINE Rich Menu 的 areas（可點區域）
function buildAreas(template, cells) {
  const layout = TEMPLATES[template]
  return layout.map((cell, i) => {
    const data = cells[i] || {}
    return {
      bounds: {
        x: Math.round(cell.x * W),
        y: Math.round(cell.y * H),
        width: Math.round(cell.w * W),
        height: Math.round(cell.h * H),
      },
      action: data.text
        ? { type: 'message', text: data.text }
        : { type: 'message', text: data.label || '選單' },
    }
  })
}

// 主流程：生成並套用選單到房東的 Bot
async function applyRichMenu(landlordId) {
  const landlord = await prisma.landlord.findUnique({
    where: { id: landlordId },
    select: { lineChannelToken: true, richMenuConfig: true, richMenuId: true, name: true }
  })
  if (!landlord || !landlord.lineChannelToken) throw new Error('房東未設定 Bot')
  if (!landlord.richMenuConfig) throw new Error('尚未設定選單')

  const config = JSON.parse(landlord.richMenuConfig)
  const { template, cells } = config

  // 1. 產生圖片
  const svg = buildSvg(template, cells)
  const pngBuffer = await sharp(Buffer.from(svg)).png().toBuffer()

  const token = landlord.lineChannelToken
  const headers = { Authorization: `Bearer ${token}` }

  // 2. 刪除舊選單（若有）
  if (landlord.richMenuId) {
    try {
      await fetch(`https://api.line.me/v2/bot/richmenu/${landlord.richMenuId}`, {
        method: 'DELETE', headers
      })
    } catch (e) { /* 忽略 */ }
  }

  // 3. 建立新 Rich Menu 物件
  const richMenuObject = {
    size: { width: W, height: H },
    selected: true,
    name: `menu_${Date.now()}`,
    chatBarText: config.chatBarText || '選單',
    areas: buildAreas(template, cells),
  }

  const createRes = await fetch('https://api.line.me/v2/bot/richmenu', {
    method: 'POST',
    headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify(richMenuObject),
  })
  if (!createRes.ok) {
    const err = await createRes.text()
    throw new Error('建立選單失敗: ' + err)
  }
  const { richMenuId } = await createRes.json()

  // 4. 上傳選單圖片
  const uploadRes = await fetch(`https://api-data.line.me/v2/bot/richmenu/${richMenuId}/content`, {
    method: 'POST',
    headers: { ...headers, 'Content-Type': 'image/png' },
    body: pngBuffer,
  })
  if (!uploadRes.ok) {
    const err = await uploadRes.text()
    throw new Error('上傳選單圖失敗: ' + err)
  }

  // 5. 設為預設選單（所有用戶都看得到）
  const setDefaultRes = await fetch(`https://api.line.me/v2/bot/user/all/richmenu/${richMenuId}`, {
    method: 'POST', headers,
  })
  if (!setDefaultRes.ok) {
    const err = await setDefaultRes.text()
    throw new Error('套用選單失敗: ' + err)
  }

  // 6. 記錄新的 richMenuId
  await prisma.landlord.update({
    where: { id: landlordId },
    data: { richMenuId },
  })

  return { richMenuId }
}

// 產生預覽圖（PNG buffer），不上傳
async function previewRichMenu(template, cells) {
  const svg = buildSvg(template, cells)
  return sharp(Buffer.from(svg)).png().toBuffer()
}

module.exports = { applyRichMenu, previewRichMenu, TEMPLATES }
