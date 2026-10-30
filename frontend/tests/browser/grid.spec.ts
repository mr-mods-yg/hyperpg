import { expect, test, type Page } from '@playwright/test'

// Replace only the desktop IPC boundary. The real App, grid, focus handling,
// browser selection and clipboard run unchanged in Chromium.
const postgresFixture = `
const columns = [
  { name: 'id', dataType: 'bigint', nullable: false, hasDefault: true, generated: true, autoIncrement: true },
  { name: 'name', dataType: 'text', nullable: false, hasDefault: false, generated: false },
  { name: 'note', dataType: 'text', nullable: true, hasDefault: false, generated: false },
  { name: 'active', dataType: 'boolean', nullable: true, hasDefault: true, generated: false },
];
const state = window.gridTestState = {
  rows: Array.from({ length: 30 }, (_, i) => [String(i + 1), i === 0 ? 'alpha' : i === 1 ? 'beta' : 'row ' + (i + 1), i === 0 ? 'hello, "world"\\nline' : null, i !== 0]),
  saves: [], failSave: false,
};
const connection = { id: 'test', name: 'Test database', host: 'localhost', database: 'test', username: 'test', showAllDatabases: false };
export async function ListSavedConnections() { return [connection]; }
export async function OpenSavedConnection() { return connection; }
export async function ListDatabases() { return ['test']; }
export async function OpenDatabase() { return 'test'; }
export async function ListTables() { return ['items', 'other', 'empty'].map(name => ({ schema: 'public', name })); }
export async function GetTableData(_id, _schema, table, limit, offset) {
  const rows = table === 'empty' ? [] : state.rows;
  const page = rows.slice(offset, offset + limit);
  return { columns, rows: structuredClone(page), rowCount: rows.length,
    identities: page.map(row => ({ tableOID: '123', ctid: '(0,' + row[0] + ')', version: '42' })) };
}
export async function SaveTableChanges(_id, _schema, _table, changes) {
  state.saves.push(structuredClone(changes));
  await new Promise(resolve => setTimeout(resolve, 30));
  if (state.failSave) throw new Error('Constraint failed; no changes were saved.');
  for (const change of changes) {
    const index = state.rows.findIndex(row => '(0,' + row[0] + ')' === change.identity?.ctid);
    if (change.kind === 'delete') state.rows.splice(index, 1);
    else if (change.kind === 'insert') state.rows.push([String(Math.max(0, ...state.rows.map(row => Number(row[0]))) + 1), change.values.name ?? 'default name', change.values.note ?? null, true]);
    else for (const [name, value] of Object.entries(change.values)) state.rows[index][columns.findIndex(column => column.name === name)] = value;
  }
}
export async function DeleteSavedConnection() {}
export async function Connect() { return connection; }
export async function CloseConnection() {}
`

const cell = (page: Page, row: number, column: number) => page.locator(`[data-cell="${row}:${column}"]`)
async function clipboard(page: Page) { return page.evaluate(() => navigator.clipboard.readText()) }
async function state(page: Page) { return page.evaluate(() => (window as any).gridTestState) }
async function edit(page: Page, row: number, column: number, value: string) {
  await cell(page, row, column).dblclick()
  await page.getByRole('textbox', { name: `Edit ${['id', 'name', 'note', 'active'][column]}`, exact: true }).fill(value)
  await page.keyboard.press('Enter')
}
async function contextAction(page: Page, row: number, column: number, name: string) {
  await cell(page, row, column).click({ button: 'right' })
  await page.getByRole('menuitem', { name, exact: true }).click()
}

test.beforeEach(async ({ page }) => {
  await page.route('**/bindings/changeme/postgresservice.*', route => route.fulfill({ contentType: 'text/javascript', body: postgresFixture }))
  await page.route('**/bindings/changeme/updateservice.*', route => route.fulfill({ contentType: 'text/javascript', body: 'export async function CheckForUpdates() { return { available: false, version: "dev", releaseUrl: "" } }; export async function InstallUpdate() {}' }))
  await page.goto('/')
  await page.getByRole('button', { name: 'Open items table', exact: true }).click()
  await expect(cell(page, 0, 1)).toHaveText('alpha')
})

test('drag, Shift, Ctrl and keyboard selection copy CSV through the browser clipboard', async ({ page }) => {
  const start = await cell(page, 0, 1).boundingBox()
  const end = await cell(page, 1, 2).boundingBox()
  await page.mouse.move(start!.x + start!.width / 2, start!.y + start!.height / 2)
  await page.mouse.down()
  await page.mouse.move(end!.x + end!.width / 2, end!.y + end!.height / 2, { steps: 10 })
  await page.mouse.up()
  await expect(page.getByRole('gridcell', { selected: true })).toHaveCount(4)
  await page.keyboard.press('Control+c')
  await expect.poll(() => clipboard(page)).toBe('alpha,"hello, ""world""\nline"\r\nbeta,')
  await cell(page, 0, 1).click()
  await cell(page, 1, 2).click({ modifiers: ['Shift'] })
  await expect(page.getByRole('gridcell', { selected: true })).toHaveCount(4)
  await cell(page, 0, 1).click({ button: 'right' })
  await page.getByRole('menuitem', { name: 'Copy selection as CSV' }).click()
  await expect.poll(() => clipboard(page)).toBe('alpha,"hello, ""world""\nline"\r\nbeta,')
  await cell(page, 0, 1).click()
  await cell(page, 1, 2).click({ modifiers: ['Control'] })
  await expect(page.getByRole('gridcell', { selected: true })).toHaveCount(2)
  await page.getByRole('button', { name: 'Copy CSV', exact: true }).click()
  await expect.poll(() => clipboard(page)).toBe('alpha,\r\n,')
  await cell(page, 0, 1).click()
  await page.keyboard.press('Shift+ArrowDown')
  await expect(page.getByRole('gridcell', { selected: true })).toHaveCount(2)
  await page.keyboard.press('Control+a')
  await expect(page.getByRole('gridcell', { selected: true })).toHaveCount(120)
})

test('edits stay staged, discard restores values, and save includes the active editor', async ({ page }) => {
  await edit(page, 0, 1, 'draft')
  await expect(page.getByRole('button', { name: 'Save changes', exact: true })).toBeVisible()
  expect((await state(page)).rows[0][1]).toBe('alpha')
  await page.getByRole('button', { name: 'Discard changes', exact: true }).click()
  await expect(cell(page, 0, 1)).toHaveText('alpha')
  await cell(page, 0, 1).dblclick()
  await page.getByRole('textbox', { name: 'Edit name', exact: true }).fill('saved directly')
  await page.getByRole('button', { name: 'Save changes', exact: true }).click()
  await expect(cell(page, 0, 1)).toHaveText('saved directly')
  await expect(page.getByRole('button', { name: 'Save changes', exact: true })).toHaveCount(0)
  expect((await state(page)).saves[0][0].values).toEqual({ name: 'saved directly' })
})

test('NULL/default editors do not dirty untouched cells and Escape cancels editing', async ({ page }) => {
  await cell(page, 1, 2).dblclick()
  await page.keyboard.press('Enter')
  await expect(page.getByRole('button', { name: 'Save changes', exact: true })).toHaveCount(0)
  await cell(page, 0, 1).dblclick()
  await page.getByRole('textbox', { name: 'Edit name', exact: true }).fill('cancel me')
  await page.keyboard.press('Escape')
  await expect(cell(page, 0, 1)).toHaveText('alpha')
  await expect(page.getByRole('button', { name: 'Save changes', exact: true })).toHaveCount(0)
  await cell(page, 0, 0).dblclick()
  await expect(page.getByRole('textbox', { name: 'Edit id', exact: true })).toHaveCount(0)
})

test('row context actions stage add, duplicate, multi-row delete, restore, NULL and revert', async ({ page }) => {
  await contextAction(page, 0, 2, 'Set NULL')
  await expect(cell(page, 0, 2)).toHaveText('NULL')
  await contextAction(page, 0, 2, 'Revert cell')
  await expect(cell(page, 0, 2)).toHaveText('hello, "world"\nline')
  await contextAction(page, 0, 1, 'Duplicate row')
  await expect(cell(page, 30, 0)).toHaveText('DEFAULT')
  await expect(cell(page, 30, 1)).toHaveText('alpha')
  await expect(cell(page, 30, 3)).toHaveText('false')
  await contextAction(page, 30, 1, 'Delete row')
  await expect(page.getByRole('gridcell')).toHaveCount(120)
  await cell(page, 0, 1).click()
  await cell(page, 1, 1).click({ modifiers: ['Shift'] })
  await contextAction(page, 0, 1, 'Delete 2 rows')
  await expect(page.locator('tr.is-deleted')).toHaveCount(2)
  await contextAction(page, 0, 1, 'Restore deleted rows')
  await expect(page.locator('tr.is-deleted')).toHaveCount(1)
  await page.getByRole('button', { name: 'Discard changes', exact: true }).click()
  await page.getByRole('button', { name: 'Add row', exact: true }).click()
  await edit(page, 30, 1, 'new row')
  await page.screenshot({ path: test.info().outputPath('staged-grid.png') })
  await page.getByRole('button', { name: 'Save changes', exact: true }).click()
  await expect(cell(page, 30, 1)).toHaveText('new row')
  expect((await state(page)).saves[0]).toEqual([{ kind: 'insert', identity: null, values: { name: 'new row' } }])
})

test('inserts drafts above and below the targeted cell and preserves their order', async ({ page }) => {
  await contextAction(page, 1, 1, 'Add row above')
  await expect(cell(page, 1, 1)).toHaveText('DEFAULT')
  await expect(cell(page, 1, 1)).toBeFocused()
  await expect(cell(page, 2, 1)).toHaveText('beta')
  await edit(page, 1, 1, 'first')

  await contextAction(page, 1, 1, 'Add row above')
  await edit(page, 1, 1, 'earlier')
  await contextAction(page, 2, 1, 'Add row below')
  await edit(page, 3, 1, 'later')
  await expect(cell(page, 1, 1)).toHaveText('earlier')
  await expect(cell(page, 2, 1)).toHaveText('first')
  await expect(cell(page, 3, 1)).toHaveText('later')
  await expect(cell(page, 4, 1)).toHaveText('beta')

  await contextAction(page, 2, 1, 'Delete row')
  await expect(cell(page, 1, 1)).toHaveText('earlier')
  await expect(cell(page, 2, 1)).toHaveText('later')
  await expect(cell(page, 3, 1)).toHaveText('beta')
  await page.getByRole('button', { name: 'Save changes', exact: true }).click()
  expect((await state(page)).saves[0]).toEqual([
    { kind: 'insert', identity: null, values: { name: 'earlier' } },
    { kind: 'insert', identity: null, values: { name: 'later' } },
  ])
  await expect(cell(page, 30, 1)).toHaveText('earlier')
  await expect(cell(page, 31, 1)).toHaveText('later')
})

test('inserts around the right underlying row when the page is filtered', async ({ page }) => {
  await page.getByRole('textbox', { name: 'Search this page', exact: true }).fill('beta')
  await contextAction(page, 0, 1, 'Add row above')
  await edit(page, 0, 1, 'above')
  await contextAction(page, 1, 1, 'Add row below')
  await edit(page, 2, 1, 'below')
  await expect(cell(page, 0, 1)).toHaveText('above')
  await expect(cell(page, 1, 1)).toHaveText('beta')
  await expect(cell(page, 2, 1)).toHaveText('below')
  await page.getByRole('textbox', { name: 'Search this page', exact: true }).fill('')
  await expect(cell(page, 0, 1)).toHaveText('alpha')
  await expect(cell(page, 1, 1)).toHaveText('above')
  await expect(cell(page, 2, 1)).toHaveText('beta')
  await expect(cell(page, 3, 1)).toHaveText('below')
  await page.getByRole('button', { name: 'Discard changes', exact: true }).click()
  await expect(cell(page, 1, 1)).toHaveText('beta')
})

test('inserts at the page boundaries and offers Add row for an empty table', async ({ page }) => {
  await contextAction(page, 0, 0, 'Add row above')
  await expect(cell(page, 0, 1)).toBeFocused()
  await expect(cell(page, 1, 1)).toHaveText('alpha')
  await contextAction(page, 30, 1, 'Add row below')
  await expect(cell(page, 31, 1)).toHaveText('DEFAULT')
  await expect(cell(page, 31, 1)).toBeFocused()
  await page.getByRole('button', { name: 'Discard changes', exact: true }).click()
  await page.getByRole('button', { name: 'Open empty table', exact: true }).click()
  await page.getByText('This table has no rows yet. Use Add row to create one.').click({ button: 'right' })
  const menu = page.getByRole('menu', { name: 'Cell actions' })
  await expect(menu.getByRole('menuitem', { name: 'Add row above' })).toHaveCount(0)
  await menu.getByRole('menuitem', { name: 'Add row', exact: true }).click()
  await expect(cell(page, 0, 1)).toHaveText('DEFAULT')
})

test('cell menu fits the viewport and supports keyboard navigation', async ({ page }) => {
  await page.setViewportSize({ width: 700, height: 560 })
  await cell(page, 20, 1).scrollIntoViewIfNeeded()
  await cell(page, 20, 1).click()
  await page.keyboard.press('Shift+F10')
  const menu = page.getByRole('menu', { name: 'Cell actions' })
  await expect(menu).toBeVisible()
  await expect(menu.getByRole('menuitem', { name: 'Edit cell' })).toBeFocused()
  await expect(menu.getByRole('menuitem', { name: 'Add row above' })).toBeVisible()
  await expect(menu.getByRole('menuitem', { name: 'Add row below' })).toBeVisible()
  const bounds = await menu.boundingBox()
  expect(bounds).not.toBeNull()
  expect(bounds!.x).toBeGreaterThanOrEqual(8)
  expect(bounds!.y).toBeGreaterThanOrEqual(8)
  expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(692)
  expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(552)
  await page.keyboard.press('End')
  await expect(menu.getByRole('menuitem', { name: 'Delete row', exact: true })).toBeFocused()
  await page.keyboard.press('Home')
  await expect(menu.getByRole('menuitem', { name: 'Edit cell' })).toBeFocused()
  await page.keyboard.press('Escape')
  await expect(menu).toHaveCount(0)
  await expect(cell(page, 20, 1)).toBeFocused()
  await cell(page, 20, 1).click({ button: 'right' })
  await expect(menu).toBeVisible()
  await page.locator('.data-grid-scroll').evaluate((element) => { element.scrollTop -= 100 })
  await expect(menu).toHaveCount(0)
})

test('cell menu shows the target column, row, value and draft state', async ({ page }) => {
  const menu = page.getByRole('menu', { name: 'Cell actions' })
  await cell(page, 0, 1).click({ button: 'right' })
  await expect(menu.locator('.grid-menu-cell-heading')).toHaveText('nametext')
  await expect(menu.locator('.grid-menu-cell-meta')).toContainText('Row 1')
  await expect(menu.locator('.grid-menu-cell-meta')).toContainText('Not null')
  await expect(menu.locator('.grid-menu-cell-value')).toHaveText('alpha')
  await page.keyboard.press('Escape')

  await cell(page, 1, 2).click({ button: 'right' })
  await expect(menu.locator('.grid-menu-cell-meta')).toContainText('Row 2')
  await expect(menu.locator('.grid-menu-cell-meta')).toContainText('Nullable')
  await expect(menu.locator('.grid-menu-cell-value')).toHaveText('NULL')
  await page.keyboard.press('Escape')

  await cell(page, 0, 0).click({ button: 'right' })
  await expect(menu.locator('.grid-menu-cell-meta')).toContainText('Generated')
  await expect(menu.getByRole('menuitem', { name: 'Edit cell' })).toBeDisabled()
  await page.keyboard.press('Escape')

  await edit(page, 0, 1, '')
  await cell(page, 0, 1).click({ button: 'right' })
  await expect(menu.locator('.grid-menu-cell-meta')).toContainText('Edited')
  await expect(menu.locator('.grid-menu-cell-value')).toHaveText('Empty string')
  await expect(menu.locator('.grid-menu-cell-value')).toHaveClass(/is-placeholder/)
  await menu.getByRole('menuitem', { name: 'Add row above' }).click()
  await cell(page, 0, 1).click({ button: 'right' })
  await expect(menu.locator('.grid-menu-cell-meta')).toContainText('New row')
  await expect(menu.locator('.grid-menu-cell-value')).toHaveText('DEFAULT')
})

test('navigation offers keep, discard and save; failures preserve the draft', async ({ page }) => {
  await edit(page, 0, 1, 'pending')
  await page.getByRole('button', { name: 'Open other table', exact: true }).click()
  await expect(page.getByRole('dialog', { name: 'Unsaved changes' })).toBeVisible()
  await page.getByRole('button', { name: 'Keep editing' }).click()
  await expect(cell(page, 0, 1)).toHaveText('pending')
  await page.getByRole('button', { name: 'Refresh', exact: true }).click()
  await page.getByRole('button', { name: 'Discard and continue' }).click()
  await expect(cell(page, 0, 1)).toHaveText('alpha')
  await edit(page, 0, 1, 'save and go')
  await page.getByRole('tab', { name: 'Structure', exact: true }).click()
  await page.getByRole('button', { name: 'Save and continue' }).click()
  await expect(page.getByRole('tab', { name: 'Structure', exact: true })).toHaveAttribute('aria-selected', 'true')
  expect((await state(page)).rows[0][1]).toBe('save and go')
  await page.getByRole('tab', { name: 'Data', exact: true }).click()
  await page.evaluate(() => { (window as any).gridTestState.failSave = true })
  await edit(page, 0, 1, 'retained draft')
  await page.getByRole('button', { name: 'Save changes', exact: true }).click()
  await expect(page.getByRole('alert')).toContainText('Constraint failed')
  await expect(cell(page, 0, 1)).toHaveText('retained draft')
  expect((await state(page)).rows[0][1]).toBe('save and go')
  await page.getByRole('tab', { name: 'Structure', exact: true }).click()
  await page.getByRole('button', { name: 'Save and continue' }).click()
  await expect(page.getByRole('dialog', { name: 'Unsaved changes' })).toHaveCount(0)
  await expect(page.getByRole('tab', { name: 'Data', exact: true })).toHaveAttribute('aria-selected', 'true')
  await expect(cell(page, 0, 1)).toHaveText('retained draft')
})

test('search, empty tables and pagination keep selections and drafts tied to the right rows', async ({ page }) => {
  await page.getByRole('textbox', { name: 'Search this page', exact: true }).fill('beta')
  await edit(page, 0, 1, 'filtered edit')
  await page.getByRole('button', { name: 'Save changes', exact: true }).click()
  expect((await state(page)).saves[0][0].identity.ctid).toBe('(0,2)')
  await page.getByRole('textbox', { name: 'Search this page', exact: true }).fill('')
  await page.getByRole('combobox', { name: 'Rows per page', exact: true }).selectOption('25')
  await edit(page, 0, 1, 'page draft')
  await page.getByRole('button', { name: 'Next page', exact: true }).click()
  await page.getByRole('button', { name: 'Discard and continue' }).click()
  await expect(cell(page, 0, 0)).toHaveText('26')
  await page.getByRole('button', { name: 'Open empty table', exact: true }).click()
  await expect(page.getByText('This table has no rows yet. Use Add row to create one.')).toBeVisible()
  await page.getByRole('button', { name: 'Add row', exact: true }).click()
  await expect(cell(page, 0, 1)).toHaveText('DEFAULT')
  await expect(page.getByRole('button', { name: 'Save changes', exact: true })).toBeVisible()
})

test('row headers preserve a multi-row context selection and saving deletes clamps the final page', async ({ page }) => {
  await page.getByRole('combobox', { name: 'Rows per page', exact: true }).selectOption('25')
  await page.getByRole('button', { name: 'Next page', exact: true }).click()
  const headers = page.getByRole('rowheader')
  await headers.nth(0).click()
  await headers.nth(3).click({ modifiers: ['Shift'] })
  await headers.nth(2).click({ button: 'right' })
  await expect(page.getByRole('gridcell', { selected: true })).toHaveCount(16)
  await page.getByRole('menuitem', { name: 'Delete 4 rows', exact: true }).click()
  await contextAction(page, 4, 1, 'Delete row')
  await expect(page.locator('tr.is-deleted')).toHaveCount(5)
  await page.getByRole('button', { name: 'Save changes', exact: true }).click()
  await expect(cell(page, 0, 0)).toHaveText('1')
  await expect(page.getByRole('button', { name: 'Next page', exact: true })).toBeDisabled()
  expect((await state(page)).rows).toHaveLength(25)
})
