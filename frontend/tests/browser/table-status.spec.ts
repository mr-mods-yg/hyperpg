import { expect, test, type Page } from '@playwright/test'

const postgresFixture = `
const state = window.statusTest = {
  rows: [['café'], ['🙂'], [null]], holdReads: false, holdSaves: false, reads: [], saves: [],
};
const connection = { id: 'test', name: 'Test', host: 'localhost', database: 'test', username: 'test', showAllDatabases: false };
export async function ListSavedConnections() { return [connection]; }
export async function OpenSavedConnection() { return connection; }
export async function ListDatabases() { return ['test']; }
export async function OpenDatabase() { return 'test'; }
export async function ListTables() { return [{ schema: 'public', name: 'items' }]; }
export async function GetTableData(_id, _schema, _table, limit, offset) {
  if (state.holdReads) await new Promise((resolve, reject) => state.reads.push({ resolve, reject }));
  const rows = state.rows.slice(offset, offset + limit);
  return { columns: [{ name: 'value', dataType: 'text', nullable: true, hasDefault: false, generated: false, autoIncrement: false }],
    rows: structuredClone(rows), rowCount: state.rows.length,
    identities: rows.map((_, index) => ({ tableOID: '1', ctid: '(0,' + (offset + index + 1) + ')', version: '1' })) };
}
export async function SaveTableChanges(_id, _schema, _table, changes) {
  if (state.holdSaves) await new Promise((resolve, reject) => state.saves.push({ resolve, reject }));
  for (const change of changes) {
    const index = Number(change.identity.ctid.match(/,(\\d+)\\)/)[1]) - 1;
    state.rows[index][0] = change.values.value;
  }
}
`

const grid = (page: Page) => page.getByRole('grid', { name: 'public.items data' })
const cell = (page: Page, row = 0) => page.locator(`[data-cell="${row}:0"]`)
const metrics = (page: Page) => page.locator('.table-status-metrics')
const activity = (page: Page) => page.locator('.table-status-activity')

test.beforeEach(async ({ page }) => {
  await page.route('**/bindings/changeme/postgresservice.*', route => route.fulfill({ contentType: 'text/javascript', body: postgresFixture }))
  await page.route('**/bindings/changeme/updateservice.*', route => route.fulfill({ contentType: 'text/javascript', body: 'export async function CheckForUpdates() { return { available: false, version: "dev", releaseUrl: "" } }' }))
  await page.goto('/')
  await expect(page.getByRole('button', { name: 'Open items table' })).toBeVisible()
})

test('shows fetched rows and estimated UTF-8 size, including during refresh', async ({ page }) => {
  await page.evaluate(() => { (window as any).statusTest.holdReads = true })
  await page.getByRole('button', { name: 'Open items table' }).click()
  await expect(activity(page)).toHaveText('Loading rows…')
  await expect(page.getByRole('progressbar')).toHaveCount(0)
  await expect(metrics(page)).toHaveText('—')
  await page.evaluate(() => (window as any).statusTest.reads.shift().resolve())
  await expect(cell(page)).toHaveText('café')
  const initialBytes = await page.evaluate(() => new TextEncoder().encode(JSON.stringify((window as any).statusTest.rows)).byteLength)
  await expect(metrics(page)).toHaveText(`3 rows · ~${initialBytes} B`)
  await expect(activity(page)).toHaveText('')
  await expect(metrics(page)).toHaveAttribute('title', /estimated UTF-8 JSON size/)

  await page.evaluate(() => {
    const state = (window as any).statusTest
    state.rows.push(['new'])
    state.grid = document.querySelector('.data-grid-scroll')
  })
  await page.getByRole('button', { name: 'Refresh', exact: true }).click()
  await expect(activity(page)).toHaveText('Refreshing rows…')
  await expect(page.getByRole('progressbar')).toHaveCount(0)
  await expect(cell(page)).toHaveText('café')
  await expect(grid(page)).toHaveAttribute('aria-busy', 'true')
  expect(await page.evaluate(() => (window as any).statusTest.grid === document.querySelector('.data-grid-scroll'))).toBe(true)
  await page.evaluate(() => (window as any).statusTest.reads.shift().resolve())
  await expect(cell(page, 3)).toHaveText('new')
  const updatedBytes = await page.evaluate(() => new TextEncoder().encode(JSON.stringify((window as any).statusTest.rows)).byteLength)
  await expect(metrics(page)).toHaveText(`4 rows · ~${updatedBytes} B`)
  await expect(activity(page)).toHaveText('')
})

test('shows status for a save followed by its refresh', async ({ page }) => {
  await page.getByRole('button', { name: 'Open items table' }).click()
  await expect(cell(page)).toHaveText('café')
  await cell(page).dblclick()
  await page.getByRole('textbox', { name: 'Edit value' }).fill('saved')
  await page.keyboard.press('Enter')
  await page.evaluate(() => { const state = (window as any).statusTest; state.holdSaves = true; state.holdReads = true })
  await page.getByRole('button', { name: 'Save changes', exact: true }).click()
  await expect(activity(page)).toHaveText('Saving changes…')
  await expect(page.getByRole('progressbar')).toHaveCount(0)
  await page.evaluate(() => (window as any).statusTest.saves.shift().resolve())
  await expect(activity(page)).toHaveText('Refreshing rows…')
  await expect(cell(page)).toHaveText('café')
  await page.evaluate(() => (window as any).statusTest.reads.shift().resolve())
  await expect(cell(page)).toHaveText('saved')
  await expect(activity(page)).toHaveText('')
  const bytes = await page.evaluate(() => new TextEncoder().encode(JSON.stringify((window as any).statusTest.rows)).byteLength)
  await expect(metrics(page)).toHaveText(`3 rows · ~${bytes} B`)
})

test('shows failure and protects the stale page until retry succeeds', async ({ page }) => {
  await page.getByRole('button', { name: 'Open items table' }).click()
  await expect(cell(page)).toHaveText('café')
  await page.evaluate(() => { (window as any).statusTest.holdReads = true })
  await page.getByRole('button', { name: 'Refresh', exact: true }).click()
  await expect(activity(page)).toHaveText('Refreshing rows…')
  await page.evaluate(() => (window as any).statusTest.reads.shift().reject(new Error('Read failed')))
  await expect(page.getByText('Read failed')).toBeVisible()
  await expect(activity(page)).toHaveText('Refresh failed')
  await expect(grid(page)).toHaveAttribute('aria-busy', 'false')
  await expect(cell(page)).toHaveAttribute('aria-readonly', 'true')
  await expect(page.getByRole('button', { name: 'Add row' })).toBeDisabled()
  await expect(page.getByRole('button', { name: 'Refresh', exact: true })).toBeEnabled()
  await page.getByRole('button', { name: 'Refresh', exact: true }).click()
  await expect(activity(page)).toHaveText('Refreshing rows…')
  await page.evaluate(() => (window as any).statusTest.reads.shift().resolve())
  await expect(activity(page)).toHaveText('')
  await expect(page.getByText('Read failed')).toHaveCount(0)
  await expect(cell(page)).toHaveAttribute('aria-readonly', 'false')
  await expect(page.getByRole('button', { name: 'Add row' })).toBeEnabled()
})

test('clears save status and keeps the draft when an update fails', async ({ page }) => {
  await page.getByRole('button', { name: 'Open items table' }).click()
  await expect(cell(page)).toHaveText('café')
  await cell(page).dblclick()
  await page.getByRole('textbox', { name: 'Edit value' }).fill('draft')
  await page.keyboard.press('Enter')
  await page.evaluate(() => { (window as any).statusTest.holdSaves = true })
  await page.getByRole('button', { name: 'Save changes', exact: true }).click()
  await expect(activity(page)).toHaveText('Saving changes…')
  await page.evaluate(() => (window as any).statusTest.saves.shift().reject(new Error('Update failed')))
  await expect(page.getByRole('alert')).toContainText('Update failed')
  await expect(activity(page)).toHaveText('')
  await expect(cell(page)).toHaveText('draft')
  await expect(page.getByRole('button', { name: 'Save changes', exact: true })).toBeEnabled()
})

test('formats empty and larger fetched pages', async ({ page }) => {
  await page.evaluate(() => { (window as any).statusTest.rows = [] })
  await page.getByRole('button', { name: 'Open items table' }).click()
  await expect(metrics(page)).toHaveText('0 rows · ~0 B')
  await page.evaluate(() => { (window as any).statusTest.rows = [['é'.repeat(1024)]] })
  await page.getByRole('button', { name: 'Refresh', exact: true }).click()
  await expect(metrics(page)).toHaveText('1 row · ~2.0 KiB')
})
