// src/admin/routes/webusers.js
// 網站註冊用戶（僅限 super admin）
const express = require('express')
const router = express.Router()
const prisma = require('../../db')
const { resolveRole } = require('../helpers')

router.get('/admin/api/webusers', async (req, res) => {
  const auth = await resolveRole(req.query.key)
  if (!auth || auth.role !== 'super') return res.status(401).json({ error: 'unauthorized' })

  try {
    const users = await prisma.$queryRawUnsafe(`
      SELECT id, name, email, phone, role, verified,
             created_at AS "createdAt",
             deleted_at AS "deletedAt"
      FROM users
      ORDER BY created_at DESC
      LIMIT 200
    `)
    // 不回傳 passwordHash，確保密碼不外洩
    res.json(users)
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

module.exports = router
