const express = require('express')
const router = express.Router()
const { PrismaClient } = require('@prisma/client')
const { resolveRole } = require('../helpers')
const prisma = new PrismaClient()

router.get('/admin/api/community', async (req, res) => {
  try {
    const auth = await resolveRole(req.query.key)
    if (!auth) return res.status(401).json({ error: 'unauthorized' })
    const where = auth.role === 'superadmin' ? {} : { ownerId: auth.landlordId }
    const communities = await prisma.community.findMany({ where, orderBy: { createdAt: 'desc' } })
    res.json(communities)
  } catch(e) { res.status(500).json({ error: e.message }) }
})

router.post('/admin/api/community', express.json(), async (req, res) => {
  try {
    const auth = await resolveRole(req.query.key)
    if (!auth) return res.status(401).json({ error: 'unauthorized' })
    const ownerId = auth.role === 'superadmin' ? req.body.ownerId : auth.landlordId
    const { name, description = '', photos = [], mapUrl = '' } = req.body
    if (!name) return res.status(400).json({ error: '請填寫社區名稱' })
    const c = await prisma.community.create({
      data: { ownerId, name, description, photos: JSON.stringify(photos), mapUrl: mapUrl || null }
    })
    res.json(c)
  } catch(e) { res.status(500).json({ error: e.message }) }
})

router.post('/admin/api/community/:id', express.json(), async (req, res) => {
  try {
    const auth = await resolveRole(req.query.key)
    if (!auth) return res.status(401).json({ error: 'unauthorized' })
    const { name, description, photos, mapUrl } = req.body
    const data = {}
    if (name !== undefined) data.name = name
    if (description !== undefined) data.description = description
    if (photos !== undefined) data.photos = JSON.stringify(photos)
    if (mapUrl !== undefined) data.mapUrl = mapUrl || null
    const c = await prisma.community.update({ where: { id: req.params.id }, data })
    res.json(c)
  } catch(e) { res.status(500).json({ error: e.message }) }
})

router.post('/admin/api/community/:id/delete', express.json(), async (req, res) => {
  try {
    const auth = await resolveRole(req.query.key)
    if (!auth) return res.status(401).json({ error: 'unauthorized' })
    await prisma.property.updateMany({ where: { communityId: req.params.id }, data: { communityId: null } })
    await prisma.community.delete({ where: { id: req.params.id } })
    res.json({ ok: true })
  } catch(e) { res.status(500).json({ error: e.message }) }
})

module.exports = router
