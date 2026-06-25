// src/admin/routes/booking.js
const express = require('express')
const router = express.Router()
const prisma = require('../../db')
const { resolveRole, ownsRecord, notifyBookingTenant } = require('../helpers')

router.post('/admin/api/booking/:id/status', express.json(), async (req, res) => {
  const auth = await resolveRole(req.query.key)
  if (!auth) return res.status(401).json({ error: 'unauthorized' })

  const allowedStatuses = ['CONFIRMED', 'CANCELLED', 'COMPLETED', 'REJECTED']
  if (!allowedStatuses.includes(req.body.status)) {
    return res.status(400).json({ error: 'invalid status' })
  }

  const existing = await prisma.booking.findUnique({
    where: { id: req.params.id },
    include: { lineUser: true, property: true }
  })
  if (!ownsRecord(auth, existing)) return res.status(403).json({ error: 'forbidden' })

  // 退回時可附帶備注理由（會一併通知租客）
  const rejectReason = req.body.status === 'REJECTED'
    ? String(req.body.rejectReason || '').trim()
    : null

  const booking = await prisma.booking.update({
    where: { id: req.params.id },
    data: { status: req.body.status, ...(rejectReason !== null && { rejectReason }) },
  })
  const notification = await notifyBookingTenant(existing, req.body.status, rejectReason)
  res.json({ booking, notification })
})

module.exports = router
