// src/rentSchedule.js — 租金排程與待繳清單的純計算（不連資料庫，可單獨測試）
const HIDDEN_RENT_PAYMENT_NOTE = '__HIDDEN_RENT_SCHEDULE_ROW__'

function addMonths(date, months) {
  const d = new Date(date)
  const day = d.getDate()
  d.setMonth(d.getMonth() + months)
  if (d.getDate() !== day) d.setDate(0)
  return d
}

function cycleMonths(cycle) {
  return { BIMONTHLY: 2, QUARTERLY: 3, SEMIANNUAL: 6, YEARLY: 12 }[cycle] || 1
}

function ymd(d) {
  return d ? new Date(d).toISOString().slice(0, 10) : null
}

function startOfDay(d) {
  const x = new Date(d)
  x.setHours(0, 0, 0, 0)
  return x
}

function dateTime(d) {
  return d ? new Date(d).getTime() : 0
}

// 折扣後的實際月租金（FIXED=折固定金額；PERCENT=折%數；都不可低於 0）
function effectiveRent(lease) {
  const rent = lease.rent || 0
  if (lease.discountType === 'FIXED') return Math.max(0, rent - (lease.discountValue || 0))
  if (lease.discountType === 'PERCENT') return Math.max(0, Math.round(rent * (1 - (lease.discountValue || 0) / 100)))
  return rent
}

function isHiddenRentPayment(p) {
  // 前綴比對：租金隱藏標記為 HIDDEN_RENT_PAYMENT_NOTE；車位隱藏標記在其後附「 車位」，
  // 使其同時被 isParkingRentPayment 判為車位、落到車位排程，仍被視為隱藏列。
  return !!(p && typeof p.note === 'string' && p.note.startsWith(HIDDEN_RENT_PAYMENT_NOTE))
}

function isParkingRentPayment(p) {
  return /車位|停車|parking/i.test(String((p && p.note) || ''))
}

function isPaidRentPayment(p) {
  return !!(p && (p.paidAmount || 0) > 0)
}

function isValidRentPeriod(p) {
  return !!(p && p.periodStart && p.periodEnd && dateTime(p.periodEnd) >= dateTime(p.periodStart))
}

function rentPeriodsOverlap(a, b) {
  if (!isValidRentPeriod(a) || !isValidRentPeriod(b)) return false
  // 需「實質重疊」才算重複：僅在同一天邊界相接（前一期迄日＝下一期起日，
  // 常見於 Ragic 同步的日期位移）不算重疊，避免把相鄰期別誤判為重複而漏掉一期。
  return dateTime(a.periodStart) < dateTime(b.periodEnd) && dateTime(b.periodStart) < dateTime(a.periodEnd)
}

function rentPeriodDuration(p) {
  return Math.max(0, dateTime(p.periodEnd) - dateTime(p.periodStart))
}

function buildRentSchedule(lease, rentPayments, opts = {}) {
  if (!lease.leaseStart) return []
  const months = cycleMonths(lease.paymentCycle)
  const start = new Date(lease.leaseStart)
  const leaseEnd = lease.leaseEnd ? new Date(lease.leaseEnd) : addMonths(start, 12)
  const payDay = lease.rentPayDay || start.getDate()
  const rows = []
  // 已儲存的期別（含未收款的「僅修改金額/應繳日」覆寫）：都列入明細；
  // 已繳者鎖定，未繳者維持可編輯。
  const stored = (rentPayments || [])
    .filter(p => opts.onlyParking ? isParkingRentPayment(p) : !isParkingRentPayment(p))
    .slice()
    .sort((a, b) => new Date(a.periodStart) - new Date(b.periodStart))
  // 去重 + 隱藏被隱藏的產生期別：Ragic 同步與系統合約可能為「同一段期間」各建一筆
  // （起始日差幾天／金額不同）而重複。同段期間（期間重疊）只保留一筆：
  // 優先已繳款者；都未繳則保留「非 Ragic 民國日期備註」那筆（系統為主）。
  const _isRagicDateNote = (s) => /^\s*\d{2,4}[\/\-]\d{1,2}[\/\-]\d{1,2}\s*[~\-]/.test(String(s || ''))
  const _betterRow = (a, b) => {
    const pa = isPaidRentPayment(a), pb = isPaidRentPayment(b)
    if (pa !== pb) return pa ? a : b
    const ra = _isRagicDateNote(a.note), rb = _isRagicDateNote(b.note)
    if (ra !== rb) return ra ? b : a
    if (rentPeriodDuration(a) !== rentPeriodDuration(b)) return rentPeriodDuration(a) > rentPeriodDuration(b) ? a : b
    return a
  }
  const dedupedStored = []
  const hiddenRaw = []       // 所有隱藏標記（去重殘留 + 使用者手動刪除）
  stored.forEach(p => {
    if (isHiddenRentPayment(p)) {
      if (p.periodStart && p.periodEnd) hiddenRaw.push(p)
      return
    }
    if (!isValidRentPeriod(p) && !isPaidRentPayment(p)) return
    const idx = dedupedStored.findIndex(k => rentPeriodsOverlap(k, p))
    if (idx === -1) dedupedStored.push(p)
    else dedupedStored[idx] = _betterRow(dedupedStored[idx], p)
  })
  // 隱藏標記（去重殘留 + 使用者手動刪除）全部收集；是否擋住某期產生，改以
  // 「精準對齊該期網格」判斷（見下方 genOverlapsStored），而非範圍重疊——
  // 這樣使用者刪除的單一期別（與網格完全吻合）會被擋住重建，而 Ragic 同步／去重
  // 殘留的大範圍或位移隱藏列（不對齊任何單期網格）不會誤擋正常期別產生。
  const hiddenPeriods = hiddenRaw
  let storedIndex = 0
  dedupedStored.forEach((p) => {
    const paidAmt = p.paidAmount || 0
    storedIndex += 1
    rows.push({
      id: p.id,
      index: storedIndex,
      label: `${ymd(p.periodStart)}~${ymd(p.periodEnd)}`,
      periodStart: p.periodStart,
      periodEnd: p.periodEnd,
      amount: p.amount,
      dueDate: p.dueDate,
      paidAmount: paidAmt,
      paidDate: p.paidDate,
      payMethod: p.payMethod,
      receiptUrl: p.receiptUrl,
      note: p.note,
      settled: !!p.settled,
      locked: paidAmt > 0,   // 只有已繳才鎖定；未繳覆寫仍可編輯
      // 差額永遠顯示「應繳 - 實收」；已收款但有折讓時仍可看出差額。
      unpaid: Math.max(0, (p.amount || 0) - paidAmt),
    })
  })

  // ── 產生尚未儲存的期別：自租約起日逐期推進到迄日，與已儲存期別「實質重疊」者略過
  //    （已儲存為準）。舊版只把產生期別接在最後一筆之後，導致開頭若缺一期（例如首期
  //    只記在收支明細、未建立租金期別，或因日期位移被去重）就永遠補不回來；改為全期間
  //    掃描後，開頭／中間／結尾任何缺漏的期別都能補齊。 ──
  // 允許 ≤2 天的日期位移（時區／來回換算），但遠小於一期的寬度，故不會誤判大範圍同步列。
  const genCloseDay = (a, b) => a && b && Math.abs(startOfDay(a).getTime() - startOfDay(b).getTime()) <= 2 * 86400000
  const genOverlapsStored = (s, e) =>
    dedupedStored.some(p => dateTime(p.periodStart) < e.getTime() && s.getTime() < dateTime(p.periodEnd)) ||
    hiddenPeriods.some(h => genCloseDay(h.periodStart, s) && genCloseDay(h.periodEnd, e))
  let periodStart = new Date(start)
  let guard = 0
  while (!opts.skipGenerated && periodStart <= leaseEnd && guard < 120) {
    guard += 1
    const nextStart = addMonths(periodStart, months)
    const periodEnd = new Date(Math.min(nextStart.getTime() - 86400000, leaseEnd.getTime()))
    if (!genOverlapsStored(periodStart, periodEnd)) {
      // 預設應繳日期：期別起始日前 3 天（CONTRACT_START 模式維持＝期別起始日）
      const due = lease.paymentDueMode === 'CONTRACT_START'
        ? new Date(periodStart)
        : new Date(periodStart.getTime() - 3 * 86400000)
      const amount = effectiveRent(lease) * months
      rows.push({
        id: null,
        index: 0,
        label: `${ymd(periodStart)}~${ymd(periodEnd)}`,
        periodStart: new Date(periodStart),
        periodEnd,
        amount,
        dueDate: due,
        paidAmount: 0,
        paidDate: null,
        payMethod: null,
        receiptUrl: null,
        note: opts.generatedNote || null,
        locked: false,
        unpaid: amount,
      })
    }
    periodStart = nextStart
  }

  // 依期別起日排序並重新編號，補齊的開頭期別才能正確排到最前面（期別 1）
  rows.sort((a, b) => dateTime(a.periodStart) - dateTime(b.periodStart))
  rows.forEach((r, i) => { r.index = i + 1 })
  return rows
}

// 待繳費清單計算（後台 managed-pending 與 KAZU 對帳共用）。
// 待繳費清單以「款項是否已繳」為準，不因合約到期、被標記終止或已結算就消失：
// 只要還有未繳的租金期別或水電費，就持續列出（已結算合約也一樣要顯示欠款）。
// 已結算合約：只列「實際已登記卻未繳」的期別（skipGenerated），不自動產生推測期別——
// 否則合約結清後，排程仍會補出從未開立的期別，讓已結算合約誤顯示為有欠款。
// 回傳 { rent, util }，各項除原有欄位外附 _ref（供 KAZU 路由組 itemId，後台路由會剝除）。
function buildPendingItems(leases, rentPayments, readings, now = new Date()) {
  const leaseById = {}; leases.forEach(l => { leaseById[l.id] = l })
  const rpByLease = {}
  rentPayments.forEach(rp => { (rpByLease[rp.leaseId] = rpByLease[rp.leaseId] || []).push(rp) })

  const today = startOfDay(now)
  const dayDiff = (d) => Math.round((startOfDay(d).getTime() - today.getTime()) / 86400000)
  const meta = (l) => ({
    leaseId: l.id,
    tenantName: l.tenantName,
    roomLabel: l.roomLabel,
    managedTitle: l.managedProperty ? l.managedProperty.title : '未連結物業',
    ownerName: l.managedProperty ? l.managedProperty.ownerName : '（未填房東）',
    // 合約是否已到期／已被標記終止（仍列在待繳，供前端標記提醒）
    inactive: l.status !== 'ACTIVE' || !!(l.leaseEnd && new Date(l.leaseEnd) < now),
    // 已結算（供前端標示「已結算·仍有欠款」）
    settled: !!l.settledAt,
  })

  const rent = []
  for (const l of leases) {
    let sched = []
    const opts = l.settledAt ? { skipGenerated: true } : {}
    try { sched = buildRentSchedule(l, rpByLease[l.id] || [], opts) } catch (e) { continue }
    sched.forEach(r => {
      if ((r.unpaid || 0) > 0 && r.dueDate) {
        rent.push({
          ...meta(l), dueDate: r.dueDate, amount: r.unpaid, daysUntil: dayDiff(r.dueDate),
          _ref: { row: r, parking: isParkingRentPayment(r) },
        })
      }
    })
  }
  const util = []
  readings.forEach(rd => {
    const unpaid = Math.max(0, (rd.amount || 0) - (rd.paidAmount || 0))
    if (unpaid <= 0) return
    const l = leaseById[rd.leaseId]; if (!l) return
    const due = rd.dueDate || rd.endDate
    if (!due) return
    util.push({ ...meta(l), dueDate: due, amount: unpaid, daysUntil: dayDiff(due), note: rd.note || '', _ref: { reading: rd } })
  })
  rent.sort((a, b) => new Date(a.dueDate) - new Date(b.dueDate))
  util.sort((a, b) => new Date(a.dueDate) - new Date(b.dueDate))
  return { rent, util }
}

module.exports = {
  HIDDEN_RENT_PAYMENT_NOTE,
  addMonths,
  cycleMonths,
  ymd,
  startOfDay,
  dateTime,
  effectiveRent,
  isHiddenRentPayment,
  isParkingRentPayment,
  isPaidRentPayment,
  isValidRentPeriod,
  rentPeriodsOverlap,
  rentPeriodDuration,
  buildRentSchedule,
  buildPendingItems,
}
