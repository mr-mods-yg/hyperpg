import { expect, test } from '@playwright/test'

const fixture = `
const connection = { id: 'saved', name: 'Test', host: 'localhost', database: 'main', username: 'test', showAllDatabases: false };
window.workspaceCalls = [];
export async function ListSavedConnections() { return [connection]; }
export async function OpenSavedConnection() { return connection; }
export async function OpenDatabase(id, name) { window.workspaceCalls.push([id, name]); return 'new-handle'; }
export async function ListDatabases() { return ['main']; }
export async function ListTables() { return []; }
export async function ExecuteSQLScript(id, sql) { return { results: [], error: '', rolledBack: false }; }
`

test.beforeEach(async ({ page }) => {
  await page.route('**/bindings/changeme/internal/database/postgresservice.*', route => route.fulfill({ contentType: 'text/javascript', body: fixture }))
  await page.route('**/bindings/changeme/internal/updates/updateservice.*', route => route.fulfill({ contentType: 'text/javascript', body: 'export async function CheckForUpdates() { return { available: false } }' }))
})

test('restores drafts using the saved connection and database, not a stale handle', async ({ page }) => {
  await page.goto('/')
  await page.getByRole('button', { name: 'New SQL script' }).click()
  await page.getByRole('textbox', { name: 'SQL script' }).fill('select 123;')
  await expect.poll(() => page.evaluate(() => localStorage.getItem('hyperpg-workspace-v1'))).toContain('select 123;')
  const stored = await page.evaluate(() => localStorage.getItem('hyperpg-workspace-v1'))
  expect(stored).not.toContain('new-handle')
  await page.reload()
  await expect(page.getByRole('textbox', { name: 'SQL script' })).toHaveText('select 123;')
  await expect.poll(() => page.evaluate(() => (window as any).workspaceCalls.some((call: string[]) => call[0] === 'saved' && call[1] === 'main'))).toBe(true)
  expect(await page.evaluate(() => (window as any).workspaceCalls.every((call: string[]) => call[0] === 'saved' && call[1] === 'main'))).toBe(true)
})

test('records, searches, opens and deletes query history', async ({ page }) => {
  await page.goto('/')
  await page.getByRole('button', { name: 'New SQL script' }).click()
  await page.getByRole('textbox', { name: 'SQL script' }).fill('select 987;')
  await page.getByRole('button', { name: 'Run script' }).click()
  await page.getByRole('button', { name: 'Query history' }).click()
  await page.getByRole('textbox', { name: 'Search query history' }).fill('not-in-history')
  await expect(page.getByRole('dialog', { name: 'Query history' }).getByRole('status')).toContainText('No matching queries')
  await page.getByRole('textbox', { name: 'Search query history' }).fill('987')
  await expect(page.getByRole('dialog', { name: 'Query history' }).getByText('select 987;', { exact: true })).toBeVisible()
  await page.getByRole('button', { name: /select 987/ }).click()
  await expect(page.getByRole('textbox', { name: 'SQL script' })).toHaveText('select 987;')
  await page.getByRole('button', { name: 'Query history' }).click()
  await page.getByRole('button', { name: 'Delete history entry' }).click()
  await expect(page.getByText('No queries yet.')).toBeVisible()
})

test('opens and saves a SQL file and renames its tab', async ({ page }) => {
  const nativeFixture = fixture + `
export async function OpenSQLFile() { return {path:'/tmp/original.sql', name:'original.sql', content:'SELECT 1;'} }
export async function SaveSQLFile(path,name,content) { window.savedFile = {path,name,content}; return {path,name:'original.sql',content} }
`
  await page.route('**/bindings/changeme/internal/database/postgresservice.*', route => route.fulfill({ contentType: 'text/javascript', body: nativeFixture }))
  await page.goto('/')
  await page.getByRole('button', { name: 'Open SQL', exact: true }).click()
  await expect(page.getByRole('textbox', { name: 'SQL script' })).toHaveText('SELECT 1;')
  await page.getByRole('textbox', { name: 'SQL script' }).fill('SELECT 2;')
  await page.getByRole('button', { name: 'Save SQL', exact: true }).click()
  await expect.poll(() => page.evaluate(() => (window as any).savedFile)).toEqual({path:'/tmp/original.sql',name:'original.sql',content:'SELECT 2;'})
  await page.getByRole('button', { name: 'Rename', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: 'Rename script' })
  await dialog.getByLabel('Script name').fill('Weekly report')
  await dialog.getByRole('button', { name: 'Rename', exact: true }).click()
  await expect(page.getByRole('tab', { name: 'Weekly report', exact: true })).toHaveAttribute('aria-selected','true')
  await page.getByRole('button', { name: 'Save SQL', exact: true }).click()
  await expect.poll(() => page.evaluate(() => (window as any).savedFile?.name)).toBe('Weekly report')
  await expect(page.getByRole('tab', { name: 'Weekly report', exact: true })).toHaveAttribute('aria-selected','true')
})

const seed = (activeTabId = 'active') => ({ activeTabId, drafts:{active:'SELECT 1;'},tabs:[{id:'active',kind:'script',connectionId:'saved',databaseName:'main',title:'Active'},{id:'slow',kind:'script',connectionId:'saved',databaseName:'slow',title:'Slow'}] })
test('closing a tab while its database reopens cannot activate a deleted tab', async ({ page }) => {
  const delayed = fixture.replace("export async function OpenDatabase(id, name) {", "export async function OpenDatabase(id, name) { if (name === 'slow') { await new Promise(resolve => { window.finishReopen = resolve }); window.reopenResolved = true; }")
  await page.addInitScript((workspace) => localStorage.setItem('hyperpg-workspace-v1', JSON.stringify(workspace)),seed())
  await page.route('**/bindings/changeme/internal/database/postgresservice.*', route => route.fulfill({ contentType: 'text/javascript', body: delayed }))
  await page.goto('/')
  await expect(page.getByRole('button', { name: 'Run script', exact: true })).toBeEnabled()
  await page.getByRole('tab', { name: 'Slow', exact: true }).click()
  await expect.poll(() => page.evaluate(() => typeof (window as any).finishReopen)).toBe('function')
  await page.getByRole('button', { name: 'Close Slow', exact: true }).click()
  await page.evaluate(() => (window as any).finishReopen())
  await expect.poll(() => page.evaluate(() => (window as any).reopenResolved)).toBe(true)
  await expect(page.getByRole('tab', { name: 'Slow', exact: true })).toHaveCount(0)
  await expect(page.getByRole('tab', { name: 'Active', exact: true })).toHaveAttribute('aria-selected','true')
})

test('a failed restored tab can be retried without changing its database', async ({ page }) => {
  const failing = fixture.replace("export async function OpenDatabase(id, name) {", "export async function OpenDatabase(id, name) { if (window.failRestore) throw new Error('Temporary connection failure');")
  await page.addInitScript((workspace) => { localStorage.setItem('hyperpg-workspace-v1', JSON.stringify(workspace)); (window as any).failRestore = true },seed())
  await page.route('**/bindings/changeme/internal/database/postgresservice.*', route => route.fulfill({ contentType: 'text/javascript', body: failing }))
  await page.goto('/')
  await expect(page.getByRole('alert')).toContainText('Temporary connection failure')
  await expect(page.getByRole('button', { name: 'Run script', exact: true })).toBeDisabled()
  await page.evaluate(() => { (window as any).failRestore = false })
  await page.getByRole('tab', { name: 'Active', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Run script', exact: true })).toBeEnabled()
  await expect(page.getByRole('textbox', { name: 'SQL script' })).toHaveText('SELECT 1;')
  await expect(page.getByRole('alert')).toHaveCount(0)
})

test('long history entries keep actions reachable and keyboard focus after deletion', async ({ page }) => {
  const longDatabase = 'analytics_reporting_database_with_an_extremely_long_unbroken_name_for_regional_customers'
  const longSql = `SELECT ${'customer_identifier_'.repeat(12)} FROM accounts;`
  await page.setViewportSize({ width: 390, height: 600 })
  await page.addInitScript(({ longDatabase, longSql }) => {
    localStorage.setItem('hyperpg-font-size-px', '18')
    localStorage.setItem('hyperpg-query-history-v1', JSON.stringify(Array.from({ length: 10 }, (_, index) => ({
      id: `entry-${index}`, sql: index === 0 ? longSql : `SELECT ${index};`, connectionId: 'saved', databaseName: index === 0 ? longDatabase : 'main', executedAt: 1735689600000, durationMs: 25, error: '',
    }))))
  }, { longDatabase, longSql })
  await page.goto('/')
  const workspaceActions = page.getByRole('button', { name: 'Workspace actions' })
  await workspaceActions.click()
  await page.getByRole('button', { name: 'Query history' }).click()
  const dialog = page.getByRole('dialog', { name: 'Query history' })
  const search = dialog.getByLabel('Search query history')
  await expect(search).toBeFocused()
  const entries = dialog.locator('.history-entry')
  const first = entries.first()
  await expect(first.locator('code')).toHaveAttribute('title', longSql)
  await expect(first.locator('.history-database')).toHaveAttribute('title', longDatabase)
  expect(await first.locator('.history-database').evaluate(element =>
    element.scrollWidth <= element.clientWidth && element.scrollHeight <= element.clientHeight,
  )).toBe(true)
  const boxes = await first.evaluate((entry) => {
    const text = entry.querySelector('.history-database')!.getBoundingClientRect()
    const remove = entry.querySelector('.ui-button')!.getBoundingClientRect()
    return { textRight: text.right, removeLeft: remove.left }
  })
  expect(boxes.textRight).toBeLessThanOrEqual(boxes.removeLeft)
  await search.fill('regional_customers')
  await expect(entries).toHaveCount(1)
  await search.fill('no matching SQL')
  await expect(dialog.getByRole('status')).toContainText('No matching queries')
  await search.fill('')
  const deleteFirst = first.getByRole('button', { name: 'Delete history entry' })
  await deleteFirst.focus()
  await page.keyboard.press('Enter')
  await expect(entries).toHaveCount(9)
  await expect(entries.first().getByRole('button', { name: 'Delete history entry' })).toBeFocused()
  const lastDelete = entries.last().getByRole('button', { name: 'Delete history entry' })
  await lastDelete.scrollIntoViewIfNeeded()
  await lastDelete.focus()
  await page.keyboard.press('Enter')
  await expect(entries).toHaveCount(8)
  await expect(entries.last().getByRole('button', { name: 'Delete history entry' })).toBeFocused()
  await page.setViewportSize({ width: 390, height: 420 })
  const done = dialog.getByRole('button', { name: 'Done' })
  const doneBounds = (await done.boundingBox())!
  expect(doneBounds.y + doneBounds.height).toBeLessThanOrEqual(420)
  await dialog.getByRole('button', { name: 'Clear history' }).click()
  await expect(dialog.getByRole('status')).toContainText('No queries yet.')
  await expect(search).toBeFocused()
  await done.click()
  await expect(workspaceActions).toBeFocused()
})

test('keyboard opens a complete long SQL history entry', async ({ page }) => {
  const sql = `SELECT ${'customer_identifier_'.repeat(12)} FROM accounts;`
  await page.addInitScript((sql) => localStorage.setItem('hyperpg-query-history-v1', JSON.stringify([{ id: 'long', sql, connectionId: 'saved', databaseName: 'main', executedAt: 1735689600000, durationMs: 25, error: '' }])), sql)
  await page.goto('/')
  await page.getByRole('button', { name: 'Query history' }).click()
  await page.keyboard.press('Tab')
  await expect(page.locator('.history-open')).toBeFocused()
  await page.keyboard.press('Enter')
  await expect(page.getByRole('textbox', { name: 'SQL script' })).toHaveText(sql)
})
