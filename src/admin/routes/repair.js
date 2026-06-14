// src/admin/routes/repair.js
const express = require('express')
const router = express.Router()
const prisma = require('../../db')
const { resolveRole, ownsRecord } = require('../helpers')

router.post('/admin/api/repair/:id/status', express.json(), async (req, res) => {
  const auth = await resolveRole(req.query.key)
  if (!auth) return res.status(401).json({ error: 'unauthorized' })

  const existing = await prisma.repair.findUnique({ where: { id: req.params.id } })
  if (!ownsRecord(auth, existing)) return res.status(403).json({ error: 'forbidden' })

  const repair = await prisma.repair.update({ where: { id: req.params.id }, data: { status: req.body.status } })
  res.json(repair)
})

module.exports = router
