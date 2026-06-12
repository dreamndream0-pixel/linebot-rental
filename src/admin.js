const express = require('express')
const prisma = require('./db')

const router = express.Router()

const ADMIN_KEY = process.env.ADMIN_KEY || 'snail1234'

// ── 權限解析 ─────────────────────────────────────────────────────
// ADMIN_KEY          → 總管理員，看全部
// MAIN_ADMIN_KEY     → 只看主帳號（source = main）
// LINE<n>_ADMIN_KEY  → 只看該帳號（source = LINE<n>_NAME）
function resolveRole(key) {
  if (!key) return null
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

// source 過濾條件
function sourceFilter(auth) {
  return auth.role === 'super' ? {} : { source: auth.source }
}

// ── API：取得所有資料（依權限過濾） ─────────────────────────────
router.get('/admin/api/data', async (req, res) => {
  const auth = resolveRole(req.query.key)
  if (!auth) return res.status(401).json({ error: 'unauthorized' })

  const tenantWhere = sourceFilter(auth)

  const [tenants, bookings, repairs, properties] = await Promise.all([
    prisma.tenant.findMany({ where: tenantWhere, include: { property: true }, orderBy: { createdAt: 'desc' } }),
    prisma.booking.findMany({ where: { tenant: tenantWhere }, include: { tenant: true, property: true }, orderBy: { createdAt: 'desc' } }),
    prisma.repair.findMany({ where: { tenant: tenantWhere }, include: { tenant: true, property: true }, orderBy: { createdAt: 'desc' } }),
    prisma.property.findMany({ orderBy: { name: 'asc' } }),
  ])

  res.json({ tenants, bookings, repairs, properties, account: auth.label })
})

// ── API：更新預約狀態 ───────────────────────────────────────────
router.post('/admin/api/booking/:id/status', express.json(), async (req, res) => {
  const auth = resolveRole(req.query.key)
  if (!auth) return res.status(401).json({ error: 'unauthorized' })

  // 受限帳號只能改自己 source 的資料
  if (auth.role === 'limited') {
    const existing = await prisma.booking.findUnique({ where: { id: req.params.id }, include: { tenant: true } })
    if (!existing || existing.tenant.source !== auth.source) {
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
    const existing = await prisma.repair.findUnique({ where: { id: req.params.id }, include: { tenant: true } })
    if (!existing || existing.tenant.source !== auth.source) {
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
  /* ── 登入畫面 ── */
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
  /* ── 主畫面 ── */
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
    margin: 0 auto 16px;
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
  .badge.CONFIRMED, .badge.IN_PROGRESS { background: #E8F1E9; color: var(--deep-sage); }
  .badge.DONE { background: #EEE; color: #888; }
  .badge.CANCELLED { background: #FAEAEA; color: var(--danger); }
  .actions { display: flex; gap: 6px; margin-top: 10px; flex-wrap: wrap; }
  .action-btn {
    padding: 6px 14px; border-radius: 8px; border: 1.5px solid var(--sage);
    background: transparent; color: var(--deep-sage); font-size: 13px;
    cursor: pointer; font-weight: 500;
  }
  .action-btn:hover { background: var(--sage); color: white; }
  .empty { text-align: center; color: #aaa; padding: 50px 0; font-size: 14px; }
  .toast {
    position: fixed; bottom: 24px; left: 50%; transform: translateX(-50%);
    background: var(--charcoal); color: white; padding: 12px 24px;
    border-radius: 99px; font-size: 14px; opacity: 0;
    transition: opacity .3s; pointer-events: none; z-index: 99;
  }
  .toast.show { opacity: 1; }
  @media (max-width: 600px) {
    .stats { grid-template-columns: repeat(2, 1fr); }
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

  <div class="tabs">
    <button class="tab active" data-tab="tenants" onclick="switchTab('tenants')">👥 用戶</button>
    <button class="tab" data-tab="bookings" onclick="switchTab('bookings')">📅 預約</button>
    <button class="tab" data-tab="repairs" onclick="switchTab('repairs')">🔧 維修</button>
  </div>

  <div class="content" id="content"></div>
</div>

<div class="toast" id="toast"></div>

<script>
let DATA = null
let KEY = sessionStorage.getItem('adminKey') || ''
let currentTab = 'tenants'

// 有記住密碼 → 隱藏登入畫面，顯示載入動畫，直接自動登入
if (KEY) {
  document.getElementById('loginView').style.display = 'none'
  document.getElementById('loadingView').style.display = 'flex'
  login(KEY)
}

async function login(savedKey) {
  const key = savedKey || document.getElementById('keyInput').value.trim()
  if (!key) return
  try {
    const res = await fetch('/admin/api/data?key=' + encodeURIComponent(key))
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
    renderStats()
    renderTab()
  } catch (e) {
    showToast('❌ 連線失敗')
    document.getElementById('loadingView').style.display = 'none'
    document.getElementById('loginView').style.display = 'flex'
  }
}

async function reload() {
  const res = await fetch('/admin/api/data?key=' + encodeURIComponent(KEY))
  DATA = await res.json()
  renderStats()
  renderTab()
}

function renderStats() {
  const pendingBookings = DATA.bookings.filter(b => b.status === 'PENDING').length
  const pendingRepairs = DATA.repairs.filter(r => r.status === 'PENDING').length
  document.getElementById('stats').innerHTML = \`
    <div class="stat-card"><div class="num">\${DATA.tenants.length}</div><div class="label">總用戶</div></div>
    <div class="stat-card"><div class="num">\${DATA.properties.filter(p=>p.isAvailable).length}</div><div class="label">空房</div></div>
    <div class="stat-card"><div class="num">\${pendingBookings}</div><div class="label">待確認預約</div></div>
    <div class="stat-card"><div class="num">\${pendingRepairs}</div><div class="label">待處理維修</div></div>
  \`
}

function switchTab(tab) {
  currentTab = tab
  document.querySelectorAll('.tab').forEach(t => t.classList.toggle('active', t.dataset.tab === tab))
  renderTab()
}

function renderTab() {
  const el = document.getElementById('content')
  if (currentTab === 'tenants') el.innerHTML = renderTenants()
  if (currentTab === 'bookings') el.innerHTML = renderBookings()
  if (currentTab === 'repairs') el.innerHTML = renderRepairs()
}

function renderTenants() {
  if (!DATA.tenants.length) return '<div class="empty">還沒有用戶，等人加 Bot 好友吧！</div>'
  return DATA.tenants.map(t => \`
    <div class="card">
      <div class="card-row">
        <div style="display:flex;gap:14px;align-items:flex-start;">
          \${t.avatarUrl
            ? '<img src="' + t.avatarUrl + '" style="width:52px;height:52px;border-radius:50%;object-fit:cover;flex-shrink:0;" onerror="this.style.display=\\'none\\'">'
            : '<div style="width:52px;height:52px;border-radius:50%;background:var(--cream);display:flex;align-items:center;justify-content:center;font-size:24px;flex-shrink:0;">👤</div>'}
          <div>
            <h3>\${t.customName ? t.customName + ' <span style="font-weight:400;font-size:13px;color:#aaa;">(' + (t.name || '未命名') + ')</span>' : (t.name || '未命名用戶')}
              <button onclick="editName('\${t.id}', '\${(t.customName || '').replace(/'/g, "\\\\'")}')" style="border:none;background:none;cursor:pointer;font-size:14px;" title="編輯備註名稱">✏️</button>
            </h3>
            \${t.statusMessage ? '<div style="font-size:13px;color:var(--sage);margin-bottom:4px;">💬 ' + t.statusMessage + '</div>' : ''}
            <div class="meta">
              \${t.source && t.source !== 'main' ? '<span style="background:#E8F1E9;color:var(--deep-sage);padding:2px 8px;border-radius:6px;font-size:11px;font-weight:700;">📍 ' + t.source + '</span> ' : ''}
              \${t.property ? '🏠 ' + t.property.name : '尚未入住'}
              \${t.phone ? ' · 📞 ' + t.phone : ''}
              <br>加入時間：\${fmtDate(t.createdAt)}
            </div>
            <span class="uid" onclick="copyText('\${t.lineUserId}')" title="點擊複製">\${t.lineUserId}</span>
          </div>
        </div>
      </div>
    </div>
  \`).join('')
}

function renderBookings() {
  if (!DATA.bookings.length) return '<div class="empty">目前沒有預約記錄</div>'
  const statusLabel = { PENDING:'待確認', CONFIRMED:'已確認', CANCELLED:'已取消', DONE:'已完成' }
  return DATA.bookings.map(b => \`
    <div class="card">
      <div class="card-row">
        <div>
          <h3>\${b.property.name}</h3>
          <div class="meta">
            📅 \${fmtDate(b.visitDate)} \${b.visitTime}<br>
            用戶：<span class="uid" onclick="copyText('\${b.tenant.lineUserId}')">\${b.tenant.lineUserId.slice(0,12)}...</span>
          </div>
        </div>
        <span class="badge \${b.status}">\${statusLabel[b.status]}</span>
      </div>
      \${b.status === 'PENDING' ? \`
      <div class="actions">
        <button class="action-btn" onclick="updateBooking('\${b.id}','CONFIRMED')">✅ 確認</button>
        <button class="action-btn" onclick="updateBooking('\${b.id}','CANCELLED')">❌ 取消</button>
      </div>\` : ''}
      \${b.status === 'CONFIRMED' ? \`
      <div class="actions">
        <button class="action-btn" onclick="updateBooking('\${b.id}','DONE')">🏁 標記完成</button>
      </div>\` : ''}
    </div>
  \`).join('')
}

function renderRepairs() {
  if (!DATA.repairs.length) return '<div class="empty">目前沒有維修回報</div>'
  const statusLabel = { PENDING:'待處理', IN_PROGRESS:'處理中', DONE:'已完成' }
  return DATA.repairs.map(r => \`
    <div class="card">
      <div class="card-row">
        <div>
          <h3>\${r.title} · \${r.property.name}</h3>
          <div class="meta">\${r.description}<br>回報時間：\${fmtDate(r.createdAt)}</div>
        </div>
        <span class="badge \${r.status}">\${statusLabel[r.status]}</span>
      </div>
      \${r.status !== 'DONE' ? \`
      <div class="actions">
        \${r.status === 'PENDING' ? '<button class="action-btn" onclick="updateRepair(\\''+r.id+'\\',\\'IN_PROGRESS\\')">🔧 開始處理</button>' : ''}
        <button class="action-btn" onclick="updateRepair('\${r.id}','DONE')">✅ 完成</button>
      </div>\` : ''}
    </div>
  \`).join('')
}

async function updateBooking(id, status) {
  await fetch('/admin/api/booking/' + id + '/status?key=' + encodeURIComponent(KEY), {
    method: 'POST', headers: {'Content-Type':'application/json'},
    body: JSON.stringify({ status })
  })
  showToast('✅ 已更新')
  reload()
}

async function updateRepair(id, status) {
  await fetch('/admin/api/repair/' + id + '/status?key=' + encodeURIComponent(KEY), {
    method: 'POST', headers: {'Content-Type':'application/json'},
    body: JSON.stringify({ status })
  })
  showToast('✅ 已更新')
  reload()
}

function copyText(text) {
  navigator.clipboard.writeText(text)
  showToast('📋 已複製 User ID')
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

async function editName(tenantId, currentName) {
  const newName = prompt('輸入備註名稱（清空 = 恢復顯示 LINE 名稱）:', currentName)
  if (newName === null) return
  await fetch('/admin/api/tenant/' + tenantId + '/name?key=' + encodeURIComponent(KEY), {
    method: 'POST', headers: {'Content-Type':'application/json'},
    body: JSON.stringify({ customName: newName.trim() })
  })
  showToast('✅ 名稱已更新')
  reload()
}

function fmtDate(d) {
  return new Date(d).toLocaleDateString('zh-TW', { year:'numeric', month:'2-digit', day:'2-digit' })
}

function showToast(msg) {
  const t = document.getElementById('toast')
  t.textContent = msg
  t.classList.add('show')
  setTimeout(() => t.classList.remove('show'), 2000)
}
</script>
</body>
</html>`

module.exports = router
