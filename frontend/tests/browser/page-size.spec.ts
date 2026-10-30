import { expect, test, type Page } from '@playwright/test'

// Delay and reorder reads at the desktop boundary while the real grid stays mounted.
const postgresFixture = `
const columns = [{ name: 'id', dataType: 'integer', nullable: false, hasDefault: false, generated: false, autoIncrement: false }];
const state = window.pageSizeTest = {
  rows: Array.from({ length: 600 }, (_, i) => String(i + 1)),
  reads: [], pending: [], hold: false,
};
const connection = { id: 'test', name: 'Test', host: 'localhost', database: 'test', username: 'test', showAllDatabases: false };
export async function ListSavedConnections() { return [connection]; }
export async function OpenSavedConnection() { return connection; }
export async function ListDatabases() { return ['test']; }
export async function OpenDatabase() { return 'test'; }
export async function ListTables() { return ['items', 'other'].map(name => ({ schema: 'public', name })); }
export async function GetTableData(_id, _schema, _table, limit, offset) {
  state.reads.push({ limit, offset });
  if (state.hold) await new Promise((resolve, reject) => state.pending.push({ resolve, reject, limit, offset }));
  const allRows = _table === 'other' ? ['other'] : state.rows;
  const rows = allRows.slice(offset, offset + limit);
  return { columns, rows: rows.map(value => [value]), rowCount: allRows.length,
    identities: rows.map(value => ({ tableOID: '1', ctid: '(0,' + value + ')', version: '1' })) };
}
export async function SaveTableChanges(_id, _schema, _table, changes) {
  for (const change of changes) {
    const index = state.rows.findIndex(value => '(0,' + value + ')' === change.identity?.ctid);
    if (index >= 0 && change.kind === 'update') state.rows[index] = change.values.id;
  }
}
`

const row = (page: Page, index: number) => page.locator(`[data-cell="${index}:0"]`)
const size = (page: Page) => page.getByRole('combobox', { name: 'Rows per page' })
const grid = (page: Page) => page.getByRole('grid', { name: 'public.items data' })

test.beforeEach(async ({ page }) => {
  await page.route('**/bindings/changeme/postgresservice.*', route => route.fulfill({ contentType: 'text/javascript', body: postgresFixture }))
  await page.route('**/bindings/changeme/updateservice.*', route => route.fulfill({ contentType: 'text/javascript', body: 'export async function CheckForUpdates() { return { available: false, version: "dev", releaseUrl: "" } }' }))
  await page.goto('/')
  await page.getByRole('button', { name: 'Open items table', exact: true }).click()
  await expect(grid(page).getByRole('rowheader')).toHaveCount(100)
})

test('resizes in place, reuses cached rows and appends the missing range', async ({ page }) => {
  await row(page, 4).click()
  await page.evaluate(() => {
    const state = (window as any).pageSizeTest
    state.grid = document.querySelector('.data-grid-scroll')
    state.firstRow = document.querySelector('[data-cell="4:0"]')
    state.grid.scrollTop = 100
    state.scrollTop = state.grid.scrollTop
  })
  await size(page).selectOption('25')
  await expect(grid(page).getByRole('rowheader')).toHaveCount(25)
  await expect(row(page, 4)).toHaveAttribute('aria-selected', 'true')
  await size(page).selectOption('50')
  await expect(grid(page).getByRole('rowheader')).toHaveCount(50)
  expect(await page.evaluate(() => (window as any).pageSizeTest.reads)).toEqual([{ limit: 100, offset: 0 }])

  await page.evaluate(() => { (window as any).pageSizeTest.hold = true })
  await size(page).selectOption('250')
  await expect(grid(page)).toHaveAttribute('aria-busy', 'true')
  await expect(grid(page).getByRole('rowheader')).toHaveCount(100)
  await expect(page.getByRole('button', { name: 'Add row' })).toBeDisabled()
  await expect(page.locator('.table-loading')).toHaveCount(0)
  await expect(page.locator('.table-status-activity')).toHaveText('Loading rows…')
  await expect(page.getByRole('progressbar')).toHaveCount(0)
  expect(await page.evaluate(() => {
    const state = (window as any).pageSizeTest
    return { sameGrid: state.grid === document.querySelector('.data-grid-scroll'), sameRow: state.firstRow === document.querySelector('[data-cell="4:0"]'), scrollTop: state.grid.scrollTop, before: state.scrollTop, reads: state.reads }
  })).toEqual({ sameGrid: true, sameRow: true, scrollTop: 100, before: 100, reads: [{ limit: 100, offset: 0 }, { limit: 151, offset: 99 }] })
  await page.evaluate(() => (window as any).pageSizeTest.pending.shift().resolve())
  await expect(grid(page).getByRole('rowheader')).toHaveCount(250)
  await expect(grid(page)).toHaveAttribute('aria-busy', 'false')
  await expect(page.locator('.table-status-activity')).toHaveText('')
  await expect(row(page, 4)).toHaveAttribute('aria-selected', 'true')
  await expect(row(page, 249)).toHaveText('250')
  expect(await page.evaluate(() => {
    const state = (window as any).pageSizeTest
    return state.grid === document.querySelector('.data-grid-scroll') && state.firstRow === document.querySelector('[data-cell="4:0"]') && state.grid.scrollTop === state.scrollTop
  })).toBe(true)

  await row(page, 200).click()
  await size(page).selectOption('25')
  await expect(grid(page).getByRole('rowheader')).toHaveCount(25)
  await expect(page.getByText('1 selected', { exact: true })).toHaveCount(0)
  await size(page).selectOption('250')
  await expect(grid(page).getByRole('rowheader')).toHaveCount(250)
  await expect(row(page, 200)).toHaveAttribute('aria-selected', 'false')
  expect(await page.evaluate(() => (window as any).pageSizeTest.reads)).toHaveLength(2)
})

test('preserves the current page start and guards unsaved edits', async ({ page }) => {
  await size(page).selectOption('25')
  await page.getByRole('button', { name: 'Next page' }).click()
  await expect(row(page, 0)).toHaveText('26')
  await row(page, 0).dblclick()
  await page.getByRole('textbox', { name: 'Edit id' }).fill('999')
  await page.keyboard.press('Enter')
  await size(page).selectOption('50')
  await expect(page.getByRole('dialog', { name: 'Unsaved changes' })).toBeVisible()
  await page.getByRole('button', { name: 'Keep editing' }).click()
  await expect(size(page)).toHaveValue('25')
  await expect(row(page, 0)).toHaveText('999')
  await size(page).selectOption('50')
  await page.getByRole('button', { name: 'Discard and continue' }).click()
  await expect(row(page, 0)).toHaveText('26')
  await expect(row(page, 49)).toHaveText('75')
  await expect(page.getByText('26–75 of 600 rows')).toBeVisible()
  expect(await page.evaluate(() => (window as any).pageSizeTest.reads)).toEqual([{ limit: 100, offset: 0 }, { limit: 25, offset: 25 }, { limit: 26, offset: 49 }])
  await page.getByRole('button', { name: 'Next page' }).click()
  await expect(row(page, 0)).toHaveText('76')
  await page.getByRole('button', { name: 'End page' }).click()
  await expect(row(page, 0)).toHaveText('576')
  await page.getByRole('button', { name: 'Previous page' }).click()
  await expect(row(page, 0)).toHaveText('526')
})

test('ignores superseded reads and restores the previous size after an error', async ({ page }) => {
  await size(page).selectOption('25')
  await page.evaluate(() => { (window as any).pageSizeTest.hold = true })
  await size(page).selectOption('250')
  await expect.poll(() => page.evaluate(() => (window as any).pageSizeTest.pending.length)).toBe(1)
  await size(page).selectOption('500')
  await expect.poll(() => page.evaluate(() => (window as any).pageSizeTest.pending.length)).toBe(2)
  await page.evaluate(() => (window as any).pageSizeTest.pending[1].resolve())
  await expect(grid(page).getByRole('rowheader')).toHaveCount(500)
  await page.evaluate(() => (window as any).pageSizeTest.pending[0].resolve())
  await expect(size(page)).toHaveValue('500')
  await expect(grid(page).getByRole('rowheader')).toHaveCount(500)
  await size(page).selectOption('25')
  await expect(grid(page).getByRole('rowheader')).toHaveCount(25)
  // A new page has a smaller cache, allowing the failure path to be tested.
  await page.evaluate(() => { (window as any).pageSizeTest.hold = false })
  await page.getByRole('button', { name: 'Next page' }).click()
  await expect(row(page, 0)).toHaveText('26')
  await page.evaluate(() => { const state = (window as any).pageSizeTest; state.pending = []; state.hold = true })
  await size(page).selectOption('50')
  await expect(grid(page)).toHaveAttribute('aria-busy', 'true')
  await page.evaluate(() => (window as any).pageSizeTest.pending.shift().reject(new Error('Read failed')))
  await expect(page.getByText('Read failed')).toBeVisible()
  await expect(size(page)).toHaveValue('25')
  await expect(row(page, 0)).toHaveText('26')
  await expect(grid(page)).toHaveAttribute('aria-busy', 'false')
  await size(page).selectOption('50')
  await page.evaluate(() => (window as any).pageSizeTest.pending.shift().resolve())
  await expect(row(page, 49)).toHaveText('75')
})

test('saving a draft before changing the size loads the saved values', async ({ page }) => {
  await size(page).selectOption('25')
  await row(page, 0).dblclick()
  await page.getByRole('textbox', { name: 'Edit id' }).fill('999')
  await page.keyboard.press('Enter')
  await size(page).selectOption('50')
  await page.getByRole('button', { name: 'Save and continue' }).click()
  await expect(size(page)).toHaveValue('50')
  await expect(row(page, 0)).toHaveText('999')
  await expect(grid(page).getByRole('rowheader')).toHaveCount(50)
  await expect(page.getByRole('button', { name: 'Save changes', exact: true })).toHaveCount(0)
})

test('reloads the page if another change shifts the cached boundary', async ({ page }) => {
  await row(page, 0).click()
  await page.evaluate(() => { (window as any).pageSizeTest.rows.unshift('new') })
  await size(page).selectOption('250')
  await expect(row(page, 0)).toHaveText('new')
  await expect(row(page, 249)).toHaveText('249')
  await expect(row(page, 0)).toHaveAttribute('aria-selected', 'false')
  expect(await page.evaluate(() => (window as any).pageSizeTest.reads)).toEqual([{ limit: 100, offset: 0 }, { limit: 151, offset: 99 }, { limit: 250, offset: 0 }])
})

test('does not apply a pending resize after switching tables', async ({ page }) => {
  await page.evaluate(() => { (window as any).pageSizeTest.hold = true })
  await size(page).selectOption('250')
  await expect.poll(() => page.evaluate(() => (window as any).pageSizeTest.pending.length)).toBe(1)
  await page.evaluate(() => { (window as any).pageSizeTest.hold = false })
  await page.getByRole('button', { name: 'Open other table' }).click()
  await expect(page.getByRole('grid', { name: 'public.other data' })).toBeVisible()
  await expect(row(page, 0)).toHaveText('other')
  await page.evaluate(() => (window as any).pageSizeTest.pending.shift().resolve())
  await expect(page.getByRole('grid', { name: 'public.other data' }).getByRole('rowheader')).toHaveCount(1)
  await expect(row(page, 0)).toHaveText('other')
})
