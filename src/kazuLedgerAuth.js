// src/kazuLedgerAuth.js — KAZU 對帳 API 鑰匙驗證（純函式，只用 crypto）
const crypto = require('crypto')

// 回傳 'disabled'（功能未啟用／鑰匙不安全）、'unauthorized'、'ok'
function checkKazuKey(headerValue, env) {
  const e = env || {}
  const key = e.KAZU_LEDGER_KEY
  if (!key || key.length < 32) return 'disabled'
  if (key === e.ADMIN_KEY || key === e.BROKER_ADMIN_KEY) return 'disabled'
  const m = /^Bearer\s+(.+)$/i.exec(String(headerValue || '').trim())
  if (!m) return 'unauthorized'
  const given = Buffer.from(m[1])
  const expected = Buffer.from(key)
  if (given.length !== expected.length) return 'unauthorized'
  return crypto.timingSafeEqual(given, expected) ? 'ok' : 'unauthorized'
}

module.exports = { checkKazuKey }
