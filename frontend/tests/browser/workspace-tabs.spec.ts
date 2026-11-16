import { expect, test, type Page } from '@playwright/test'

// Workspace behaviours wired in App.tsx: tab management, closing unsaved scripts,
// in-place paging, the save notice and query history errors.
const postgresFixture = `
const columns = [{ name: 'id', dataType: 'integer', nullable: false, hasDefault: false, generated: false, autoIncrement: false }];
const state = window.tabsTest = { rows: Array.from({ length: 250 }, (_, i) => String(i + 1)), pending: [], hold: false, saved: [], savedFiles: [] };
const connection = { id: 'test', name: 'Test', host: 'localhost', database: 'test', username: 'test', showAllDatabases: false };
export async function ListSavedConnections() { return [connection]; }
export async function OpenSavedConnection() { return connection; }
export async function ListDatabases() { return ['test']; }
export async function OpenDatabase() { return 'test'; }
export async function ListTables() { return ['items', 'orders', 'users'].map(name => ({ schema: 'public', name })); }
export async function GetTableData(_id, _schema, table, limit, offset) {
  if (state.hold) await new Promise(resolve => state.pending.push(resolve));
  const all = table === 'items' ? state.rows : ['1'];
  const rows = all.slice(offset, offset + limit);
  return { columns, rows: rows.map(value => [value]), rowCount: all.length,
    identities: rows.map((_, i) => ({ tableOID: '1', ctid: '(0,' + (offset + i + 1) + ')', version: '1' })) };
}
export async function SaveTableChanges(_id, _schema, _table, changes) {
  state.saved.push(changes);
  for (const change of changes) {
    const index = Number(change.identity.ctid.match(/,(\\d+)\\)/)[1]) - 1;
    state.rows[index] = change.values.id;
  }
}
export async function SaveSQLFile(path, name, content) {
  state.savedFiles.push({ path, name, content });
  return { path: path || '/scripts/' + name + '.sql', name: name + '.sql', content };
}
export async function ExecuteSQLScript() { return { results: [], error: '', rolledBack: false }; }
`

const tab = (page: Page, name: string | RegExp) => page.getByRole('tab', { name })
const tabNames = (page: Page) => page.getByRole('tablist', { name: 'Open workspaces' }).getByRole('tab').evaluateAll((tabs) => tabs.map((tab) => tab.querySelector('.editor-tab-title')?.textContent))

test.beforeEach(async ({ page }) => {
  await page.route('**/bindings/changeme/internal/database/postgresservice.*', route => route.fulfill({ contentType: 'text/javascript', body: postgresFixture }))
  await page.route('**/bindings/changeme/internal/updates/updateservice.*', route => route.fulfill({ contentType: 'text/javascript', body: 'export async function CheckForUpdates() { return { available: false, version: "dev", releaseUrl: "" } }' }))
  await page.goto('/')
  await expect(page.getByRole('treeitem', { name: 'items', exact: true })).toBeVisible()
})

async function openTables(page: Page, names: string[]) {
  for (const name of names) {
    await page.getByRole('treeitem', { name, exact: true }).click()
    await expect(tab(page, name)).toHaveAttribute('aria-selected', 'true')
  }
}

test('middle-click closes a tab and the context menu closes others or tabs to the right', async ({ page }) => {
  await openTables(page, ['items', 'orders', 'users'])
  await tab(page, 'orders').click({ button: 'middle' })
  expect(await tabNames(page)).toEqual(['items', 'users'])
  // The active tab stays active when another tab closes.
  await expect(tab(page, 'users')).toHaveAttribute('aria-selected', 'true')

  await openTables(page, ['orders'])
  await tab(page, 'items').click({ button: 'right' })
  const menu = page.getByRole('menu', { name: 'items tab actions' })
  await expect(menu.getByRole('menuitem', { name: 'Close', exact: true })).toBeFocused()
  await menu.getByRole('menuitem', { name: 'Close to the right' }).click()
  expect(await tabNames(page)).toEqual(['items'])
  await expect(tab(page, 'items')).toHaveAttribute('aria-selected', 'true')

  await openTables(page, ['orders', 'users'])
  // Shift+F10 opens the same menu from the keyboard; Escape returns focus to the tab.
  await tab(page, 'orders').focus()
  await page.keyboard.press('Shift+F10')
  await expect(page.getByRole('menu', { name: 'orders tab actions' })).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(tab(page, 'orders')).toBeFocused()
  await page.keyboard.press('Shift+F10')
  await page.getByRole('menuitem', { name: 'Close others' }).click()
  expect(await tabNames(page)).toEqual(['orders'])
})

test('Ctrl+Tab, Ctrl+Shift+Tab and Ctrl+PageUp cycle tabs', async ({ page }) => {
  await openTables(page, ['items', 'orders'])
  await page.keyboard.press('Control+Tab')
  await expect(tab(page, 'items')).toHaveAttribute('aria-selected', 'true')
  await page.keyboard.press('Control+Shift+Tab')
  await expect(tab(page, 'orders')).toHaveAttribute('aria-selected', 'true')
  await page.keyboard.press('Control+PageUp')
  await expect(tab(page, 'items')).toHaveAttribute('aria-selected', 'true')
})

test('closing an unsaved script offers Save, Don’t save and Cancel', async ({ page }) => {
  await page.getByRole('button', { name: 'New SQL script' }).click()
  const editor = page.getByRole('textbox', { name: 'SQL script' })
  // New SQL focuses the editor.
  await expect(editor).toBeFocused()
  await page.keyboard.type('select 1;')
  await expect(tab(page, 'Script 1, unsaved changes')).toBeVisible()

  await page.getByRole('button', { name: 'Close Script 1' }).click()
  let dialog = page.getByRole('dialog', { name: 'Save changes to Script 1?' })
  await expect(dialog.getByRole('button', { name: 'Cancel' })).toBeFocused()
  await dialog.getByRole('button', { name: 'Cancel' }).click()
  await expect(tab(page, /Script 1/)).toBeVisible()

  await page.getByRole('button', { name: 'Close Script 1' }).click()
  dialog = page.getByRole('dialog', { name: 'Save changes to Script 1?' })
  await dialog.getByRole('button', { name: 'Save', exact: true }).click()
  await expect(tab(page, /Script 1/)).toHaveCount(0)
  expect(await page.evaluate(() => (window as any).tabsTest.savedFiles)).toEqual([{ path: '', name: 'Script 1', content: 'select 1;' }])

  await page.getByRole('button', { name: 'New SQL script' }).click()
  await page.keyboard.type('select 2;')
  await page.getByRole('button', { name: 'Close Script 2' }).click()
  await page.getByRole('dialog', { name: 'Save changes to Script 2?' }).getByRole('button', { name: 'Don’t save' }).click()
  await expect(tab(page, /Script 2/)).toHaveCount(0)
  expect(await page.evaluate(() => (window as any).tabsTest.savedFiles.length)).toBe(1)
})

test('the grid stays mounted and focus stays on the pager while the next page loads', async ({ page }) => {
  await openTables(page, ['items'])
  await expect(page.locator('[data-cell="0:0"]')).toHaveText('1')
  await page.evaluate(() => {
    const state = (window as any).tabsTest
    state.hold = true
    state.grid = document.querySelector('.data-grid-scroll')
  })
  const next = page.getByRole('button', { name: 'Next page' })
  await next.click()
  await expect(next).toHaveAttribute('aria-disabled', 'true')
  await expect(next).toBeFocused()
  // The previous page stays visible and read-only with a progress bar.
  await expect(page.locator('[data-cell="0:0"]')).toHaveText('1')
  await expect(page.locator('[data-cell="0:0"]')).toHaveAttribute('aria-readonly', 'true')
  await expect(page.getByRole('progressbar', { name: 'Loading rows' })).toBeVisible()
  await expect(page.locator('.pagination-range')).toHaveText('1–100 of 250 rows')
  await page.evaluate(() => (window as any).tabsTest.pending.shift()())
  await expect(page.locator('[data-cell="0:0"]')).toHaveText('101')
  await expect(page.locator('.pagination-range')).toHaveText('101–200 of 250 rows')
  expect(await page.evaluate(() => (window as any).tabsTest.grid === document.querySelector('.data-grid-scroll'))).toBe(true)
  await expect(next).toBeFocused()

  // On the last page Next becomes disabled and focus moves to an enabled pager button.
  await next.click()
  await page.evaluate(() => (window as any).tabsTest.pending.shift()())
  await expect(page.locator('[data-cell="0:0"]')).toHaveText('201')
  await expect(next).toBeDisabled()
  await expect(page.getByRole('button', { name: 'First page' })).toBeFocused()
})

test('a save shows its notice through the refresh and keeps the active cell', async ({ page }) => {
  await openTables(page, ['items'])
  const cell = page.locator('[data-cell="2:0"]')
  await cell.dblclick()
  await page.getByRole('textbox', { name: 'Edit id' }).fill('42')
  await page.keyboard.press('Enter')
  await expect(tab(page, 'items, unsaved changes')).toBeVisible()
  await page.evaluate(() => { (window as any).tabsTest.hold = true })
  await page.getByRole('button', { name: 'Save changes', exact: true }).click()
  await expect(page.locator('.grid-feedback')).toHaveText('Saved 1 change to public.items.')
  await page.evaluate(() => (window as any).tabsTest.pending.shift()())
  await expect(page.locator('.table-status-activity')).toHaveText('')
  await expect(cell).toHaveText('42')
  await expect(page.locator('.grid-feedback')).toHaveText('Saved 1 change to public.items.')
  await expect(page.getByRole('tab', { name: 'items', exact: true })).toBeVisible()
  await expect(page.locator('[data-cell="2:0"]')).toHaveAttribute('aria-selected', 'true')
})

test('query history shows the error of failed and cancelled runs, and clearing can be undone', async ({ page }) => {
  await page.evaluate(() => localStorage.setItem('hyperpg-query-history-v1', JSON.stringify([
    { id: 'a', sql: '-- broken\nselect * from missing;', connectionId: 'test', databaseName: 'test', executedAt: 1, durationMs: 3, error: 'ERROR: relation "missing" does not exist' },
    { id: 'b', sql: 'select pg_sleep(10);', connectionId: 'test', databaseName: 'test', executedAt: 2, durationMs: 900, error: 'Query cancelled' },
    { id: 'c', sql: 'select 1;', connectionId: 'test', databaseName: 'test', executedAt: 3, durationMs: 1, error: '' },
  ])))
  await page.reload()
  await page.getByRole('button', { name: 'Query history' }).click()
  const dialog = page.getByRole('dialog', { name: 'Query history' })
  const entries = dialog.locator('.history-entry')
  await expect(entries.nth(0).locator('.history-status')).toHaveText('Failed')
  await expect(entries.nth(0).locator('.history-status')).toHaveClass(/is-failed/)
  await expect(entries.nth(0).locator('.history-error')).toHaveText('ERROR: relation "missing" does not exist')
  await expect(entries.nth(1).locator('.history-status')).toHaveText('Cancelled')
  await expect(entries.nth(2).locator('.history-status')).toHaveText('Succeeded')
  await expect(entries.nth(2).locator('.history-error')).toHaveCount(0)

  await dialog.getByRole('button', { name: 'Clear history' }).click()
  await expect(dialog.getByRole('status')).toContainText('History cleared.')
  await dialog.getByRole('button', { name: 'Undo' }).click()
  await expect(entries).toHaveCount(3)

  // A reopened entry is named after its first SQL line, not "History query".
  await entries.nth(0).locator('.history-open').click()
  await expect(tab(page, 'select * from missing')).toHaveAttribute('aria-selected', 'true')
})
