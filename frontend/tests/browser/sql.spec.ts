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
  await page.getByRole('button', { name: 'Expand results' }).click()
  await expect(editor).toBeHidden()
  await expect(page.getByRole('cell', { name: 'hello' })).toBeVisible()
  await page.getByRole('button', { name: 'Restore editor' }).click()
  await expect(editor).toBeVisible()
  await expect.poll(() => page.evaluate(() => (window as any).sqlTestState.calls)).toEqual([{ id: 'test', script: "SELECT 'hello';" }])
  await expect.poll(() => page.evaluate(() => (window as any).sqlTestState.refreshes)).toBeGreaterThan(1)
  await page.getByRole('button', { name: 'New SQL script' }).click()
  await expect(page.getByRole('textbox', { name: 'SQL script' })).toHaveValue('')
  await page.getByRole('textbox', { name: 'SQL script' }).fill('SELECT 42;')
  await page.getByRole('tab', { name: 'Script 1', exact: true }).click()
  await expect(editor).toHaveValue("SELECT 'hello';")
  await expect(page.getByText('SELECT 2')).toBeVisible()
  await page.getByRole('tab', { name: 'Script 2', exact: true }).click()
  await expect(page.getByRole('textbox', { name: 'SQL script' })).toHaveValue('SELECT 42;')
  await page.getByRole('button', { name: 'Close Script 2' }).click()
  await page.getByRole('button', { name: 'Close script', exact: true }).click()
  await expect(editor).toHaveValue("SELECT 'hello';")
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
  await expect(editor).toHaveValue('')
  await expect(page.getByRole('button', { name: 'Run script' })).toBeDisabled()
})

test('configures shortcuts and applies them across settings and tabs', async ({ page }) => {
  await page.route('**/bindings/changeme/postgresservice.*', route => route.fulfill({ contentType: 'text/javascript', body: postgresFixture }))
  await page.route('**/bindings/changeme/updateservice.*', route => route.fulfill({ contentType: 'text/javascript', body: 'export async function CheckForUpdates() { return { available: false, version: "dev", releaseUrl: "" } }' }))
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
  await page.route('**/bindings/changeme/postgresservice.*', route => route.fulfill({ contentType: 'text/javascript', body: fixture }))
  await page.route('**/bindings/changeme/updateservice.*', route => route.fulfill({ contentType: 'text/javascript', body: 'export async function CheckForUpdates() { return { available: false } }' }))
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
