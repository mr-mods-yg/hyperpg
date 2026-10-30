import { expect, test } from '@playwright/test'

const postgresFixture = `
const connection = { id: 'test', name: 'Test', host: 'localhost', database: 'test', username: 'test', showAllDatabases: false };
window.sqlTestState = { calls: [], refreshes: 0 };
export async function ListSavedConnections() { return [connection]; }
export async function OpenSavedConnection() { return connection; }
export async function ListDatabases() { return ['test']; }
export async function OpenDatabase() { return 'test'; }
export async function ListTables() { window.sqlTestState.refreshes++; return []; }
export async function ExecuteSQLScript(id, script) {
 window.sqlTestState.calls.push({ id, script });
 return { results: [{ columns: ['value'], rows: [['hello'], [null]], command: 'SELECT 2', truncated: false }], error: '', rolledBack: false };
}
`

test('runs scripts, displays results, and keeps the draft', async ({ page }) => {
  await page.route('**/bindings/changeme/postgresservice.*', route => route.fulfill({ contentType: 'text/javascript', body: postgresFixture }))
  await page.route('**/bindings/changeme/updateservice.*', route => route.fulfill({ contentType: 'text/javascript', body: 'export async function CheckForUpdates() { return { available: false, version: "dev", releaseUrl: "" } }' }))
  await page.goto('/')
  await page.getByRole('button', { name: 'New SQL script' }).click()
  const editor = page.getByRole('textbox', { name: 'SQL script' })
  await editor.fill("SELECT 'hello';")
  await expect(editor).toHaveValue("SELECT 'hello';")
  await page.getByRole('button', { name: 'Run script' }).click()
  await expect(page.getByText('SELECT 2')).toBeVisible()
  await expect(page.getByRole('cell', { name: 'hello' })).toBeVisible()
  await expect(page.getByRole('cell', { name: 'NULL' })).toBeVisible()
  await expect.poll(() => page.evaluate(() => (window as any).sqlTestState.calls)).toEqual([{ id: 'test', script: "SELECT 'hello';" }])
  await expect.poll(() => page.evaluate(() => (window as any).sqlTestState.refreshes)).toBeGreaterThan(1)
  await page.getByRole('button', { name: 'Database', exact: true }).click()
  await page.getByRole('button', { name: 'New SQL script' }).click()
  await expect(editor).toHaveValue("SELECT 'hello';")
  await editor.fill("SELECT 1;\nSELECT 2;")
  await editor.focus()
  await page.keyboard.press('End')
  await page.keyboard.press('Shift+Home')
  await expect(page.getByRole('button', { name: 'Run selection' })).toBeVisible()
  await page.keyboard.press('Control+Enter')
  await expect.poll(() => page.evaluate(() => (window as any).sqlTestState.calls)).toEqual([
    { id: 'test', script: "SELECT 'hello';" }, { id: 'test', script: 'SELECT 2;' },
  ])
  await page.getByRole('button', { name: 'Copy CSV' }).click()
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe('value\r\nhello\r\n')
  await page.getByRole('button', { name: 'Clear', exact: true }).click()
  await expect(editor).toHaveValue('')
  await expect(page.getByRole('button', { name: 'Run script' })).toBeDisabled()
})
