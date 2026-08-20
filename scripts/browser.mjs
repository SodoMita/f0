// Launch a browser for the render checks. Order:
//  1. `playwright` (project devDep) — normal path on a dev machine that has
//     `npx playwright install chromium`.
//  2. local `@sparticuz/chromium` — sandbox fallback (Lambda chromium build):
//     no official playwright download needed; set VCOLOR_LD_LIBRARY_PATH if
//     its NSS shared-library deps live in a non-default dir. Defaults cover
//     both known extractions: /tmp/chromium-libs/lib (the libs shipped inside
//     the package as bin/al2023.tar.br — 30-second path) and /tmp/nsslibs
//     (hand-built NSPR/NSS from the long path). See docs/SANDBOX-VERIFY.md
//     (2026-08-20 section) for the full sandbox recipe.
const msg = (e) => String((e && e.message) || e).split('\n')[0].slice(0, 160)

export async function launchFormBrowser(headless = true) {
  const extraArgs = ['--no-sandbox', '--disable-dev-shm-usage', '--enable-unsafe-swiftshader']
  let playwrightErr = null
  try {
    const mod = await import('playwright')
    const chromium = mod.chromium ?? mod.default?.chromium
    return await chromium.launch({ headless, args: ['--use-angle=swiftshader', ...extraArgs] })
  } catch (err) {
    playwrightErr = err
  }
  try {
    const sp = (await import('@sparticuz/chromium')).default ?? (await import('@sparticuz/chromium'))
    const pwc = await import('playwright-core')
    const env = { ...process.env }
    if (process.env.VCOLOR_LD_LIBRARY_PATH) env.LD_LIBRARY_PATH = process.env.VCOLOR_LD_LIBRARY_PATH
    else if (!env.LD_LIBRARY_PATH) env.LD_LIBRARY_PATH = '/tmp/chromium-libs/lib:/tmp/nsslibs'
    const execPath = await sp.executablePath()
    return await pwc.chromium.launch({
      executablePath: execPath,
      headless,
      args: [...sp.args, '--use-angle=swiftshader-webgl', ...extraArgs],
      env,
    })
  } catch (err) {
    throw new Error(
      'No browser for the render checks. Run `npx playwright install chromium` ' +
      `(sandbox fallback: npm i @sparticuz/chromium). playwright: ${msg(playwrightErr)} | fallback: ${msg(err)}`,
    )
  }
}
