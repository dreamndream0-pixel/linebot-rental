// src/admin.js — 後台入口，只負責掛載各模組 router
const express = require('express')
const path = require('path')
const router = express.Router()
const {
  createAdminSession,
  createImpersonationSession,
  resolveRole,
  hashAdminKey,
  SESSION_COOKIE_NAME,
  SESSION_MAX_AGE_MS,
} = require('./admin/helpers')

const loginFailures = new Map()
const LOGIN_WINDOW_MS = 15 * 60 * 1000
const LOGIN_LOCK_MS = 15 * 60 * 1000
const LOGIN_MAX_FAILURES = 8

// 用 Express 的 req.ip（需搭配 index.js 的 app.set('trust proxy', 1)）取得真實客戶端 IP。
// 直接讀 X-Forwarded-For 並取第一段會被使用者自帶該 header 偽造繞過鎖定機制，
// req.ip 在信任代理層數設定正確時，只採用代理鏈中可信的那一段，不可被使用者偽造。
function clientIp(req) {
  return req.ip || req.socket?.remoteAddress || 'unknown'
}

function loginRateKey(req, key) {
  return `${clientIp(req)}:${hashAdminKey(key).slice(0, 16)}`
}

function isLoginLocked(req, key) {
  const k = loginRateKey(req, key)
  const item = loginFailures.get(k)
  if (!item) return false
  if (item.lockUntil && item.lockUntil > Date.now()) return true
  if (item.lastAt + LOGIN_WINDOW_MS < Date.now()) loginFailures.delete(k)
  return false
}

function recordLoginFailure(req, key) {
  const k = loginRateKey(req, key)
  const now = Date.now()
  const item = loginFailures.get(k) || { count: 0, lastAt: now, lockUntil: 0 }
  if (item.lastAt + LOGIN_WINDOW_MS < now) item.count = 0
  item.count += 1
  item.lastAt = now
  if (item.count >= LOGIN_MAX_FAILURES) item.lockUntil = now + LOGIN_LOCK_MS
  loginFailures.set(k, item)
}

function clearLoginFailures(req, key) {
  loginFailures.delete(loginRateKey(req, key))
}

function parseCookies(req) {
  return Object.fromEntries(String(req.headers.cookie || '')
    .split(';')
    .map(v => v.trim())
    .filter(Boolean)
    .map(v => {
      const idx = v.indexOf('=')
      return idx === -1 ? [v, ''] : [v.slice(0, idx), decodeURIComponent(v.slice(idx + 1))]
    }))
}

function cookieOptions(maxAgeSeconds) {
  const secure = process.env.NODE_ENV === 'production' ? '; Secure' : ''
  return `HttpOnly; Path=/admin; Max-Age=${maxAgeSeconds}; SameSite=Lax${secure}`
}

function setSessionCookie(res, token) {
  res.setHeader('Set-Cookie', `${SESSION_COOKIE_NAME}=${encodeURIComponent(token)}; ${cookieOptions(Math.floor(SESSION_MAX_AGE_MS / 1000))}`)
}

function clearSessionCookie(res) {
  res.setHeader('Set-Cookie', `${SESSION_COOKIE_NAME}=; ${cookieOptions(0)}`)
}

router.post('/admin/api/login', express.json(), async (req, res) => {
  const key = String(req.body?.key || '').trim()
  if (isLoginLocked(req, key)) return res.status(429).json({ error: 'too_many_attempts' })
  const session = await createAdminSession(key)
  if (!session) {
    recordLoginFailure(req, key)
    return res.status(401).json({ error: 'unauthorized' })
  }
  clearLoginFailures(req, key)
  setSessionCookie(res, session.token)
  res.json({
    ok: true,
    account: session.auth.label,
    role: session.auth.role,
    landlordId: session.auth.landlordId || null,
    expiresIn: Math.floor(session.maxAgeMs / 1000),
  })
})

router.post('/admin/api/logout', (_req, res) => {
  clearSessionCookie(res)
  res.json({ ok: true })
})

// 後台金鑰可放在 HTTP header（X-Admin-Key），避免金鑰出現在網址 / 伺服器日誌。
// 為了相容舊呼叫，header 不存在時仍沿用網址上的 ?key=。
// 注意：Express 的 req.query 是 getter（每次存取重新解析 URL），直接改 req.query.key
// 不會留存，因此先快照成固定物件再覆寫，下游 resolveRole(req.query.key) 才讀得到。
router.use((req, _res, next) => {
  const headerKey = req.get('X-Admin-Key')
  const sessionToken = parseCookies(req)[SESSION_COOKIE_NAME]
  const q = Object.assign({}, req.query)
  if (headerKey) q.key = headerKey
  else if (!q.key && sessionToken) q.key = `SESSION:${sessionToken}`
  else if (q.key && process.env.ALLOW_ADMIN_QUERY_KEY !== 'true') delete q.key
  Object.defineProperty(req, 'query', { value: q, configurable: true, writable: true })
  next()
})

// ── 操作人員權限守門（在 session-key 中介層之後，才讀得到 req.query.key）──────────
// full＝與房東相同；view（僅檢視）＝只允許 GET；limited（有限操作）＝可日常編輯，
// 但不可刪除、不可改房東/Bot 設定與金鑰、不可管理操作人員、不可改門鎖設定。
const OPERATOR_LIMITED_DENY = [
  /^\/admin\/api\/operators/,          // 操作人員管理
  /^\/admin\/api\/landlord/,           // 房東 / Bot 設定、金鑰
  /^\/admin\/api\/smartlock/,          // 智慧門鎖設定
  /^\/admin\/api\/features/,           // 功能開關
  /^\/admin\/api\/internal-landlord/,  // 內部房東
]
router.use(async (req, res, next) => {
  if (!req.path.startsWith('/admin/api/')) return next()
  const method = req.method.toUpperCase()
  if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') return next()
  let auth = null
  try { auth = await resolveRole(req.query.key) } catch (_) {}
  if (!auth || !auth.operator) return next()   // 非操作人員（房東本人／總管理員／未登入）照舊
  const perm = auth.operator.permission
  if (perm === 'full') return next()
  if (perm === 'view') {
    return res.status(403).json({ error: '此帳號為「僅檢視」權限，無法執行變更操作' })
  }
  // limited：擋刪除與敏感設定
  if (method === 'DELETE' || OPERATOR_LIMITED_DENY.some(re => re.test(req.path))) {
    return res.status(403).json({ error: '此操作人員為「有限操作」權限，無法執行此項操作' })
  }
  return next()
})

// 操作紀錄（審計軌跡）：記錄所有寫入類 /admin/api/* 操作。
// 必須在 session-key 中介層之後（才讀得到 req.query.key），並在各業務 router 之前掛載。
const auditRouter = require('./admin/routes/audit')
router.use(auditRouter.auditMiddleware)

// POST /admin/api/switch-to-broker — 僅總管理員：切換成仲介視角（建立 imp:true 的模擬 session）
// 此路由必須在 session-key 中介層之後，才能從 cookie 取得 req.query.key
router.post('/admin/api/switch-to-broker', async (req, res) => {
  const auth = await resolveRole(req.query.key)
  if (!auth || auth.role !== 'super') return res.status(403).json({ error: 'forbidden' })
  const BROKER_ID = process.env.BROKER_LANDLORD_ID || 'cmqbys4qr0004keruq1niq5xz'
  const session = await createImpersonationSession(BROKER_ID)
  if (!session) return res.status(404).json({ error: '找不到仲介房東或已停用' })
  setSessionCookie(res, session.token)
  res.json({ ok: true, name: session.name })
})

// POST /admin/api/switch-to-super — 從「仲介視角」返回總管理員
// 只允許由總管理員切換而來的模擬 session（imp:true）返回；真正的房東登入無法藉此提權。
router.post('/admin/api/switch-to-super', async (req, res) => {
  const auth = await resolveRole(req.query.key)
  if (!auth || auth.imp !== true) {
    return res.status(403).json({ error: 'forbidden' })
  }
  const session = await createAdminSession(process.env.ADMIN_KEY)
  if (!session) return res.status(500).json({ error: '無法建立管理員 session' })
  setSessionCookie(res, session.token)
  res.json({ ok: true, account: session.auth.label, role: session.auth.role })
})

async function requireSuper(req, res) {
  const auth = await resolveRole(req.query.key)
  if (!auth) {
    res.status(401).json({ error: 'unauthorized' })
    return null
  }
  if (auth.role !== 'super') {
    res.status(403).json({ error: 'forbidden' })
    return null
  }
  return auth
}

function siteUrl() {
  return (process.env.SITE_URL || 'https://xiaowo-rental.vercel.app').replace(/\/$/, '')
}

async function proxySiteAdmin(req, res, pathSuffix, method, body) {
  if (!process.env.ADMIN_KEY) return res.status(500).json({ error: 'ADMIN_KEY 未設定' })
  try {
    const upstream = await fetch(`${siteUrl()}${pathSuffix}`, {
      method,
      headers: {
        Authorization: `Bearer ${process.env.ADMIN_KEY}`,
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    })
    const text = await upstream.text()
    res.status(upstream.status)
    res.type(upstream.headers.get('content-type') || 'application/json')
    res.send(text)
  } catch (e) {
    res.status(502).json({ error: e.message })
  }
}

router.get('/admin/api/site/hero', async (req, res) => {
  if (!(await requireSuper(req, res))) return
  await proxySiteAdmin(req, res, '/api/admin/hero', 'GET')
})

router.post('/admin/api/site/hero', express.json(), async (req, res) => {
  if (!(await requireSuper(req, res))) return
  await proxySiteAdmin(req, res, '/api/admin/hero', 'POST', req.body)
})

router.get('/admin/api/site/pages', async (req, res) => {
  if (!(await requireSuper(req, res))) return
  await proxySiteAdmin(req, res, '/api/admin/pages', 'GET')
})

router.post('/admin/api/site/pages', express.json(), async (req, res) => {
  if (!(await requireSuper(req, res))) return
  await proxySiteAdmin(req, res, '/api/admin/pages', 'POST', req.body)
})

router.use(require('./admin/routes/data'))
router.use(require('./admin/routes/booking'))
router.use(require('./admin/routes/repair'))
router.use(require('./admin/routes/tenant'))
router.use(require('./admin/routes/property'))
router.use(require('./admin/routes/upload'))
router.use(require('./admin/routes/landlord'))
router.use(require('./admin/routes/operators'))
router.use(require('./admin/routes/community'))
router.use(require('./admin/routes/importexport'))
router.use(require('./admin/routes/features'))
router.use(require('./admin/routes/contactNotify'))
router.use(require('./admin/routes/internalLandlord'))
router.use(require('./admin/routes/webusers'))
router.use(require('./admin/routes/social'))
router.use(require('./admin/routes/fbUserToken'))
router.use(require('./admin/routes/managedProperty'))
router.use(require('./admin/routes/smartlock'))
router.use(auditRouter)

router.use('/admin/assets', express.static(path.join(__dirname, 'admin/assets')))

router.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, 'admin/views/admin.html'))
})

router.get('/admin/fb-user-token', (req, res) => {
  res.sendFile(path.join(__dirname, 'admin/views/fb-user-token.html'))
})

module.exports = router
