// src/admin/routes/features.js
const express = require('express')
const router = express.Router()
const prisma = require('../../db')
const { resolveRole } = require('../helpers')

const DEFAULT_FEATURES = { bot: true, site: true, heroSlides: true, booking: true, repair: true, community: true, csvImport: true, social: true }

function parseFeatures(json) {
  if (!json) return { ...DEFAULT_FEATURES }
  try { return { ...DEFAULT_FEATURES, ...JSON.parse(json) } } catch { return { ...DEFAULT_FEATURES } }
}

router.get('/admin/api/landlord/:id/features', async (req, res) => {
  const auth = await resolveRole(req.query.key)
  if (!auth) return res.status(401).json({ error: 'unauthorized' })
  // 房東只能查自己的 features；super 可查任意
  if (auth.role !== 'super' && auth.landlordId !== req.params.id) return res.status(403).json({ error: 'forbidden' })
  try {
    const rows = await prisma.$queryRawUnsafe(`SELECT features FROM landlords WHERE id = $1`, req.params.id)
    res.json(parseFeatures(rows[0]?.features))
  } catch(e) { res.status(500).json({ error: e.message }) }
})

router.post('/admin/api/landlord/:id/features', express.json(), async (req, res) => {
  const auth = await resolveRole(req.query.key)
  if (!auth || auth.role !== 'super') return res.status(401).json({ error: 'unauthorized' })
  try {
    const features = req.body.features || {}
    await prisma.$queryRawUnsafe(`UPDATE landlords SET features = $1, "updatedAt" = NOW() WHERE id = $2`, JSON.stringify(features), req.params.id)
    try { require('../../landlordWebhook').clearConfigCache(req.params.id) } catch (e) {}
    try { require('../../botText').clearTextCache(req.params.id) } catch (e) {}
    res.json({ ok: true, features })
  } catch(e) { res.status(500).json({ error: e.message }) }
})

module.exports = router
