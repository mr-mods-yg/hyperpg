import { expect, test } from '@playwright/test'

const postgresFixture = `
const connection = { id: 'test', name: 'Test', host: 'localhost', database: 'test', username: 'test', showAllDatabases: false };
window.sqlTestState = { calls: [], refreshes: 0 };
export async function ListSavedConnections() { return [connection]; }
export async function OpenSavedConnection() { return connection; }
export async function ListDatabases() { return ['test']; }
export async function OpenDatabase() { return 'test'; }
export async function ListTables() { window.sqlTestState.refreshes++; return []; }
export async function GetSchemaCompletions() { return [{ schema: 'public', table: 'customers', columns: ['customer_name'] }]; }
export async function ExecuteSQLScript(id, script) {
 window.sqlTestState.calls.push({ id, script });
 return { results: [{ columns: ['value'], rows: [['hello'], [null]], command: 'SELECT 2', truncated: false }], error: '', rolledBack: false };
}
`

test('runs scripts, displays results, and keeps the draft', async ({ page }) => {
  await page.route('**/bindings/changeme/internal/database/postgresservice.*', route => route.fulfill({ contentType: 'text/javascript', body: postgresFixture }))
  await page.route('**/bindings/changeme/internal/updates/updateservice.*', route => route.fulfill({ contentType: 'text/javascript', body: 'export async function CheckForUpdates() { return { available: false, version: "dev", releaseUrl: "" } }' }))
  await page.goto('/')
  await page.getByRole('button', { name: 'New SQL script' }).click()
  const editor = page.getByRole('textbox', { name: 'SQL script' })
  await editor.fill("SELECT 'hello';")
  await expect(editor).toHaveText("SELECT 'hello';")
  await page.getByRole('button', { name: 'Run script' }).click()
  await expect(page.getByText('SELECT 2')).toBeVisible()
  await expect(page.getByRole('cell', { name: 'hello' })).toBeVisible()
  await expect(page.getByRole('cell', { name: 'NULL' })).toBeVisible()
  const originalEditorBounds = await page.locator('.sql-editor:visible').boundingBox()
  await page.getByRole('button', { name: 'Expand results' }).click()
  await expect(page.getByRole('button', { name: 'Restore editor' })).toHaveAttribute('aria-expanded', 'true')
  expect(await page.locator('.sql-editor').boundingBox()).toEqual(originalEditorBounds)
  expect(await page.locator('.sql-editor').evaluate((element) => {
    const rect = element.getBoundingClientRect()
    return document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2)?.closest('.sql-results') !== null
  })).toBe(true)
  await expect(editor).toBeHidden()
  await expect(page.getByRole('cell', { name: 'hello' })).toBeVisible()
  await page.getByRole('button', { name: 'Restore editor' }).click()
  await expect(editor).toBeVisible()
  expect(await page.locator('.sql-editor:visible').boundingBox()).toEqual(originalEditorBounds)
  await page.getByRole('button', { name: 'Expand results' }).click()
  expect(await page.locator('.sql-source').evaluate((element) => (element as HTMLElement).inert)).toBe(true)
  await page.getByRole('button', { name: 'Copy CSV' }).focus()
  await page.keyboard.press('Escape')
  await expect(editor).toBeVisible()
  await expect(page.getByRole('button', { name: 'Expand results' })).toBeFocused()
  expect(await page.locator('.sql-source').evaluate((element) => (element as HTMLElement).inert)).toBe(false)
  await expect.poll(() => page.evaluate(() => (window as any).sqlTestState.calls)).toEqual([{ id: 'test', script: "SELECT 'hello';" }])
  await expect.poll(() => page.evaluate(() => (window as any).sqlTestState.refreshes)).toBeGreaterThan(1)
  await page.getByRole('button', { name: 'New SQL script' }).click()
  await expect(page.getByRole('textbox', { name: 'SQL script' })).toHaveText('')
  await page.getByRole('textbox', { name: 'SQL script' }).fill('SELECT 42;')
  await page.getByRole('tab', { name: 'Script 1', exact: true }).click()
  await expect(editor).toHaveText("SELECT 'hello';")
  await expect(page.getByText('SELECT 2')).toBeVisible()
  await page.getByRole('tab', { name: 'Script 2', exact: true }).click()
  await expect(page.getByRole('textbox', { name: 'SQL script' })).toHaveText('SELECT 42;')
  await page.getByRole('button', { name: 'Close Script 2' }).click()
  await page.getByRole('button', { name: 'Close script', exact: true }).click()
  await expect(editor).toHaveText("SELECT 'hello';")
  await editor.fill("SELECT 1;\nSELECT 2;")
  await editor.focus()
  await page.keyboard.press('End')
  await page.keyboard.press('Shift+Home')
  await expect(page.getByRole('button', { name: 'Run selection' })).toBeVisible()
  await page.getByRole('button', { name: 'Run selection' }).click()
  await expect.poll(() => page.evaluate(() => (window as any).sqlTestState.calls)).toEqual([
    { id: 'test', script: "SELECT 'hello';" }, { id: 'test', script: 'SELECT 2;' },
  ])
  await page.getByRole('button', { name: 'Copy CSV' }).click()
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe('value\r\nhello\r\n')
  await page.getByRole('button', { name: 'Clear', exact: true }).click()
  await expect(editor).toHaveText('')
  await expect(page.getByRole('button', { name: 'Run script' })).toBeDisabled()
})

test('configures shortcuts and applies them across settings and tabs', async ({ page }) => {
  await page.route('**/bindings/changeme/internal/database/postgresservice.*', route => route.fulfill({ contentType: 'text/javascript', body: postgresFixture }))
  await page.route('**/bindings/changeme/internal/updates/updateservice.*', route => route.fulfill({ contentType: 'text/javascript', body: 'export async function CheckForUpdates() { return { available: false, version: "dev", releaseUrl: "" } }' }))
  await page.goto('/')
  await page.getByRole('button', { name: 'Settings', exact: true }).click()
  await page.getByRole('button', { name: 'Keyboard shortcuts' }).click()
  await expect(page.getByRole('button', { name: 'Set shortcut for Refresh' })).toHaveText('F5')
  await expect(page.getByRole('button', { name: 'Set shortcut for Close tab' })).toHaveText('Ctrl+W')
  await page.getByRole('button', { name: 'Set shortcut for New SQL script' }).click()
  await page.keyboard.press('Control+w')
  await expect(page.getByRole('alert')).toContainText('Close tab')
  await page.keyboard.press('Control+Shift+n')
  await expect(page.getByRole('button', { name: 'Set shortcut for New SQL script' })).toHaveText('Ctrl+Shift+N')
  await page.getByRole('button', { name: 'Close settings' }).click()
  await page.keyboard.press('Control+Shift+n')
  await expect(page.getByRole('tab', { name: 'Script 1', exact: true })).toBeVisible()
  await page.keyboard.press('Control+w')
  await expect(page.getByRole('tab', { name: 'Script 1', exact: true })).toHaveCount(0)
  const before = await page.evaluate(() => (window as any).sqlTestState.refreshes)
  await page.keyboard.press('F5')
  await expect.poll(() => page.evaluate(() => (window as any).sqlTestState.refreshes)).toBeGreaterThan(before)
  await page.reload()
  await page.getByRole('button', { name: 'Settings', exact: true }).click()
  await page.getByRole('button', { name: 'Keyboard shortcuts' }).click()
  await expect(page.getByRole('button', { name: 'Set shortcut for New SQL script' })).toHaveText('Ctrl+Shift+N')
})

test('background SQL completion preserves unsaved table edits', async ({ page }) => {
  const fixture = postgresFixture.replace('return [];', "return [{ schema: 'public', name: 'items' }];").replace(" window.sqlTestState.calls.push({ id, script });", " await new Promise(resolve => { window.finishSQL = resolve });\n window.sqlTestState.calls.push({ id, script });") + `
export async function GetTableData() { return { columns: [{ name: 'value', dataType: 'text', nullable: true }], rows: [['original']], rowCount: 1, identities: [{ tableOID: '1', ctid: '(0,1)', version: '1' }] }; }
`
  await page.route('**/bindings/changeme/internal/database/postgresservice.*', route => route.fulfill({ contentType: 'text/javascript', body: fixture }))
  await page.route('**/bindings/changeme/internal/updates/updateservice.*', route => route.fulfill({ contentType: 'text/javascript', body: 'export async function CheckForUpdates() { return { available: false } }' }))
  await page.goto('/')
  await page.getByRole('button', { name: 'New SQL script' }).click()
  await page.getByRole('textbox', { name: 'SQL script' }).fill('SELECT 1;')
  await page.getByRole('button', { name: 'Run script' }).click()
  await expect(page.getByRole('button', { name: 'Close Script 1' })).toBeDisabled()
  await page.getByRole('button', { name: 'Open items table', exact: true }).click()
  await page.locator('[data-cell="0:0"]').dblclick()
  await page.getByRole('textbox', { name: 'Edit value', exact: true }).fill('draft')
  await page.keyboard.press('Enter')
  await page.evaluate(() => (window as any).finishSQL())
  await expect(page.getByRole('button', { name: 'Close Script 1' })).toBeEnabled()
  await expect(page.locator('[data-cell="0:0"]')).toHaveText('draft')
  await page.getByRole('tab', { name: 'Script 1', exact: true }).click()
  await expect(page.getByRole('dialog', { name: 'Unsaved changes' })).toBeVisible()
})


test('formats SQL, completes schema names, and runs the statement at the cursor', async ({ page }) => {
  await page.route('**/bindings/changeme/internal/database/postgresservice.*', route => route.fulfill({ contentType: 'text/javascript', body: postgresFixture }))
  await page.route('**/bindings/changeme/internal/updates/updateservice.*', route => route.fulfill({ contentType: 'text/javascript', body: 'export async function CheckForUpdates() { return { available: false } }' }))
  await page.goto('/')
  await page.getByRole('button', { name: 'New SQL script' }).click()
  const editor = page.getByRole('textbox', { name: 'SQL script' })
  await editor.fill('select 1; select 2;')
  await page.getByRole('button', { name: 'Format', exact: true }).click()
  await expect(editor).toContainText('SELECT')
  await editor.fill("select 'a;b'; select 2;")
  await editor.focus()
  await page.keyboard.press('Control+Home')
  await page.getByRole('button', { name: 'Run statement' }).click()
  await expect.poll(() => page.evaluate(() => (window as any).sqlTestState.calls)).toEqual([{ id: 'test', script: "select 'a;b';" }])
  await editor.fill('select * from cust')
  await editor.focus()
  await page.keyboard.press('End')
  await page.keyboard.press('Control+Space')
  await expect(page.locator('.cm-tooltip-autocomplete')).toContainText('customers')
})

for (const theme of ['light', 'dark', 'cream', 'discord']) {
  test(`SQL controls stay aligned and readable in the ${theme} theme`, async ({ page }) => {
    await page.addInitScript((theme) => localStorage.setItem('hyperpg-theme', theme), theme)
    await page.route('**/bindings/changeme/internal/database/postgresservice.*', route => route.fulfill({ contentType: 'text/javascript', body: postgresFixture }))
    await page.route('**/bindings/changeme/internal/updates/updateservice.*', route => route.fulfill({ contentType: 'text/javascript', body: 'export async function CheckForUpdates() { return { available: false } }' }))
    await page.goto('/')
    await page.getByRole('button', { name: 'New SQL script' }).click()
    const run = page.getByRole('button', { name: 'Run script', exact: true })
    await expect(run).toBeDisabled()
    await page.getByRole('textbox', { name: 'SQL script' }).fill('SELECT 1;')
    await expect(run).toBeEnabled()
    await run.focus()
    await page.keyboard.press('Shift+Tab')
    await expect(page.getByRole('button', { name: 'Run statement' })).toBeFocused()
    await expect(page.getByRole('button', { name: 'Run statement' })).toHaveCSS('outline-style', 'solid')
    await run.click()
    await expect(page.getByRole('cell', { name: 'hello' })).toBeVisible()

    const controls = page.locator('.topbar-right button:visible, .script-file-actions button:visible, .sql-actions button:visible, .sql-result-actions button:visible, .export-menu summary:visible')
    const styles = await controls.evaluateAll((elements) => elements.map((element) => {
      const style = getComputedStyle(element)
      return { height: element.getBoundingClientRect().height, fontSize: style.fontSize, radius: style.borderRadius }
    }))
    expect(styles.length).toBeGreaterThan(10)
    for (const style of styles) expect(style).toEqual({ height: 32, fontSize: '12px', radius: '6px' })

    const contrast = await run.evaluate((element) => {
      const style = getComputedStyle(element)
      const workspace = getComputedStyle(document.querySelector('.sql-workspace')!)
      const surface = getComputedStyle(document.documentElement).getPropertyValue('--paper').trim()
      const canvas = document.createElement('canvas').getContext('2d')!
      function rgb(color: string) {
        canvas.fillStyle = color
        canvas.fillRect(0, 0, 1, 1)
        return Array.from(canvas.getImageData(0, 0, 1, 1).data).slice(0, 3)
      }
      // Composite translucent theme colors over the workspace surface.
      canvas.fillStyle = surface
      canvas.fillRect(0, 0, 1, 1)
      const background = rgb(style.backgroundColor)
      canvas.clearRect(0, 0, 1, 1)
      const foreground = rgb(style.color || workspace.color)
      function luminance(values: number[]) {
        return values.map(value => value / 255).map(value => value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4).reduce((sum, value, i) => sum + value * [.2126, .7152, .0722][i], 0)
      }
      const [low, high] = [luminance(background), luminance(foreground)].sort((a, b) => a - b)
      return (high + .05) / (low + .05)
    })
    expect(contrast).toBeGreaterThanOrEqual(4.5)

    for (const width of [900, 560, 390]) {
      await page.setViewportSize({ width, height: 900 })
      const overflowing = await controls.evaluateAll((elements) => elements.filter((element) => {
        const rect = element.getBoundingClientRect()
        return rect.left < 0 || rect.right > window.innerWidth
      }).map((element) => element.textContent))
      expect(overflowing).toEqual([])
    }
  })
}

test('tabs and settings respect the largest font size on narrow screens', async ({ page }, testInfo) => {
  await page.addInitScript(() => localStorage.setItem('hyperpg-font-size-px', '18'))
  await page.route('**/bindings/changeme/internal/database/postgresservice.*', route => route.fulfill({ contentType: 'text/javascript', body: postgresFixture }))
  await page.route('**/bindings/changeme/internal/updates/updateservice.*', route => route.fulfill({ contentType: 'text/javascript', body: 'export async function CheckForUpdates() { return { available: false } }' }))
  await page.goto('/')
  await page.getByRole('button', { name: 'New SQL script' }).click()
  await expect(page.getByRole('tab', { name: 'Script 1', exact: true })).toHaveCSS('font-size', '18px')
  expect((await page.locator('.editor-tab').boundingBox())!.height).toBeGreaterThanOrEqual(54)
  await page.getByRole('button', { name: 'Settings', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Settings', exact: true })).toHaveCSS('font-size', '30px')
  await expect(page.locator('label[for="font-size-control"]')).toHaveCSS('font-size', '21px')
  await page.getByRole('button', { name: 'Keyboard shortcuts', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Keyboard shortcuts' })).toHaveCSS('font-size', '21px')
  await page.setViewportSize({ width: 390, height: 700 })
  expect(await page.locator('.settings-content').evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true)
  await page.screenshot({ path: testInfo.outputPath('large-font-settings.png') })
  await page.getByRole('button', { name: 'Close settings' }).click()
  await expect(page.getByRole('tab', { name: 'Script 1', exact: true })).toBeVisible()
})

test('short SQL workspace shows useful panes and expanded results survive scrolling', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 600 })
  await page.addInitScript(() => localStorage.setItem('hyperpg-font-size-px', '18'))
  await page.route('**/bindings/changeme/internal/database/postgresservice.*', route => route.fulfill({ contentType: 'text/javascript', body: postgresFixture }))
  await page.route('**/bindings/changeme/internal/updates/updateservice.*', route => route.fulfill({ contentType: 'text/javascript', body: 'export async function CheckForUpdates() { return { available: false } }' }))
  await page.goto('/')
  await page.getByRole('button', { name: 'New SQL script' }).click()
  const editor = page.getByRole('textbox', { name: 'SQL script' })
  await editor.fill('SELECT 1;')
  await page.getByRole('button', { name: 'Run script', exact: true }).click()
  await expect(page.locator('.sql-heading').getByText('test', { exact: true })).toBeVisible()
  const editorBox = (await page.locator('.sql-editor').boundingBox())!
  expect(editorBox.height).toBeGreaterThanOrEqual(120)
  expect(editorBox.y + editorBox.height).toBeLessThan(600)
  const expand = page.getByRole('button', { name: 'Expand results' })
  const bounds = (await expand.boundingBox())!
  expect(bounds.y + bounds.height).toBeLessThanOrEqual(600)
  const workspace = page.locator('.sql-workspace')
  expect(await workspace.evaluate(element => element.scrollTop)).toBe(0)
  for (const scrolled of [false, true]) {
    if (scrolled) {
      await workspace.evaluate(element => { element.scrollTop = 60 })
      expect(await workspace.evaluate(element => element.scrollTop)).toBeGreaterThan(0)
      await expand.evaluate(button => button.addEventListener('click', () => { (window as any).scrollAtExpansion = document.querySelector('.sql-workspace')!.scrollTop }, { once: true }))
    }
    await expand.click()
    if (scrolled) expect(await page.evaluate(() => (window as any).scrollAtExpansion)).toBeGreaterThan(0)
    expect(await page.locator('.sql-source').evaluate(element => (element as HTMLElement).inert)).toBe(true)
    const restore = page.getByRole('button', { name: 'Restore editor' })
    await expect(page.locator('.sql-results')).toHaveCSS('font-size', '18px')
    await expect(restore).toBeFocused()
    for (const item of [restore, page.getByRole('cell', { name: 'hello' })]) {
      await expect.poll(() => item.evaluate(element => { const rect = element.getBoundingClientRect(); return rect.top >= 0 && rect.bottom <= innerHeight && element.contains(document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2)) })).toBe(true)
    }
    await page.locator('.sql-results .export-menu summary').click()
    await expect(page.getByLabel('Export format')).toBeVisible()
    await expect(page.getByRole('button', { name: 'Save file' })).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(page.getByLabel('Export format')).toBeHidden()
    await page.keyboard.press('Escape')
    await expect(editor).toBeVisible()
    await expect(expand).toBeFocused()
    expect(await page.locator('.sql-source').evaluate(element => (element as HTMLElement).inert)).toBe(false)
  }
})

test('narrow action disclosures preserve keyboard focus and dismiss on outside focus', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 600 })
  await page.addInitScript(() => localStorage.setItem('hyperpg-font-size-px', '18'))
  await page.route('**/bindings/changeme/internal/database/postgresservice.*', route => route.fulfill({ contentType: 'text/javascript', body: postgresFixture }))
  await page.route('**/bindings/changeme/internal/updates/updateservice.*', route => route.fulfill({ contentType: 'text/javascript', body: 'export async function CheckForUpdates() { return { available: false } }' }))
  await page.goto('/')
  const workspace = page.getByRole('button', { name: 'Workspace actions' })
  const controls = [page.getByRole('button', { name: 'Open navigation' }), page.getByRole('button', { name: 'New SQL script' }), workspace]
  const rects = await Promise.all(controls.map(async control => {
    const rect = (await control.boundingBox())!
    expect(rect.x).toBeGreaterThanOrEqual(0)
    expect(rect.x + rect.width).toBeLessThanOrEqual(390)
    expect(await control.evaluate(element => { const r = element.getBoundingClientRect(); return element.contains(document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2)) })).toBe(true)
    return rect
  }))
  expect(rects[0].x + rects[0].width).toBeLessThanOrEqual(rects[1].x)
  expect(rects[1].x + rects[1].width).toBeLessThanOrEqual(rects[2].x)
  await workspace.focus()
  await page.keyboard.press('Enter')
  await page.keyboard.press('Tab')
  await expect(page.getByRole('button', { name: 'Open SQL' })).toBeFocused()
  await page.keyboard.press('Escape')
  await expect(workspace).toBeFocused()
  await workspace.click()
  await page.getByRole('button', { name: 'New SQL script' }).focus()
  await expect(workspace).toHaveAttribute('aria-expanded', 'false')
  await page.getByRole('button', { name: 'New SQL script' }).click()
  const editor = page.getByRole('textbox', { name: 'SQL script' })
  await editor.fill('select 1;')
  const actions = page.getByRole('button', { name: 'Editor actions' })
  await actions.click()
  await page.getByRole('button', { name: 'Format', exact: true }).click()
  await expect(actions).toBeFocused()
  await expect(actions).toHaveAttribute('aria-expanded', 'false')
  await actions.click()
  await page.getByRole('button', { name: 'Run statement' }).click()
  await expect(actions).toBeFocused()
  await actions.click()
  await page.getByRole('button', { name: 'Clear', exact: true }).click()
  await expect(editor).toBeFocused()
  await expect(actions).toHaveAttribute('aria-expanded', 'false')
})

test('opening app dialogs collapses expanded results without stealing dialog focus', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 600 })
  await page.addInitScript(() => localStorage.setItem('hyperpg-font-size-px', '18'))
  await page.route('**/bindings/changeme/internal/database/postgresservice.*', route => route.fulfill({ contentType: 'text/javascript', body: postgresFixture }))
  await page.route('**/bindings/changeme/internal/updates/updateservice.*', route => route.fulfill({ contentType: 'text/javascript', body: 'export async function CheckForUpdates() { return { available: false } }' }))
  await page.goto('/')
  await page.getByRole('button', { name: 'New SQL script' }).click()
  await page.getByRole('textbox', { name: 'SQL script' }).fill('SELECT 1;')
  await page.getByRole('button', { name: 'Run script' }).click()
  for (const [group, action, dialogName] of [
    ['Workspace actions', 'Query history', 'Query history'],
    ['Workspace actions', 'Add connection', 'New connection'],
    ['File options', 'Rename', 'Rename script'],
  ]) {
    await page.getByRole('button', { name: 'Expand results' }).click()
    await page.getByRole('button', { name: group }).click()
    await page.getByRole('button', { name: action, exact: true }).click()
    const dialog = page.getByRole('dialog', { name: dialogName })
    await expect(dialog).toBeVisible()
    await expect(page.locator('body > .sql-results.is-expanded')).toHaveCount(0)
    await expect.poll(() => dialog.evaluate(element => element.contains(document.activeElement))).toBe(true)
    await page.keyboard.press('Escape')
    await expect(dialog).toHaveCount(0)
    await expect(page.getByRole('button', { name: group })).toBeFocused()
    await page.getByRole('button', { name: 'Expand results' }).click()
    await page.getByRole('button', { name: group }).click()
    await page.getByRole('button', { name: action, exact: true }).click()
    await dialog.getByRole('button', { name: dialogName === 'Query history' ? 'Done' : 'Cancel', exact: true }).click()
    await expect(dialog).toHaveCount(0)
    await expect(page.getByRole('button', { name: group })).toBeFocused()
  }
})

test('mobile Settings closes its navigation and returns focus to its opener', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 600 })
  await page.addInitScript(() => localStorage.setItem('hyperpg-font-size-px', '18'))
  await page.route('**/bindings/changeme/internal/database/postgresservice.*', route => route.fulfill({ contentType: 'text/javascript', body: postgresFixture }))
  await page.route('**/bindings/changeme/internal/updates/updateservice.*', route => route.fulfill({ contentType: 'text/javascript', body: 'export async function CheckForUpdates() { return { available: false } }' }))
  await page.goto('/')
  const navigation = page.getByRole('button', { name: 'Open navigation' })
  await navigation.click()
  await page.getByRole('button', { name: 'Settings', exact: true }).click()
  const categories = page.getByRole('navigation', { name: 'Settings categories' })
  expect(await categories.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true)
  await categories.getByRole('button', { name: 'Updates', exact: true }).click()
  await expect(page.getByRole('radiogroup', { name: 'Update channel' })).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(navigation).toHaveAttribute('aria-expanded', 'false')
  await expect(navigation).toBeFocused()
})


for (const theme of ['light', 'dark']) {
  test(`${theme} mobile navigation contains keyboard focus and restores the workspace`, async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 600 })
    await page.addInitScript((theme) => {
      localStorage.setItem('hyperpg-font-size-px', '18')
      localStorage.setItem('hyperpg-theme', theme)
    }, theme)
    await page.route('**/bindings/changeme/internal/database/postgresservice.*', route => route.fulfill({ contentType: 'text/javascript', body: postgresFixture }))
    await page.route('**/bindings/changeme/internal/updates/updateservice.*', route => route.fulfill({ contentType: 'text/javascript', body: 'export async function CheckForUpdates() { return { available: false } }' }))
    await page.goto('/')
    await page.getByRole('button', { name: 'New SQL script' }).click()
    const editor = page.getByRole('textbox', { name: 'SQL script' })
    await editor.fill('SELECT 1;')
    await page.getByRole('button', { name: 'Run script' }).click()
    const navigation = page.getByRole('button', { name: 'Open navigation' })
    for (const expanded of [false, true]) {
      if (expanded) await page.getByRole('button', { name: 'Expand results' }).click()
      await navigation.focus()
      await page.keyboard.press('Enter')
      const drawer = page.getByRole('dialog', { name: 'Database navigation', exact: true })
      await expect(drawer.getByRole('button', { name: 'Close navigation panel' })).toBeFocused()
      const heading = (await drawer.locator('.sidebar-section-heading > span').boundingBox())!
      const close = (await drawer.getByRole('button', { name: 'Close navigation panel' }).boundingBox())!
      const add = (await drawer.getByRole('button', { name: 'Add a database connection' }).boundingBox())!
      const sidebar = (await drawer.boundingBox())!
      expect(close.x - heading.x - heading.width).toBeGreaterThanOrEqual(8)
      expect(add.x + add.width).toBeLessThanOrEqual(sidebar.x + sidebar.width - 4)
      expect(await page.locator('.main-panel').evaluate(element => (element as HTMLElement).inert)).toBe(true)
      for (const key of ['Tab', 'Shift+Tab']) {
        for (let i = 0; i < 12; i++) {
          await page.keyboard.press(key)
          expect(await drawer.evaluate(element => element.contains(document.activeElement))).toBe(true)
          expect(await page.evaluate(() => {
            const focused = document.activeElement as HTMLElement
            const r = focused.getBoundingClientRect()
            return r.top >= 0 && r.bottom <= innerHeight && focused.contains(document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2))
          })).toBe(true)
        }
      }
      await drawer.getByRole('button', { name: 'Add a database connection' }).focus()
      await page.keyboard.press('Enter')
      const dialog = page.getByRole('dialog', { name: 'New connection', exact: true })
      await expect(dialog).toBeVisible()
      await page.keyboard.press('Tab')
      expect(await dialog.evaluate(element => element.contains(document.activeElement))).toBe(true)
      await page.keyboard.press('Escape')
      await expect(dialog).toHaveCount(0)
      await expect(drawer.getByRole('button', { name: 'Add a database connection' })).toBeFocused()
      await page.keyboard.press('Escape')
      await expect(navigation).toBeFocused()
      expect(await page.locator('.main-panel').evaluate(element => (element as HTMLElement).inert)).toBe(false)
      await expect(page.getByRole('tab', { name: 'Script 1', exact: true })).toBeVisible()
      await expect(page.getByRole('tab', { name: 'Script 2', exact: true })).toHaveCount(0)
      await expect(editor).toHaveText('SELECT 1;')
    }
    await navigation.click()
    await page.getByRole('button', { name: 'Close navigation panel' }).click()
    await expect(navigation).toBeFocused()
    await navigation.click()
    await page.setViewportSize({ width: 1280, height: 900 })
    await expect.poll(() => page.locator('.main-panel').evaluate(element => (element as HTMLElement).inert)).toBe(false)
    await editor.click()
    await expect(editor).toBeFocused()
  })

  test(`${theme} drawer resizing preserves dialog isolation and restores the workspace`, async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 600 })
    await page.addInitScript((theme) => {
      localStorage.setItem('hyperpg-font-size-px', '18')
      localStorage.setItem('hyperpg-theme', theme)
    }, theme)
    await page.route('**/bindings/changeme/internal/database/postgresservice.*', route => route.fulfill({ contentType: 'text/javascript', body: postgresFixture }))
    await page.route('**/bindings/changeme/internal/updates/updateservice.*', route => route.fulfill({ contentType: 'text/javascript', body: 'export async function CheckForUpdates() { return { available: false } }' }))
    await page.goto('/')
    await page.getByRole('button', { name: 'New SQL script' }).click()
    const editor = page.getByRole('textbox', { name: 'SQL script' })
    await editor.fill('SELECT 1;')
    const navigation = page.getByRole('button', { name: 'Open navigation' })
    for (const width of [561, 600, 1280]) {
      for (const nestedDialog of [false, true]) {
        await page.setViewportSize({ width: 390, height: 600 })
        await navigation.click()
        if (nestedDialog) await page.getByRole('button', { name: 'Add a database connection' }).click()
        await page.setViewportSize({ width, height: 600 })
        await expect(page.locator('.sidebar')).not.toHaveClass(/is-mobile-open/)
        await expect(page.locator('.mobile-drawer-close')).toBeHidden()
        if (nestedDialog) {
          const dialog = page.getByRole('dialog', { name: 'New connection', exact: true })
          await editor.evaluate(element => (element as HTMLElement).focus())
          expect(await dialog.evaluate(element => element.contains(document.activeElement))).toBe(true)
          expect(await page.locator('.main-panel').evaluate(element => (element as HTMLElement).inert)).toBe(true)
          await page.keyboard.press('Tab')
          expect(await dialog.evaluate(element => element.contains(document.activeElement))).toBe(true)
          await dialog.getByRole('button', { name: 'Cancel', exact: true }).click()
        }
        await expect.poll(() => page.locator('.main-panel').evaluate(element => (element as HTMLElement).inert)).toBe(false)
        await editor.click()
        await expect(editor).toBeFocused()
        await expect(editor).toHaveText('SELECT 1;')
      }
    }
    await page.setViewportSize({ width: 390, height: 600 })
    await navigation.click()
    await page.getByRole('button', { name: 'Add a database connection' }).click()
    await page.setViewportSize({ width: 600, height: 600 })
    await expect(page.locator('.sidebar')).not.toHaveClass(/is-mobile-open/)
    await page.setViewportSize({ width: 390, height: 600 })
    await page.keyboard.press('Escape')
    await expect(navigation).toBeFocused()
    await editor.click()
    await expect(editor).toBeFocused()
  })

  test(`${theme} mobile navigation remains clickable after expanding SQL results`, async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 600 })
    await page.addInitScript((theme) => {
      localStorage.setItem('hyperpg-font-size-px', '18')
      localStorage.setItem('hyperpg-theme', theme)
    }, theme)
    await page.route('**/bindings/changeme/internal/database/postgresservice.*', route => route.fulfill({ contentType: 'text/javascript', body: postgresFixture }))
    await page.route('**/bindings/changeme/internal/updates/updateservice.*', route => route.fulfill({ contentType: 'text/javascript', body: 'export async function CheckForUpdates() { return { available: false } }' }))
    await page.goto('/')
    await page.getByRole('button', { name: 'New SQL script' }).click()
    const editor = page.getByRole('textbox', { name: 'SQL script' })
    await editor.fill('SELECT 1;')
    await page.getByRole('button', { name: 'Run script' }).click()
    const navigation = page.getByRole('button', { name: 'Open navigation' })
    for (const expanded of [false, true]) {
      if (expanded) await page.getByRole('button', { name: 'Expand results' }).click()
      await navigation.click()
      await expect(page.locator('body > .sql-results.is-expanded')).toHaveCount(0)
      const settings = page.getByRole('button', { name: 'Settings', exact: true })
      await expect.poll(() => settings.evaluate(element => {
        const r = element.getBoundingClientRect()
        return element.contains(document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2))
      })).toBe(true)
      const bounds = (await settings.boundingBox())!
      await page.mouse.click(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2)
      const dialog = page.getByRole('dialog', { name: 'Settings', exact: true })
      await expect(dialog).toBeVisible()
      await page.keyboard.press('Tab')
      expect(await dialog.evaluate(element => element.contains(document.activeElement))).toBe(true)
      if (expanded) await page.keyboard.press('Escape')
      else await page.getByRole('button', { name: 'Close settings' }).click()
      await expect(dialog).toHaveCount(0)
      await expect(navigation).toHaveAttribute('aria-expanded', 'false')
      await expect(navigation).toBeFocused()
      await expect(editor).toHaveText('SELECT 1;')
      expect(await page.locator('.sql-source').evaluate(element => (element as HTMLElement).inert)).toBe(false)
    }
    await page.getByRole('button', { name: 'Expand results' }).click()
    await navigation.click()
    await page.getByRole('button', { name: 'Close navigation', exact: true }).click()
    await expect(navigation).toHaveAttribute('aria-expanded', 'false')
    await editor.click()
    await expect(editor).toBeFocused()
  })
}

test('SQL database context remains visible when the sidebar narrows the main pane', async ({ page }) => {
  await page.setViewportSize({ width: 1100, height: 700 })
  await page.addInitScript(() => { localStorage.setItem('hyperpg-font-size-px', '18'); localStorage.setItem('hyperpg-sidebar-width', '360') })
  await page.route('**/bindings/changeme/internal/database/postgresservice.*', route => route.fulfill({ contentType: 'text/javascript', body: postgresFixture }))
  await page.route('**/bindings/changeme/internal/updates/updateservice.*', route => route.fulfill({ contentType: 'text/javascript', body: 'export async function CheckForUpdates() { return { available: false } }' }))
  await page.goto('/')
  expect((await page.locator('.main-panel').boundingBox())!.width).toBeLessThan(900)
  await page.getByRole('button', { name: 'New SQL script' }).click()
  const label = page.locator('.sql-heading').getByText('test', { exact: true })
  await expect(label).toBeVisible()
  await expect(label).toHaveAttribute('title', 'test')
})
