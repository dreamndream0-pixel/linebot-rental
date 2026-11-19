// src/kazuLedgerParse.js — KAZU 對帳 API 的純函式（只用 Node 內建模組，不碰資料庫／express）
const KINDS = ['rent', 'parking', 'utility']

function isValidYmd(s) {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false
  const d = new Date(`${s}T00:00:00Z`)
  return !isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s
}

function addDaysYmd(s, n) {
  return new Date(new Date(`${s}T00:00:00Z`).getTime() + n * 86400000).toISOString().slice(0, 10)
}

// 'rp:<id>' | 'ur:<id>' | 'sched:<leaseId>:<kind>:<YYYY-MM-DD>'；其餘回 null
function parseItemId(s) {
  if (typeof s !== 'string' || !s) return null
  const parts = s.split(':')
  if ((parts[0] === 'rp' || parts[0] === 'ur') && parts.length === 2 && parts[1]) {
    return { type: parts[0], id: parts[1] }
  }
  if (parts[0] === 'sched' && parts.length === 4) {
    const [, leaseId, kind, period] = parts
    if (leaseId && KINDS.includes(kind) && isValidYmd(period)) return { type: 'sched', leaseId, kind, period }
  }
  return null
}

// body 二選一：{itemId, paidAmount, paidDate} 或 {leaseId, kind, period, paidAmount, paidDate}
// paidAmount 0 允許（路由再依應繳金額判斷）；paidDate 不可晚於 todayYmd + 1 天
function parsePaymentBody(body, todayYmd) {
  const b = body && typeof body === 'object' ? body : {}
  const { paidAmount, paidDate } = b
  if (typeof paidAmount !== 'number' || !Number.isInteger(paidAmount) || paidAmount < 0) {
    return { ok: false, error: 'invalid paidAmount' }
  }
  if (!isValidYmd(paidDate)) return { ok: false, error: 'invalid paidDate' }
  if (isValidYmd(todayYmd) && paidDate > addDaysYmd(todayYmd, 1)) return { ok: false, error: 'paidDate in the future' }

  let itemId
  if (b.itemId !== undefined && b.itemId !== null) {
    if (!parseItemId(b.itemId)) return { ok: false, error: 'invalid itemId' }
    itemId = b.itemId
  } else if (b.leaseId !== undefined && b.leaseId !== null) {
    if (typeof b.leaseId !== 'string' || !b.leaseId || b.leaseId.includes(':')) return { ok: false, error: 'invalid leaseId' }
    if (!KINDS.includes(b.kind)) return { ok: false, error: 'invalid kind' }
    if (!isValidYmd(b.period)) return { ok: false, error: 'invalid period' }
    itemId = `sched:${b.leaseId}:${b.kind}:${b.period}`
  } else {
    return { ok: false, error: 'itemId or leaseId+kind+period required' }
  }
  return { ok: true, value: { itemId, paidAmount, paidDate } }
}

module.exports = { KINDS, isValidYmd, parseItemId, parsePaymentBody }
