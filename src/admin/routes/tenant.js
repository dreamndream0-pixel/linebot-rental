// src/admin/routes/tenant.js
const express = require('express')
const router = express.Router()
const prisma = require('../../db')
const { resolveRole, ownsRecord } = require('../helpers')

router.post('/admin/api/tenant/:id/name', express.json(), async (req, res) => {
  const auth = await resolveRole(req.query.key)
  if (!auth) return res.status(401).json({ error: 'unauthorized' })

  const existing = await prisma.tenant.findUnique({ where: { id: req.params.id } })
  if (!ownsRecord(auth, existing)) return res.status(403).json({ error: 'forbidden' })

  const tenant = await prisma.tenant.update({
    where: { id: req.params.id },
    data: { customName: req.body.customName || null }
  })
  res.json(tenant)
})

module.exports = router
