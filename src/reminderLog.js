// src/reminderLog.js — 繳租提醒推播結果紀錄
// success＝LINE 受理推播請求，不代表房客已收到。寫入失敗一律吞掉，絕不影響推播本身。
const prisma = require('./db')

// 錯誤訊息過濾：移除 token、LINE userId 等，並截斷
function sanitizeError(msg) {
  if (msg == null) return null
  return String(msg)
    .replace(/Bearer\s+[A-Za-z0-9._\-+/=]+/gi, 'Bearer ***')
    .replace(/\bU[0-9a-f]{32}\b/g, '[userId]')
    .replace(/[A-Za-z0-9+/=_\-]{40,}/g, '***')
    .slice(0, 300)
}

// entry: { source, recipient, leaseId, tenantId, tenantName, period, success, error }
async function logReminder(entry) {
  try {
    await prisma.reminderLog.create({
      data: {
        source: entry.source,
        recipient: entry.recipient || 'TENANT',
        leaseId: entry.leaseId || null,
        tenantId: entry.tenantId || null,
        tenantName: entry.tenantName || null,
        period: entry.period || null,
        success: !!entry.success,
        error: entry.success ? null : sanitizeError(entry.error),
      },
    })
  } catch (e) {
    console.error('提醒推播紀錄寫入失敗（不影響推播）:', e && e.message)
  }
}

// 最近 N 天（只回傳白名單欄位）
async function listRecentReminders(days = 60) {
  const since = new Date(Date.now() - days * 86400000)
  const rows = await prisma.reminderLog.findMany({
    where: { createdAt: { gte: since } },
    orderBy: { createdAt: 'desc' },
    take: 2000,
  })
  return rows.map(r => ({
    createdAt: r.createdAt,
    source: r.source,
    recipient: r.recipient,
    leaseId: r.leaseId,
    tenantName: r.tenantName,
    period: r.period,
    success: r.success,
    error: sanitizeError(r.error),
  }))
}

module.exports = { logReminder, listRecentReminders, sanitizeError }
