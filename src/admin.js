const express = require('express')
const prisma = require('./db')

const router = express.Router()

// 不再提供預設密碼：沒設定環境變數就拒絕所有登入
const ADMIN_KEY = process.env.ADMIN_KEY

// ── 權限解析 ─────────────────────────────────────────────────────
function resolveRole(key) {
  if (!key || !ADMIN_KEY) return null
  if (key === ADMIN_KEY) return { role: 'super', source: null, label: '總管理員' }
  if (process.env.MAIN_ADMIN_KEY && key === process.env.MAIN_ADMIN_KEY) {
    return { role: 'limited', source: 'main', label: '主帳號' }
  }
  for (const envKey of Object.keys(process.env)) {
    const m = envKey.match(/^LINE(\d+)_ADMIN_KEY$/)
    if (m && process.env[envKey] === key) {
      const source = process.env[`LINE${m[1]}_NAME`] || `channel${m[1]}`
      return { role: 'limited', source, label: source }
    }
  }
  return null
}

function sourceFilter(auth) {
  return auth.role === 'super' ? {} : { source: auth.source }
}

// 確保有一個預設房東帳號（後台新增房源時使用）
async function getDefaultLandlord() {
  return prisma.user.upsert({
    where: { email: 'admin@xiaowo.tw' },
    update: {},
    create: {
      email: 'admin@xiaowo.tw',
      name: '小蝸出租',
      handle: 'xiaowo',
      role: 'LANDLORD',
      verified: true,
    }
  })
}

// ── API：取得所有資料 ───────────────────────────────────────────
router.get('/admin/api/data', async (req, res) => {
  const auth = resolveRole(req.query.key)
  if (!auth) return res.status(401).json({ error: 'unauthorized' })

  const tenantWhere = sourceFilter(auth)

  const [tenants, bookings, repairs, properties] = await Promise.all([
    prisma.tenant.findMany({ where: tenantWhere, include: { property: true }, orderBy: { createdAt: 'desc' } }),
    prisma.booking.findMany({
      where: auth.role === 'super' ? {} : { lineUser: tenantWhere },
      include: { lineUser: true, tenant: true, property: true },
      orderBy: { createdAt: 'desc' }
    }),
    prisma.repair.findMany({
      where: auth.role === 'super' ? {} : { lineUser: tenantWhere },
      include: { lineUser: true, property: true },
      orderBy: { createdAt: 'desc' }
    }),
    prisma.property.findMany({
      where: { deletedAt: null },
      include: { images: { orderBy: [{ isCover: 'desc' }, { order: 'asc' }] } },
      orderBy: { createdAt: 'desc' }
    }),
  ])

  res.json({ tenants, bookings, repairs, properties, account: auth.label, role: auth.role })
})

// ── API：更新預約狀態 ───────────────────────────────────────────
router.post('/admin/api/booking/:id/status', express.json(), async (req, res) => {
  const auth = resolveRole(req.query.key)
  if (!auth) return res.status(401).json({ error: 'unauthorized' })

  if (auth.role === 'limited') {
    const existing = await prisma.booking.findUnique({ where: { id: req.params.id }, include: { lineUser: true } })
    if (!existing || existing.lineUser?.source !== auth.source) {
      return res.status(403).json({ error: 'forbidden' })
    }
  }

  const { status } = req.body
  const booking = await prisma.booking.update({ where: { id: req.params.id }, data: { status } })
  res.json(booking)
})

// ── API：更新維修狀態 ───────────────────────────────────────────
router.post('/admin/api/repair/:id/status', express.json(), async (req, res) => {
  const auth = resolveRole(req.query.key)
  if (!auth) return res.status(401).json({ error: 'unauthorized' })

  if (auth.role === 'limited') {
    const existing = await prisma.repair.findUnique({ where: { id: req.params.id }, include: { lineUser: true } })
    if (!existing || existing.lineUser?.source !== auth.source) {
      return res.status(403).json({ error: 'forbidden' })
    }
  }

  const { status } = req.body
  const repair = await prisma.repair.update({ where: { id: req.params.id }, data: { status } })
  res.json(repair)
})

// ── API：更新租客備註名稱 ───────────────────────────────────────
router.post('/admin/api/tenant/:id/name', express.json(), async (req, res) => {
  const auth = resolveRole(req.query.key)
  if (!auth) return res.status(401).json({ error: 'unauthorized' })

  if (auth.role === 'limited') {
    const existing = await prisma.tenant.findUnique({ where: { id: req.params.id } })
    if (!existing || existing.source !== auth.source) {
      return res.status(403).json({ error: 'forbidden' })
    }
  }

  const { customName } = req.body
  const tenant = await prisma.tenant.update({
    where: { id: req.params.id },
    data: { customName: customName || null }
  })
  res.json(tenant)
})

// ── API：新增房源（僅總管理員） ─────────────────────────────────
router.post('/admin/api/property', express.json(), async (req, res) => {
  const auth = resolveRole(req.query.key)
  if (!auth || auth.role !== 'super') return res.status(401).json({ error: 'unauthorized' })

  const { title, type, city, district, address, size, price, deposit, description, imageUrls, status } = req.body
  if (!title || !price) return res.status(400).json({ error: 'title 和 price 為必填' })

  const landlord = await getDefaultLandlord()

  const property = await prisma.property.create({
    data: {
      landlordId: landlord.id,
      title,
      type: type || 'SUITE',
      status: status || 'AVAILABLE',
      city: city || '台中市',
      district: district || '',
      address: address || '',
      size: parseFloat(size) || 0,
      price: parseInt(price),
      deposit: deposit || '兩個月',
      description: description || '',
      images: {
        create: (imageUrls || []).map((url, i) => ({ url, order: i, isCover: i === 0 }))
      }
    }
  })

  res.json(property)
})

// ── API：編輯房源（僅總管理員） ─────────────────────────────────
router.post('/admin/api/property/:id', express.json(), async (req, res) => {
  const auth = resolveRole(req.query.key)
  if (!auth || auth.role !== 'super') return res.status(401).json({ error: 'unauthorized' })

  const { title, type, city, district, address, size, price, deposit, description, imageUrls, status } = req.body

  const data = {}
  if (title !== undefined) data.title = title
  if (type !== undefined) data.type = type
  if (status !== undefined) data.status = status
  if (city !== undefined) data.city = city
  if (district !== undefined) data.district = district
  if (address !== undefined) data.address = address
  if (size !== undefined) data.size = parseFloat(size) || 0
  if (price !== undefined) data.price = parseInt(price)
  if (deposit !== undefined) data.deposit = deposit
  if (description !== undefined) data.description = description

  const property = await prisma.property.update({ where: { id: req.params.id }, data })

  // 若有提供照片清單，整批重建
  if (Array.isArray(imageUrls)) {
    await prisma.propertyImage.deleteMany({ where: { propertyId: req.params.id } })
    if (imageUrls.length) {
      await prisma.propertyImage.createMany({
        data: imageUrls.map((url, i) => ({ propertyId: req.params.id, url, order: i, isCover: i === 0 }))
      })
    }
  }

  res.json(property)
})

// ── API：刪除房源（軟刪除，僅總管理員） ─────────────────────────
router.post('/admin/api/property/:id/delete', express.json(), async (req, res) => {
  const auth = resolveRole(req.query.key)
  if (!auth || auth.role !== 'super') return res.status(401).json({ error: 'unauthorized' })

  const property = await prisma.property.update({
    where: { id: req.params.id },
    data: { deletedAt: new Date(), status: 'PAUSED' }
  })
  res.json(property)
})

// ── 後台頁面 ─────────────────────────────────────────────────────
router.get('/admin', (req, res) => {
  res.send(ADMIN_HTML)
})

const ADMIN_HTML = `<!DOCTYPE html>
<html lang="zh-TW">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>🐌 小蝸出租 · 管理後台</title>
<style>
  :root {
    --cream: #F0EDE6;
    --sage: #7A9E7E;
    --deep-sage: #4E7153;
    --charcoal: #3D3D3D;
    --white: #FFFFFF;
    --warn: #E8A87C;
    --danger: #D97070;
  }
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body {
    font-family: "Noto Sans TC", -apple-system, sans-serif;
    background: var(--cream);
    color: var(--charcoal);
    min-height: 100vh;
  }
  #loginView {
    display: flex; align-items: center; justify-content: center;
    min-height: 100vh; flex-direction: column; gap: 20px;
  }
  #loadingView {
    display: none; align-items: center; justify-content: center;
    min-height: 100vh; flex-direction: column; gap: 16px;
  }
  .spinner {
    width: 40px; height: 40px; border: 4px solid #E5E0D5;
    border-top-color: var(--sage); border-radius: 50%;
    animation: spin .8s linear infinite;
  }
  @keyframes spin { to { transform: rotate(360deg); } }
  #loadingView p { color: #888; font-size: 14px; }
  .login-card {
    background: var(--white); padding: 40px; border-radius: 20px;
    box-shadow: 0 10px 40px rgba(0,0,0,0.08); text-align: center;
    max-width: 360px; width: 90%;
  }
  .login-card h1 { font-size: 28px; margin-bottom: 8px; }
  .login-card p { color: #888; font-size: 14px; margin-bottom: 24px; }
  .login-card input {
    width: 100%; padding: 14px; border: 2px solid #E5E0D5;
    border-radius: 12px; font-size: 16px; margin-bottom: 16px;
    outline: none; transition: border .2s;
  }
  .login-card input:focus { border-color: var(--sage); }
  .btn {
    background: var(--sage); color: white; border: none;
    padding: 14px 28px; border-radius: 12px; font-size: 16px;
    cursor: pointer; width: 100%; font-weight: 700;
    transition: background .2s;
  }
  .btn:hover { background: var(--deep-sage); }
  #mainView { display: none; }
  header {
    background: linear-gradient(135deg, var(--sage), var(--deep-sage));
    color: white; padding: 24px 20px;
  }
  header h1 { font-size: 22px; }
  header p { font-size: 13px; opacity: .8; margin-top: 4px; }
  .stats {
    display: grid; grid-template-columns: repeat(4, 1fr); gap: 10px;
    padding: 16px 20px; max-width: 900px; margin: 0 auto;
  }
  .stat-card {
    background: var(--white); border-radius: 14px; padding: 14px;
    text-align: center; box-shadow: 0 2px 10px rgba(0,0,0,0.04);
  }
  .stat-card .num { font-size: 26px; font-weight: 900; color: var(--deep-sage); }
  .stat-card .label { font-size: 12px; color: #888; margin-top: 2px; }
  .tabs {
    display: flex; gap: 8px; padding: 0 20px; max-width: 900px;
    margin: 0 auto 16px; flex-wrap: wrap;
  }
  .tab {
    padding: 10px 18px; border-radius: 99px; border: none;
    background: var(--white); color: var(--charcoal); font-size: 14px;
    cursor: pointer; font-weight: 500;
  }
  .tab.active { background: var(--charcoal); color: white; }
  .content { max-width: 900px; margin: 0 auto; padding: 0 20px 60px; }
  .card {
    background: var(--white); border-radius: 16px; padding: 18px;
    margin-bottom: 12px; box-shadow: 0 2px 10px rgba(0,0,0,0.04);
  }
  .card-row { display: flex; justify-content: space-between; align-items: flex-start; gap: 12px; flex-wrap: wrap; }
  .card h3 { font-size: 16px; margin-bottom: 6px; }
  .card .meta { font-size: 13px; color: #888; line-height: 1.7; }
  .uid {
    font-family: monospace; font-size: 12px; background: var(--cream);
    padding: 3px 8px; border-radius: 6px; cursor: pointer;
    word-break: break-all; display: inline-block; margin-top: 4px;
  }
  .uid:hover { background: #E5E0D5; }
  .badge {
    display: inline-block; padding: 4px 12px; border-radius: 99px;
    font-size: 12px; font-weight: 700;
  }
  .badge.PENDING { background: #FBF0E3; color: #C98B4E; }
  .badge.CONFIRMED, .badge.IN_PROGRESS, .badge.AVAILABLE { background: #E8F1E9; color: var(--deep-sage); }
  .badge.DONE, .badge.COMPLETED, .badge.RENTED { background: #EEE; color: #888; }
  .badge.CANCELLED, .badge.REJECTED { background: #FAEAEA; color: var(--danger); }
  .badge.PAUSED { background: #F3F0E8; color: #A89B6C; }
  .actions { display: flex; gap: 6px; margin-top: 10px; flex-wrap: wrap; }
  .action-btn {
    padding: 6px 14px; border-radius: 8px; border: 1.5px solid var(--sage);
    background: transparent; color: var(--deep-sage); font-size: 13px;
    cursor: pointer; font-weight: 500;
  }
  .action-btn:hover { background: var(--sage); color: white; }
  .action-btn.danger { border-color: var(--danger); color: var(--danger); }
  .action-btn.danger:hover { background: var(--danger); color: white; }
  .empty { text-align: center; color: #aaa; padding: 50px 0; font-size: 14px; }
  .form-box { background: var(--white); border-radius: 16px; padding: 20px; margin-bottom: 16px; box-shadow: 0 2px 10px rgba(0,0,0,0.04); }
  .form-box h3 { margin-bottom: 14px; }
  .form-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
  .form-grid .full { grid-column: 1 / -1; }
  .form-box input, .form-box select, .form-box textarea {
    width: 100%; padding: 10px 12px; border: 1.5px solid #E5E0D5;
    border-radius: 10px; font-size: 14px; outline: none; font-family: inherit;
  }
  .form-box input:focus, .form-box select:focus, .form-box textarea:focus { border-color: var(--sage); }
  .form-box label { font-size: 12px; color: #888; display: block; margin-bottom: 4px; }
  .prop-thumb { width: 72px; height: 54px; border-radius: 8px; object-fit: cover; flex-shrink: 0; background: var(--cream); }
  .toast {
    position: fixed; bottom: 24px; left: 50%; transform: translateX(-50%);
    background: var(--charcoal); color: white; padding: 12px 24px;
    border-radius: 99px; font-size: 14px; opacity: 0;
    transition: opacity .3s; pointer-events: none; z-index: 99;
  }
  .toast.show { opacity: 1; }
  @media (max-width: 600px) {
    .stats { grid-template-columns: repeat(2, 1fr); }
    .form-grid { grid-template-columns: 1fr; }
  }
</style>
</head>
<body>

<div id="loadingView">
  <div class="spinner"></div>
  <p>🐌 載入中...</p>
</div>

<div id="loginView">
  <div class="login-card">
    <h1>🐌 小蝸出租</h1>
    <p>管理後台</p>
    <input type="password" id="keyInput" placeholder="輸入管理密碼" onkeydown="if(event.key==='Enter')login()">
    <button class="btn" onclick="login()">登入</button>
  </div>
</div>

<div id="mainView">
  <header>
    <div style="display:flex;justify-content:space-between;align-items:center;">
      <div>
        <h1>🐌 小蝸出租 管理後台</h1>
        <p id="accountLabel">用戶、預約、維修一覽</p>
      </div>
      <button onclick="logout()" style="background:rgba(255,255,255,.18);border:1px solid rgba(255,255,255,.4);color:white;padding:8px 16px;border-radius:99px;font-size:13px;cursor:pointer;">登出</button>
    </div>
  </header>

  <div class="stats" id="stats"></div>

  <div class="tabs" id="tabBar"></div>

  <div class="content" id="content"></div>
</div>

<div class="toast" id="toast"></div>

<script>
var DATA = null
var KEY = sessionStorage.getItem('adminKey') || ''
var currentTab = 'tenants'
var editingPropertyId = null

var TYPE_LABEL = { SUITE: '套房', ROOM: '雅房', WHOLE_FLOOR: '整層住家', SHARED_SUITE: '分租套房' }
var PROP_STATUS_LABEL = { PENDING: '審核中', AVAILABLE: '可租', RENTED: '已租', PAUSED: '暫停刊登', REJECTED: '退回' }
var BOOKING_LABEL = { PENDING: '⏳ 待確認', CONFIRMED: '✅ 已確認', REJECTED: '❌ 已拒絕', CANCELLED: '❌ 已取消', COMPLETED: '🏁 已完成' }
var REPAIR_LABEL = { PENDING: '待處理', IN_PROGRESS: '處理中', DONE: '已完成' }

if (KEY) {
  document.getElementById('loginView').style.display = 'none'
  document.getElementById('loadingView').style.display = 'flex'
  login(KEY)
}

async function login(savedKey) {
  var key = savedKey || document.getElementById('keyInput').value.trim()
  if (!key) return
  try {
    var res = await fetch('/admin/api/data?key=' + encodeURIComponent(key))
    if (!res.ok) {
      showToast('❌ 密碼錯誤')
      sessionStorage.removeItem('adminKey')
      document.getElementById('loadingView').style.display = 'none'
      document.getElementById('loginView').style.display = 'flex'
      return
    }
    DATA = await res.json()
    KEY = key
    sessionStorage.setItem('adminKey', key)
    document.getElementById('loginView').style.display = 'none'
    document.getElementById('loadingView').style.display = 'none'
    document.getElementById('mainView').style.display = 'block'
    if (DATA.account) {
      document.getElementById('accountLabel').textContent = '👤 ' + DATA.account
    }
    renderTabBar()
    renderStats()
    renderTab()
  } catch (e) {
    showToast('❌ 連線失敗')
    document.getElementById('loadingView').style.display = 'none'
    document.getElementById('loginView').style.display = 'flex'
  }
}

function logout() {
  sessionStorage.removeItem('adminKey')
  KEY = ''
  DATA = null
  document.getElementById('mainView').style.display = 'none'
  document.getElementById('loadingView').style.display = 'none'
  document.getElementById('loginView').style.display = 'flex'
  document.getElementById('keyInput').value = ''
}

async function reload() {
  var res = await fetch('/admin/api/data?key=' + encodeURIComponent(KEY))
  DATA = await res.json()
  renderStats()
  renderTab()
}

function renderTabBar() {
  var tabs = [
    { id: 'tenants', label: '👥 用戶' },
    { id: 'bookings', label: '📅 預約' },
    { id: 'repairs', label: '🔧 維修' },
  ]
  if (DATA.role === 'super') {
    tabs.push({ id: 'properties', label: '🏠 房源管理' })
  }
  document.getElementById('tabBar').innerHTML = tabs.map(function(t) {
    return '<button class="tab' + (currentTab === t.id ? ' active' : '') + '" data-tab="' + t.id + '" onclick="switchTab(\\'' + t.id + '\\')">' + t.label + '</button>'
  }).join('')
}

function renderStats() {
  var pendingBookings = DATA.bookings.filter(function(b){ return b.status === 'PENDING' }).length
  var pendingRepairs = DATA.repairs.filter(function(r){ return r.status === 'PENDING' }).length
  var available = DATA.properties.filter(function(p){ return p.status === 'AVAILABLE' }).length
  document.getElementById('stats').innerHTML =
    '<div class="stat-card"><div class="num">' + DATA.tenants.length + '</div><div class="label">總用戶</div></div>' +
    '<div class="stat-card"><div class="num">' + available + '</div><div class="label">可租房源</div></div>' +
    '<div class="stat-card"><div class="num">' + pendingBookings + '</div><div class="label">待確認預約</div></div>' +
    '<div class="stat-card"><div class="num">' + pendingRepairs + '</div><div class="label">待處理維修</div></div>'
}

function switchTab(tab) {
  currentTab = tab
  document.querySelectorAll('.tab').forEach(function(t) {
    t.classList.toggle('active', t.dataset.tab === tab)
  })
  renderTab()
}

function renderTab() {
  var el = document.getElementById('content')
  if (currentTab === 'tenants') el.innerHTML = renderTenants()
  if (currentTab === 'bookings') el.innerHTML = renderBookings()
  if (currentTab === 'repairs') el.innerHTML = renderRepairs()
  if (currentTab === 'properties') el.innerHTML = renderProperties()
}

function esc(s) {
  return String(s == null ? '' : s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;')
}

function renderTenants() {
  if (!DATA.tenants.length) return '<div class="empty">還沒有用戶，等人加 Bot 好友吧！</div>'
  return DATA.tenants.map(function(t) {
    var avatar = t.avatarUrl
      ? '<img src="' + esc(t.avatarUrl) + '" style="width:52px;height:52px;border-radius:50%;object-fit:cover;flex-shrink:0;" onerror="this.style.display=\\'none\\'">'
      : '<div style="width:52px;height:52px;border-radius:50%;background:var(--cream);display:flex;align-items:center;justify-content:center;font-size:24px;flex-shrink:0;">👤</div>'
    var nameHtml = t.customName
      ? esc(t.customName) + ' <span style="font-weight:400;font-size:13px;color:#aaa;">(' + esc(t.name || '未命名') + ')</span>'
      : esc(t.name || '未命名用戶')
    var sourceTag = (t.source && t.source !== 'main')
      ? '<span style="background:#E8F1E9;color:var(--deep-sage);padding:2px 8px;border-radius:6px;font-size:11px;font-weight:700;">📍 ' + esc(t.source) + '</span> '
      : ''
    return '<div class="card"><div class="card-row">' +
      '<div style="display:flex;gap:14px;align-items:flex-start;">' + avatar +
      '<div><h3>' + nameHtml +
      ' <button onclick="editName(\\'' + t.id + '\\', \\'' + esc(t.customName || '').replace(/'/g, '') + '\\')" style="border:none;background:none;cursor:pointer;font-size:14px;" title="編輯備註名稱">✏️</button></h3>' +
      (t.statusMessage ? '<div style="font-size:13px;color:var(--sage);margin-bottom:4px;">💬 ' + esc(t.statusMessage) + '</div>' : '') +
      '<div class="meta">' + sourceTag +
      (t.property ? '🏠 ' + esc(t.property.title) : '尚未入住') +
      (t.phone ? ' · 📞 ' + esc(t.phone) : '') +
      '<br>加入時間：' + fmtDate(t.createdAt) + '</div>' +
      '<span class="uid" onclick="copyText(\\'' + t.lineUserId + '\\')" title="點擊複製">' + t.lineUserId + '</span>' +
      '</div></div></div></div>'
  }).join('')
}

function renderBookings() {
  if (!DATA.bookings.length) return '<div class="empty">目前沒有預約記錄</div>'
  return DATA.bookings.map(function(b) {
    var who = b.lineUser
      ? (b.lineUser.customName || b.lineUser.name || b.lineUser.lineUserId.slice(0,12) + '...')
      : (b.tenant ? b.tenant.name + '（網站）' : '未知')
    var html = '<div class="card"><div class="card-row"><div>' +
      '<h3>' + esc(b.property.title) + '</h3>' +
      '<div class="meta">📅 ' + fmtDate(b.date) + ' ' + esc(b.timeslot) + '<br>用戶：' + esc(who) + '</div></div>' +
      '<span class="badge ' + b.status + '">' + (BOOKING_LABEL[b.status] || b.status) + '</span></div>'
    if (b.status === 'PENDING') {
      html += '<div class="actions">' +
        '<button class="action-btn" onclick="updateBooking(\\'' + b.id + '\\',\\'CONFIRMED\\')">✅ 確認</button>' +
        '<button class="action-btn" onclick="updateBooking(\\'' + b.id + '\\',\\'CANCELLED\\')">❌ 取消</button></div>'
    } else if (b.status === 'CONFIRMED') {
      html += '<div class="actions">' +
        '<button class="action-btn" onclick="updateBooking(\\'' + b.id + '\\',\\'COMPLETED\\')">🏁 標記完成</button></div>'
    }
    return html + '</div>'
  }).join('')
}

function renderRepairs() {
  if (!DATA.repairs.length) return '<div class="empty">目前沒有維修回報</div>'
  return DATA.repairs.map(function(r) {
    var who = r.lineUser ? (r.lineUser.customName || r.lineUser.name || '') : ''
    var html = '<div class="card"><div class="card-row"><div>' +
      '<h3>' + esc(r.title) + ' · ' + esc(r.property.title) + '</h3>' +
      '<div class="meta">' + esc(r.description) +
      (who ? '<br>回報人：' + esc(who) : '') +
      '<br>回報時間：' + fmtDate(r.createdAt) + '</div></div>' +
      '<span class="badge ' + r.status + '">' + (REPAIR_LABEL[r.status] || r.status) + '</span></div>'
    if (r.status !== 'DONE') {
      html += '<div class="actions">'
      if (r.status === 'PENDING') {
        html += '<button class="action-btn" onclick="updateRepair(\\'' + r.id + '\\',\\'IN_PROGRESS\\')">🔧 開始處理</button>'
      }
      html += '<button class="action-btn" onclick="updateRepair(\\'' + r.id + '\\',\\'DONE\\')">✅ 完成</button></div>'
    }
    return html + '</div>'
  }).join('')
}

// ── 房源管理 ──────────────────────────────────────────────────────
function renderProperties() {
  var formHtml = propertyForm()
  if (!DATA.properties.length) {
    return formHtml + '<div class="empty">還沒有房源，用上方表單新增第一間！</div>'
  }
  var listHtml = DATA.properties.map(function(p) {
    var thumb = (p.images && p.images[0])
      ? '<img class="prop-thumb" src="' + esc(p.images[0].url) + '" onerror="this.style.display=\\'none\\'">'
      : '<div class="prop-thumb" style="display:flex;align-items:center;justify-content:center;font-size:22px;">🏠</div>'
    var statusOptions = Object.keys(PROP_STATUS_LABEL).map(function(s) {
      return '<option value="' + s + '"' + (p.status === s ? ' selected' : '') + '>' + PROP_STATUS_LABEL[s] + '</option>'
    }).join('')
    return '<div class="card"><div class="card-row">' +
      '<div style="display:flex;gap:14px;align-items:flex-start;">' + thumb +
      '<div><h3>' + esc(p.title) + '</h3>' +
      '<div class="meta">' + esc(p.city) + esc(p.district) + ' · ' + (TYPE_LABEL[p.type] || '') +
      ' · NT$ ' + Number(p.price).toLocaleString() + '/月' +
      (p.size ? ' · ' + p.size + '坪' : '') + '</div></div></div>' +
      '<span class="badge ' + p.status + '">' + (PROP_STATUS_LABEL[p.status] || p.status) + '</span></div>' +
      '<div class="actions">' +
      '<select onchange="changePropertyStatus(\\'' + p.id + '\\', this.value)" style="padding:6px 10px;border-radius:8px;border:1.5px solid #E5E0D5;font-size:13px;">' + statusOptions + '</select>' +
      '<button class="action-btn" onclick="startEditProperty(\\'' + p.id + '\\')">✏️ 編輯</button>' +
      '<button class="action-btn danger" onclick="deleteProperty(\\'' + p.id + '\\')">🗑️ 刪除</button>' +
      '</div></div>'
  }).join('')
  return formHtml + listHtml
}

function propertyForm() {
  var p = editingPropertyId ? DATA.properties.find(function(x){ return x.id === editingPropertyId }) : null
  var typeOptions = Object.keys(TYPE_LABEL).map(function(t) {
    return '<option value="' + t + '"' + (p && p.type === t ? ' selected' : '') + '>' + TYPE_LABEL[t] + '</option>'
  }).join('')
  var imageUrls = p && p.images ? p.images.map(function(i){ return i.url }).join(', ') : ''
  return '<div class="form-box"><h3>' + (p ? '✏️ 編輯房源：' + esc(p.title) : '➕ 新增房源') + '</h3>' +
    '<div class="form-grid">' +
    '<div class="full"><label>房源名稱 *</label><input id="f_title" value="' + esc(p ? p.title : '') + '" placeholder="例：紅寶石11號 201室 採光套房"></div>' +
    '<div><label>類型</label><select id="f_type">' + typeOptions + '</select></div>' +
    '<div><label>月租金 *</label><input id="f_price" type="number" value="' + (p ? p.price : '') + '" placeholder="8000"></div>' +
    '<div><label>城市</label><input id="f_city" value="' + esc(p ? p.city : '台中市') + '"></div>' +
    '<div><label>區域</label><input id="f_district" value="' + esc(p ? p.district : '') + '" placeholder="北區"></div>' +
    '<div><label>坪數</label><input id="f_size" type="number" step="0.1" value="' + (p ? p.size : '') + '" placeholder="5.5"></div>' +
    '<div><label>押金</label><input id="f_deposit" value="' + esc(p ? p.deposit : '兩個月') + '"></div>' +
    '<div class="full"><label>地址（不公開，僅自己看）</label><input id="f_address" value="' + esc(p ? p.address : '') + '"></div>' +
    '<div class="full"><label>描述</label><textarea id="f_desc" rows="2" placeholder="採光良好，含冷氣熱水器...">' + esc(p ? p.description : '') + '</textarea></div>' +
    '<div class="full"><label>照片網址（多張用逗號分隔，第一張為封面）</label><input id="f_images" value="' + esc(imageUrls) + '" placeholder="https://... , https://..."></div>' +
    '</div>' +
    '<div class="actions" style="margin-top:14px;">' +
    '<button class="btn" style="width:auto;padding:10px 24px;" onclick="saveProperty()">' + (p ? '儲存修改' : '新增房源') + '</button>' +
    (p ? '<button class="action-btn" onclick="cancelEdit()">取消編輯</button>' : '') +
    '</div></div>'
}

function startEditProperty(id) {
  editingPropertyId = id
  renderTab()
  window.scrollTo({ top: 0, behavior: 'smooth' })
}

function cancelEdit() {
  editingPropertyId = null
  renderTab()
}

async function saveProperty() {
  var body = {
    title: document.getElementById('f_title').value.trim(),
    type: document.getElementById('f_type').value,
    price: document.getElementById('f_price').value,
    city: document.getElementById('f_city').value.trim(),
    district: document.getElementById('f_district').value.trim(),
    size: document.getElementById('f_size').value,
    deposit: document.getElementById('f_deposit').value.trim(),
    address: document.getElementById('f_address').value.trim(),
    description: document.getElementById('f_desc').value.trim(),
    imageUrls: document.getElementById('f_images').value.split(',').map(function(s){ return s.trim() }).filter(Boolean),
  }
  if (!body.title || !body.price) { showToast('❌ 名稱和租金必填'); return }

  var url = editingPropertyId
    ? '/admin/api/property/' + editingPropertyId + '?key=' + encodeURIComponent(KEY)
    : '/admin/api/property?key=' + encodeURIComponent(KEY)

  var res = await fetch(url, {
    method: 'POST', headers: {'Content-Type':'application/json'},
    body: JSON.stringify(body)
  })
  if (!res.ok) { showToast('❌ 儲存失敗'); return }
  showToast(editingPropertyId ? '✅ 已更新房源' : '✅ 已新增房源')
  editingPropertyId = null
  reload()
}

async function changePropertyStatus(id, status) {
  await fetch('/admin/api/property/' + id + '?key=' + encodeURIComponent(KEY), {
    method: 'POST', headers: {'Content-Type':'application/json'},
    body: JSON.stringify({ status: status })
  })
  showToast('✅ 狀態已更新')
  reload()
}

async function deleteProperty(id) {
  if (!confirm('確定要刪除這個房源嗎？')) return
  await fetch('/admin/api/property/' + id + '/delete?key=' + encodeURIComponent(KEY), {
    method: 'POST', headers: {'Content-Type':'application/json'}, body: '{}'
  })
  showToast('🗑️ 已刪除')
  reload()
}

async function updateBooking(id, status) {
  await fetch('/admin/api/booking/' + id + '/status?key=' + encodeURIComponent(KEY), {
    method: 'POST', headers: {'Content-Type':'application/json'},
    body: JSON.stringify({ status: status })
  })
  showToast('✅ 已更新')
  reload()
}

async function updateRepair(id, status) {
  await fetch('/admin/api/repair/' + id + '/status?key=' + encodeURIComponent(KEY), {
    method: 'POST', headers: {'Content-Type':'application/json'},
    body: JSON.stringify({ status: status })
  })
  showToast('✅ 已更新')
  reload()
}

async function editName(tenantId, currentName) {
  var newName = prompt('輸入備註名稱（清空 = 恢復顯示 LINE 名稱）:', currentName)
  if (newName === null) return
  await fetch('/admin/api/tenant/' + tenantId + '/name?key=' + encodeURIComponent(KEY), {
    method: 'POST', headers: {'Content-Type':'application/json'},
    body: JSON.stringify({ customName: newName.trim() })
  })
  showToast('✅ 名稱已更新')
  reload()
}

function copyText(text) {
  navigator.clipboard.writeText(text)
  showToast('📋 已複製 User ID')
}

function fmtDate(d) {
  return new Date(d).toLocaleDateString('zh-TW', { year:'numeric', month:'2-digit', day:'2-digit' })
}

function showToast(msg) {
  var t = document.getElementById('toast')
  t.textContent = msg
  t.classList.add('show')
  setTimeout(function(){ t.classList.remove('show') }, 2000)
}
</script>
</body>
</html>`

module.exports = router
