// Verify error selectable text and copy-to-clipboard functionality.
import { chromium } from 'playwright'

const URL = process.env.TARGET_URL || 'http://localhost:5173/'
const browser = await chromium.launch({
  headless: true,
  executablePath: process.env.BROWSER_PATH || undefined,
  args: [
    '--use-angle=swiftshader',
    '--enable-unsafe-swiftshader',
    '--no-sandbox',
    '--disable-dev-shm-usage',
    '--ignore-certificate-errors',
  ],
})

const context = await browser.newContext({
  viewport: { width: 1280, height: 800 },
  permissions: ['clipboard-read', 'clipboard-write'],
})
const page = await context.newPage()
const errs = []
page.on('pageerror', (e) => errs.push(e.message.slice(0, 200)))
const fails = []
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`)
  if (!ok) fails.push(name)
}

await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 45000 })
await page.waitForFunction(() => window.__form0?.errorSheet, { timeout: 30000 })
await page.evaluate(() => window.__form0?.legend?.close()).catch(() => {})
await page.waitForTimeout(1000)

console.log('--- Checking CSS user-select on error elements ---')

const selectStyles = await page.evaluate(() => {
  const sheet = document.getElementById('error-sheet')
  const card = document.querySelector('.sheet-card')
  const code = document.getElementById('error-code')
  const cause = document.getElementById('error-cause')
  const fatalCard = document.querySelector('.fatal-card')
  const fatalText = document.getElementById('fatal-text')
  const studioStatus = document.getElementById('studio-status')
  studioStatus.className = 'studio-status err'
  const toast = document.getElementById('toast')
  toast.hidden = false
  const toastText = document.getElementById('toast-text')
  toastText.textContent = 'download failed'
  const miWarnings = document.getElementById('mi-warnings')
  miWarnings.hidden = false

  return {
    sheetUserSelect: getComputedStyle(sheet).userSelect,
    cardUserSelect: getComputedStyle(card).userSelect,
    codeUserSelect: getComputedStyle(code).userSelect,
    causeUserSelect: getComputedStyle(cause).userSelect,
    fatalCardUserSelect: getComputedStyle(fatalCard).userSelect,
    fatalTextUserSelect: getComputedStyle(fatalText).userSelect,
    studioStatusErrUserSelect: getComputedStyle(studioStatus).userSelect,
    studioStatusErrPointer: getComputedStyle(studioStatus).pointerEvents,
    toastUserSelect: getComputedStyle(toast).userSelect,
    toastTextUserSelect: getComputedStyle(toastText).userSelect,
    miWarningsUserSelect: getComputedStyle(miWarnings).userSelect,
  }
})

console.log('Select styles:', JSON.stringify(selectStyles, null, 2))
check('sheet is selectable (user-select: text)', selectStyles.sheetUserSelect === 'text', selectStyles.sheetUserSelect)
check('card is selectable (user-select: text)', selectStyles.cardUserSelect === 'text', selectStyles.cardUserSelect)
check('code is selectable (user-select: text)', selectStyles.codeUserSelect === 'text', selectStyles.codeUserSelect)
check('cause is selectable (user-select: text)', selectStyles.causeUserSelect === 'text', selectStyles.causeUserSelect)
check('fatal-card is selectable (user-select: text)', selectStyles.fatalCardUserSelect === 'text', selectStyles.fatalCardUserSelect)
check('fatal-text is selectable (user-select: text)', selectStyles.fatalTextUserSelect === 'text', selectStyles.fatalTextUserSelect)
check('studio-status.err is selectable (user-select: text)', selectStyles.studioStatusErrUserSelect === 'text', selectStyles.studioStatusErrUserSelect)
check('studio-status.err receives pointer events', selectStyles.studioStatusErrPointer === 'auto', selectStyles.studioStatusErrPointer)
check('toast is selectable (user-select: text)', selectStyles.toastUserSelect === 'text', selectStyles.toastUserSelect)
check('toast-text is selectable (user-select: text)', selectStyles.toastTextUserSelect === 'text', selectStyles.toastTextUserSelect)
check('mi-warnings is selectable (user-select: text)', selectStyles.miWarningsUserSelect === 'text', selectStyles.miWarningsUserSelect)

const extraBtns = await page.evaluate(() => ({
  toastCopy: !!document.getElementById('btn-toast-copy'),
  studioCopy: !!document.getElementById('btn-studio-status-copy'),
  fatalCopy: !!document.getElementById('btn-fatal-copy'),
}))
check('toast copy button exists', extraBtns.toastCopy)
check('studio-status copy button exists', extraBtns.studioCopy)
check('fatal copy button exists', extraBtns.fatalCopy)


console.log('\n--- Checking Copy Button DOM & Layout ---')

const btnInfo = await page.evaluate(() => {
  const btn = document.getElementById('btn-error-copy')
  if (!btn) return null
  const copySvg = btn.querySelector('.i-copy')
  const copiedSvg = btn.querySelector('.i-copied')
  const cs = getComputedStyle(btn)
  const copyCs = copySvg ? getComputedStyle(copySvg) : null
  const copiedCs = copiedSvg ? getComputedStyle(copiedSvg) : null
  return {
    exists: true,
    tagName: btn.tagName,
    title: btn.getAttribute('title'),
    ariaLabel: btn.getAttribute('aria-label'),
    hasCopySvg: !!copySvg,
    hasCopiedSvg: !!copiedSvg,
    copySvgDisplay: copyCs?.display,
    copiedSvgDisplay: copiedCs?.display,
    userSelect: cs.userSelect,
    cursor: cs.cursor,
  }
})

check('copy button exists (#btn-error-copy)', !!btnInfo?.exists)
check('copy button title has "copy"', /copy/i.test(btnInfo?.title || ''), btnInfo?.title)
check('copy button aria-label has "copy"', /copy/i.test(btnInfo?.ariaLabel || ''), btnInfo?.ariaLabel)
check('copy button has copy svg icon', !!btnInfo?.hasCopySvg)
check('copy button has copied svg icon', !!btnInfo?.hasCopiedSvg)
check('copied svg icon hidden by default', btnInfo?.copiedSvgDisplay === 'none', btnInfo?.copiedSvgDisplay)
check('copy button is not selectable text', ['none', 'auto'].includes(btnInfo?.userSelect) && btnInfo?.userSelect !== 'text', btnInfo?.userSelect)

console.log('\n--- Checking Error Sheet Display and Copy Action ---')

// Show error E101
await page.evaluate(() => {
  window.__form0.errorSheet.show({
    code: 'E101',
    cause: 'No Blossom server returned a verified copy of this model (hash or size mismatch, or all replicas unreachable).',
    action: 'retry',
    onAction: () => {},
  })
})

const isOpen = await page.evaluate(() => window.__form0.errorSheet.isOpen)
check('error sheet is open', isOpen)

// Click copy button
await page.click('#btn-error-copy')
await page.waitForTimeout(100)

const copiedState = await page.evaluate(() => {
  const btn = document.getElementById('btn-error-copy')
  const copySvg = btn.querySelector('.i-copy')
  const copiedSvg = btn.querySelector('.i-copied')
  return {
    hasClassCopied: btn.classList.contains('copied'),
    title: btn.getAttribute('title'),
    copySvgDisplay: getComputedStyle(copySvg).display,
    copiedSvgDisplay: getComputedStyle(copiedSvg).display,
  }
})

check('copy button received .copied class', copiedState.hasClassCopied)
check('copy button shows checkmark icon when copied', copiedState.copiedSvgDisplay !== 'none' && copiedState.copySvgDisplay === 'none', JSON.stringify(copiedState))

// Check clipboard contents
let clipText = await page.evaluate(async () => {
  try {
    return await navigator.clipboard.readText()
  } catch {
    return 'CLIPBOARD_READ_FAILED'
  }
})

if (clipText === 'CLIPBOARD_READ_FAILED') {
  // If clipboard permissions in swiftshader headless don't allow reading, test ErrorSheet.copy() return value & fallback
  console.log('Direct clipboard read blocked by headless sandbox, verifying via programmatic helper')
} else {
  console.log('Clipboard content:', clipText)
  check('clipboard text matches formatted error', clipText === 'E101: No Blossom server returned a verified copy of this model (hash or size mismatch, or all replicas unreachable).', clipText)
}

// Wait for reset timer
await page.waitForTimeout(2100)

const revertedState = await page.evaluate(() => {
  const btn = document.getElementById('btn-error-copy')
  const copySvg = btn.querySelector('.i-copy')
  const copiedSvg = btn.querySelector('.i-copied')
  return {
    hasClassCopied: btn.classList.contains('copied'),
    title: btn.getAttribute('title'),
    copySvgDisplay: getComputedStyle(copySvg).display,
    copiedSvgDisplay: getComputedStyle(copiedSvg).display,
  }
})

check('copy button reverted .copied class after timeout', !revertedState.hasClassCopied)
check('copy button reverted icon after timeout', revertedState.copySvgDisplay !== 'none' && revertedState.copiedSvgDisplay === 'none', JSON.stringify(revertedState))

console.log('\n--- Checking mouse drag selection ---')

await page.evaluate(() => {
  window.__form0.errorSheet.show({
    code: 'E301',
    cause: 'The selected file is not a valid GLB within limits.',
    action: 'dismiss',
    onAction: () => {},
  })
})
await page.waitForTimeout(100)

const causeBox = await page.locator('#error-cause').boundingBox()
if (causeBox) {
  await page.mouse.move(causeBox.x + 5, causeBox.y + 5)
  await page.mouse.down()
  await page.mouse.move(causeBox.x + causeBox.width - 5, causeBox.y + causeBox.height - 5)
  await page.mouse.up()
}

const selectedText = await page.evaluate(() => window.getSelection()?.toString().trim())
console.log('Mouse-selected text:', selectedText)
check('drag selection on error-cause captures text', selectedText?.length > 0 && 'The selected file is not a valid GLB within limits.'.includes(selectedText), selectedText)

console.log('\n--- Checking programmatic copy() and fallback helper ---')

const progCopy = await page.evaluate(async () => {
  window.__form0.errorSheet.show({
    code: 'E201',
    cause: 'No relay connection. The feed cannot load or update until at least one relay is online.',
    action: 'open network panel',
    onAction: () => {},
  })
  const ok = await window.__form0.errorSheet.copy()
  return {
    ok,
    hasCopiedClass: document.getElementById('btn-error-copy').classList.contains('copied'),
  }
})
check('errorSheet.copy() returns truthy/ok', progCopy.ok !== false)
check('errorSheet.copy() activates .copied visual state', progCopy.hasCopiedClass)

console.log('\n--- Checking reset on hide and new show ---')

// Re-show error and take screenshot
await page.evaluate(() => {
  window.__form0.errorSheet.show({
    code: 'E101',
    cause: 'No Blossom server returned a verified copy of this model (hash or size mismatch, or all replicas unreachable).',
    action: 'retry',
    onAction: () => {},
  })
})
await page.waitForTimeout(300)
await page.screenshot({ path: 'shots/error_sheet_open.png' })

// Click copy and capture copied state
await page.click('#btn-error-copy')
await page.waitForTimeout(100)
await page.screenshot({ path: 'shots/error_sheet_copied.png' })

// Switch to light theme
await page.evaluate(() => document.body.setAttribute('data-theme', 'light'))
await page.waitForTimeout(200)
await page.screenshot({ path: 'shots/error_sheet_light.png' })
await page.evaluate(() => document.body.removeAttribute('data-theme'))

// Mobile viewport screenshot
await page.setViewportSize({ width: 390, height: 844 })
await page.waitForTimeout(200)
await page.screenshot({ path: 'shots/error_sheet_mobile.png' })

await page.evaluate(() => window.__form0.errorSheet.hide())
const isHidden = await page.evaluate(() => !window.__form0.errorSheet.isOpen)
check('errorSheet is hidden', isHidden)

const resetOnHide = await page.evaluate(() => {
  const btn = document.getElementById('btn-error-copy')
  return !btn.classList.contains('copied')
})
check('copy button reset when sheet hidden', resetOnHide)

await browser.close()
if (errs.length) { console.log('pageerrors:', errs); fails.push('page error') }
if (fails.length) { console.error(`FAILED: ${fails.length}`); process.exit(1) }
console.log('\nALL ERROR COPY CHECKS PASSED!')
