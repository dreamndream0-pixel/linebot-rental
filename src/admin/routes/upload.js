// src/admin/routes/upload.js
const express = require('express')
const router = express.Router()
const cloudinary = require('cloudinary').v2
const multer = require('multer')
const { resolveRole } = require('../helpers')

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
})
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } })

router.post('/admin/api/upload', upload.single('file'), async (req, res) => {
  const auth = await resolveRole(req.query.key)
  if (!auth) return res.status(401).json({ error: 'unauthorized' })

  if (!process.env.CLOUDINARY_CLOUD_NAME) {
    return res.status(500).json({ error: 'Cloudinary 未設定' })
  }
  if (!req.file) return res.status(400).json({ error: '未選擇檔案' })

  try {
    const base64 = `data:${req.file.mimetype};base64,${req.file.buffer.toString('base64')}`
    const result = await cloudinary.uploader.upload(base64, {
      folder: 'xiaowo-rental/properties',
      transformation: [{ width: 1200, height: 900, crop: 'limit', quality: 'auto:good' }],
    })
    res.json({ url: result.secure_url, cloudinaryId: result.public_id })
  } catch (e) {
    console.error('上傳失敗:', e.message)
    res.status(500).json({ error: '上傳失敗' })
  }
})

module.exports = router
