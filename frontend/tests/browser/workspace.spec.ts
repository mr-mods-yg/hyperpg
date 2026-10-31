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
