// 往下拉重新整理（僅 iPhone 主畫面 App / standalone 模式啟用）
(function () {
  var standalone = window.navigator.standalone === true ||
    (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches)
  if (!standalone) return

  var THRESHOLD = 70
  var link = document.createElement('link')
  link.rel = 'stylesheet'
  link.href = '/admin/assets/ptr.css?v=1'
  document.head.appendChild(link)

  var pill = document.createElement('div')
  pill.className = 'ptr-pill'
  var icon = document.createElement('span')
  icon.className = 'ptr-icon'
  icon.textContent = '↻'
  var label = document.createElement('span')
  label.textContent = '下拉重新整理'
  pill.appendChild(icon)
  pill.appendChild(label)
  document.body.appendChild(pill)

  var startY = 0
  var active = false
  var pulled = 0

  function blocked(target) {
    if (window.scrollY > 0) return true
    var de = document.documentElement
    var b = document.body
    if (getComputedStyle(de).overflow === 'hidden' || getComputedStyle(b).overflow === 'hidden') return true
    if (target && target.closest && target.closest('input, textarea, select, [contenteditable]')) return true
    for (var el = target; el && el.nodeType === 1; el = el.parentElement) {
      if (el.scrollTop > 0) return true
      if (getComputedStyle(el).position === 'fixed') return true
    }
    return false
  }

  function show(dy) {
    var y = Math.min(dy, THRESHOLD * 1.5) * 0.6 - 40
    pill.style.opacity = '1'
    pill.style.transform = 'translate(-50%, ' + y + 'px)'
    var ready = dy > THRESHOLD
    pill.classList.toggle('ptr-ready', ready)
    label.textContent = ready ? '放開重新整理' : '下拉重新整理'
  }

  function hide() {
    pill.classList.add('ptr-anim')
    pill.style.opacity = '0'
    pill.style.transform = 'translate(-50%, -60px)'
  }

  document.addEventListener('touchstart', function (e) {
    active = false
    pulled = 0
    if (e.touches.length !== 1 || blocked(e.target)) return
    startY = e.touches[0].clientY
    active = true
    pill.classList.remove('ptr-anim')
  }, { passive: true })

  document.addEventListener('touchmove', function (e) {
    if (!active) return
    if (e.touches.length !== 1 || window.scrollY > 0) {
      active = false
      pulled = 0
      hide()
      return
    }
    pulled = e.touches[0].clientY - startY
    if (pulled > 10) show(pulled)
    else if (pulled <= 0) hide()
  }, { passive: true })

  document.addEventListener('touchend', function () {
    if (!active) return
    active = false
    if (pulled > THRESHOLD) {
      label.textContent = '重新整理中…'
      location.reload()
    } else {
      hide()
    }
  }, { passive: true })

  document.addEventListener('touchcancel', function () {
    active = false
    hide()
  }, { passive: true })
})()
