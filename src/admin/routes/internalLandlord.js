// src/admin/routes/internalLandlord.js
// Internal API to create/sync landlord from xiaowo
const express = require('express')
const router = express.Router()
const crypto = require('crypto')
const prisma = require('../../db')
const { hashAdminKey } = require('../helpers')

router.post('/api/internal/create-landlord', express.json(), async (req, res) => {
  const { secret, name, email, phone, userId } = req.body

  if (!secret || secret !== process.env.INTERNAL_SECRET) {
    return res.status(401).json({ error: 'unauthorized' })
  }

  if (!email) return res.status(400).json({ error: 'missing email' })

  try {
    // Check if landlord with same email already exists
    const existing = await prisma.landlord.findFirst({ where: { email } })
    if (existing) {
      return res.json({ ok: true, landlordId: existing.id })
    }

    // Create new landlord
    const adminKey = 'LL-' + crypto.randomBytes(9).toString('base64url')
    const passwordHash = crypto.createHash('sha256').update(crypto.randomBytes(6).toString('base64url')).digest('hex')

    const landlord = await prisma.landlord.create({
      data: {
        name: name || email,
        email,
        phone: phone || null,
        adminKey: null,
        adminKeyHash: hashAdminKey(adminKey),
        passwordHash,
      },
    })

    return res.json({ ok: true, landlordId: landlord.id })
  } catch (e) {
    console.error('create-landlord 失敗:', e.message)
    return res.status(500).json({ error: '建立房東失敗' })
  }
})

module.exports = router
