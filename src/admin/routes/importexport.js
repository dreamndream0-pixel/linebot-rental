// src/admin/routes/importexport.js — 房源 CSV 匯出 / 匯入
const express = require('express')
const router = express.Router()
const prisma = require('../../db')
const { resolveRole, landlordFilter, revalidateSite } = require('../helpers')

// ── CSV 欄位定義（順序即為 CSV 欄位順序）──────────────────────────────
const CSV_FIELDS = [
  { key: 'id',              label: 'ID（更新用，新增留空）' },
  { key: 'title',           label: '標題*' },
  { key: 'type',            label: '房型*（SUITE套房/ROOM雅房/WHOLE_FLOOR整層/SHARED_SUITE分租套房/STUDIO一房一廳/STORE店面/OFFICE辦公室/LIVE_OFFICE住辦/FACTORY廠房/PARKING車位/LAND土地/OTHER其他）' },
  { key: 'status',          label: '狀態（AVAILABLE可承租/COMING_SOON即將釋出/RENTED已出租/INACTIVE已下架/PAUSED已下架/PENDING審核中）' },
  { key: 'city',            label: '縣市*' },
  { key: 'district',        label: '行政區*' },
  { key: 'address',         label: '地址*' },
  { key: 'price',           label: '租金*（數字）' },
  { key: 'deposit',         label: '押金（預設：兩個月）' },
  { key: 'size',            label: '坪數*（數字）' },
  { key: 'floor',           label: '樓層（例：3F）' },
  { key: 'totalFloors',     label: '總樓層（數字）' },
  { key: 'mgmtFee',         label: '管理費（數字，預設0）' },
  { key: 'cleaningFee',     label: '清潔費（數字）' },
  { key: 'electricType',    label: '電費方式（meter台電/flat固定金額/included含租金）' },
  { key: 'electricRate',    label: '每度電費（electricType=meter時填）' },
  { key: 'electricFlat',    label: '固定電費金額（electricType=flat時填）' },
  { key: 'inclWifi',        label: '含網路（true/false）' },
  { key: 'inclWater',       label: '含水費（true/false）' },
  { key: 'inclCable',       label: '含第四台（true/false）' },
  { key: 'allowPets',       label: '可養寵物（true/false）' },
  { key: 'allowCook',       label: '可開伙（true/false）' },
  { key: 'allowShortTerm',  label: '可短租（true/false）' },
  { key: 'welcomeStudent',  label: '歡迎學生（true/false）' },
  { key: 'featured',        label: '精選房源（true/false）' },
  { key: 'description',     label: '房源描述' },
  { key: 'tags',            label: '標籤（多個用｜分隔，例：獨洗曬｜可租補｜近捷運）' },
]

function toCSVValue(val) {
  if (val === null || val === undefined) return ''
  const str = String(val)
  // 含逗號、引號、換行 → 用引號包覆
  if (str.includes(',') || str.includes('"') || str.includes('\n') || str.includes('｜')) {
    return '"' + str.replace(/"/g, '""') + '"'
  }
  return str
}

function parseCSVLine(line) {
  const result = []
  let cur = '', inQuote = false
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]
    if (inQuote) {
      if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++ }
      else if (ch === '"') inQuote = false
      else cur += ch
    } else {
      if (ch === '"') inQuote = true
      else if (ch === ',') { result.push(cur); cur = '' }
      else cur += ch
    }
  }
  result.push(cur)
  return result
}

function parseBool(v) {
  if (v === 'true' || v === '1' || v === 'TRUE') return true
  if (v === 'false' || v === '0' || v === 'FALSE') return false
  return undefined
}

// ── 匯出 GET /admin/api/property/export ────────────────────────────
router.get('/admin/api/property/export', async (req, res) => {
  const auth = await resolveRole(req.query.key)
  if (!auth) return res.status(401).json({ error: 'unauthorized' })

  const where = auth.role === 'super'
    ? { deletedAt: null }
    : { deletedAt: null, ownerId: auth.landlordId }

  const properties = await prisma.property.findMany({
    where,
    include: { tags: true },
    orderBy: { createdAt: 'desc' },
  })

  const header = CSV_FIELDS.map(f => toCSVValue(f.label)).join(',')
  const rows = properties.map(p => {
    const tags = p.tags.map(t => t.name).join('｜')
    return CSV_FIELDS.map(({ key }) => {
      if (key === 'tags') return toCSVValue(tags)
      return toCSVValue(p[key])
    }).join(',')
  })

  const csvContent = '\uFEFF' + [header, ...rows].join('\r\n')  // BOM for Excel

  res.setHeader('Content-Type', 'text/csv; charset=utf-8')
  res.setHeader('Content-Disposition', `attachment; filename="properties_${Date.now()}.csv"`)
  res.send(csvContent)
})

// ── 匯入 POST /admin/api/property/import ───────────────────────────
router.post('/admin/api/property/import', express.text({ type: 'text/csv', limit: '5mb' }), async (req, res) => {
  const auth = await resolveRole(req.query.key)
  if (!auth) return res.status(401).json({ error: 'unauthorized' })

  const csvText = req.body
  if (!csvText) return res.status(400).json({ error: '請上傳 CSV 內容' })

  // 移除 BOM
  const cleanText = csvText.replace(/^\uFEFF/, '')
  const lines = cleanText.split(/\r?\n/).filter(l => l.trim())
  if (lines.length < 2) return res.status(400).json({ error: 'CSV 至少需要標題列與一筆資料' })

  // 解析標題列，找欄位對應 index
  const headerCells = parseCSVLine(lines[0])
  const fieldKeys = CSV_FIELDS.map(f => f.key)
  const colIndex = {}
  fieldKeys.forEach(k => {
    const idx = CSV_FIELDS.findIndex(f => f.key === k)
    if (idx !== -1) colIndex[k] = idx
  })

  const results = { created: 0, updated: 0, skipped: 0, errors: [] }

  // 取得目標 ownerId（房東登入只能寫自己的）
  const targetOwnerId = auth.role === 'landlord' ? auth.landlordId : null

  // landlordId 固定使用系統管理員 User（admin@xiaowo.tw），與新增房源路由一致
  const adminUser = await prisma.user.upsert({
    where: { email: 'admin@xiaowo.tw' },
    update: {},
    create: { email: 'admin@xiaowo.tw', name: '小蝸出租', handle: 'xiaowo', role: 'LANDLORD', verified: true }
  })
  const userLandlordId = adminUser.id

  for (let i = 1; i < lines.length; i++) {
    const cells = parseCSVLine(lines[i])
    const get = (key) => (cells[colIndex[key]] || '').trim()

    const rowNum = i + 1
    const title = get('title')
    const price = parseInt(get('price'))
    const size = parseFloat(get('size'))
    const city = get('city')
    const district = get('district')
    const address = get('address')
    const type = get('type')

    if (!title || !price || !size || !city || !district || !address || !type) {
      results.errors.push(`第 ${rowNum} 列：必填欄位不完整（標題/租金/坪數/縣市/行政區/地址/房型）`)
      results.skipped++
      continue
    }

    const validTypes = ['SUITE','ROOM','WHOLE_FLOOR','SHARED_SUITE','STUDIO','STORE','OFFICE','LIVE_OFFICE','FACTORY','PARKING','LAND','OTHER']
    if (!validTypes.includes(type)) {
      results.errors.push(`第 ${rowNum} 列「${title}」：房型 "${type}" 無效`)
      results.skipped++
      continue
    }

    const tagNames = get('tags') ? get('tags').split('｜').map(t => t.trim()).filter(Boolean) : []

    const data = {
      title,
      type,
      status: get('status') || 'AVAILABLE',
      city, district, address,
      price,
      size,
      deposit: get('deposit') || '兩個月',
      floor: get('floor') || null,
      totalFloors: get('totalFloors') ? parseInt(get('totalFloors')) : null,
      mgmtFee: parseInt(get('mgmtFee')) || 0,
      cleaningFee: get('cleaningFee') ? parseInt(get('cleaningFee')) : null,
      electricType: get('electricType') || null,
      electricRate: get('electricRate') ? parseFloat(get('electricRate')) : null,
      electricFlat: get('electricFlat') ? parseInt(get('electricFlat')) : null,
      description: get('description') || '',
      inclWifi: parseBool(get('inclWifi')) ?? false,
      inclWater: parseBool(get('inclWater')) ?? false,
      inclCable: parseBool(get('inclCable')) ?? false,
      allowPets: parseBool(get('allowPets')) ?? false,
      allowCook: parseBool(get('allowCook')) ?? false,
      allowShortTerm: parseBool(get('allowShortTerm')) ?? false,
      welcomeStudent: parseBool(get('welcomeStudent')) ?? true,
      featured: parseBool(get('featured')) ?? false,
    }

    const existingId = get('id')

    try {
      if (existingId) {
        // ── 更新既有房源 ──
        const existing = await prisma.property.findUnique({ where: { id: existingId } })
        if (!existing) {
          results.errors.push(`第 ${rowNum} 列「${title}」：ID "${existingId}" 找不到`)
          results.skipped++
          continue
        }
        // 房東只能更新自己的房源
        if (auth.role === 'landlord' && existing.ownerId !== auth.landlordId) {
          results.errors.push(`第 ${rowNum} 列「${title}」：無權限更新此房源`)
          results.skipped++
          continue
        }
        await prisma.property.update({ where: { id: existingId }, data })
        // 更新標籤
        await prisma.propertyTag.deleteMany({ where: { propertyId: existingId } })
        if (tagNames.length) {
          await prisma.propertyTag.createMany({
            data: tagNames.map(name => ({ propertyId: existingId, name })),
            skipDuplicates: true,
          })
        }
        results.updated++
      } else {
        // ── 新增房源 ──
        // 需要 ownerId（房東）和 landlordId（User）
        const ownerId = auth.role === 'super' ? null : targetOwnerId

        const newProperty = await prisma.property.create({
          data: {
            ...data,
            landlordId: userLandlordId,
            ownerId,
          }
        })
        if (tagNames.length) {
          await prisma.propertyTag.createMany({
            data: tagNames.map(name => ({ propertyId: newProperty.id, name })),
            skipDuplicates: true,
          })
        }
        results.created++
      }
    } catch (e) {
      results.errors.push(`第 ${rowNum} 列「${title}」：${e.message}`)
      results.skipped++
    }
  }

  // 觸發前台快取更新
  try {
    await revalidateSite(['/listings', '/'])
  } catch (_) {}

  res.json({
    ok: true,
    created: results.created,
    updated: results.updated,
    skipped: results.skipped,
    errors: results.errors,
  })
})

module.exports = router
