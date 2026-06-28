// src/admin.js — 後台入口，只負責掛載各模組 router
const express = require('express')
const path = require('path')
const router = express.Router()

// 後台金鑰可放在 HTTP header（X-Admin-Key），避免金鑰出現在網址 / 伺服器日誌。
// 為了相容舊呼叫，header 不存在時仍沿用網址上的 ?key=。
// 注意：Express 的 req.query 是 getter（每次存取重新解析 URL），直接改 req.query.key
// 不會留存，因此先快照成固定物件再覆寫，下游 resolveRole(req.query.key) 才讀得到。
router.use((req, _res, next) => {
  const headerKey = req.get('X-Admin-Key')
  const q = Object.assign({}, req.query)
  if (headerKey) q.key = headerKey
  Object.defineProperty(req, 'query', { value: q, configurable: true, writable: true })
  next()
})

router.use(require('./admin/routes/data'))
router.use(require('./admin/routes/booking'))
router.use(require('./admin/routes/repair'))
router.use(require('./admin/routes/tenant'))
router.use(require('./admin/routes/property'))
router.use(require('./admin/routes/upload'))
router.use(require('./admin/routes/landlord'))
router.use(require('./admin/routes/community'))
router.use(require('./admin/routes/importexport'))
router.use(require('./admin/routes/features'))
router.use(require('./admin/routes/contactNotify'))
router.use(require('./admin/routes/internalLandlord'))
router.use(require('./admin/routes/webusers'))
router.use(require('./admin/routes/social'))
router.use(require('./admin/routes/managedProperty'))

router.use('/admin/assets', express.static(path.join(__dirname, 'admin/assets')))

router.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, 'admin/views/admin.html'))
})

module.exports = router
