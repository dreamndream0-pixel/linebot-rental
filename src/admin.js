// src/admin.js — 後台入口，只負責掛載各模組 router
const express = require('express')
const path = require('path')
const router = express.Router()

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
