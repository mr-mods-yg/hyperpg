import { expect, test, type Page } from '@playwright/test'

// Grid keyboard editing, clipboard, export and sidebar tree behaviour against
// mocked desktop bindings; the real App and components run in Chromium.
const fixture = `
const columns = [
  { name: 'id', dataType: 'bigint', nullable: false, hasDefault: true, generated: true, autoIncrement: true, identityGeneration: 'ALWAYS' },
  { name: 'name', dataType: 'text', nullable: false, hasDefault: false, generated: false },
  { name: 'note', dataType: 'text', nullable: true, hasDefault: false, generated: false },
  { name: 'amount', dataType: 'numeric(10,2)', nullable: true, hasDefault: false, generated: false },
];
const state = window.editState = {
  rows: Array.from({ length: 40 }, (_, i) => [String(i + 1), i === 0 ? 'alpha' : 'row ' + (i + 1), i === 0 ? 'a "quoted", note' : 'note ' + (i + 1), String((i + 1) * 1.5)]),
  saves: [], files: [], queries: [], copied: [], holdReads: false, reads: [],
};
const connection = { id: 'test', name: 'Test database', host: 'localhost', database: 'test', username: 'test', showAllDatabases: false };
const second = { id: 'second', name: 'Second server', host: 'db2', database: 'test', username: 'test', showAllDatabases: false };
export async function ListSavedConnections() { return [connection, second]; }
export async function OpenSavedConnection(id) { return id === 'second' ? second : connection; }
export async function ListDatabases() { return ['test']; }
export async function OpenDatabase() { return 'test'; }
export async function ListTables() { return ['items', 'other'].map(name => ({ schema: 'public', name })); }
function page(limit, offset) {
  const page = state.rows.slice(offset, offset + limit);
  return { columns, rows: structuredClone(page), rowCount: state.rows.length,
    identities: page.map(row => ({ tableOID: '1', ctid: '(0,' + row[0] + ')', version: '1' })) };
}
export async function GetTableData(_id, _schema, _table, limit, offset) {
  if (state.holdReads) await new Promise(resolve => state.reads.push(resolve));
  return page(limit, offset);
}
export async function GetFilteredTableData(_id, _schema, _table, limit, offset, options) { state.queries.push(options); return page(limit, offset); }
export async function SaveTableChanges(_id, _schema, _table, changes) {
  state.saves.push(structuredClone(changes));
  for (const change of changes) {
    const row = state.rows.find(row => '(0,' + row[0] + ')' === change.identity?.ctid);
    if (change.kind === 'update') for (const [name, value] of Object.entries(change.values)) row[columns.findIndex(column => column.name === name)] = value;
  }
}
export async function ChooseExportPath(name) { return '/exports/' + name; }
export async function WriteExportFile(path, contents) { state.files.push({ path, contents }); }
export async function ExportTableData() {}
export async function GetTableMetadata() { return { constraints: [], indexes: [{ name: 'items_pkey', definition: 'CREATE UNIQUE INDEX items_pkey ON public.items (id)' }], ddl: 'CREATE TABLE public.items (id bigint);' }; }
export async function GenerateTableSQL() { return 'SELECT 1;'; }
export async function DeleteSavedConnection() {}
export async function CloseConnection() {}
`

const cell = (page: Page, row: number, column: number) => page.locator(`[data-cell="${row}:${column}"]`)
const state = (page: Page) => page.evaluate(() => (window as any).editState)
const clipboard = (page: Page) => page.evaluate(() => navigator.clipboard.readText())
const feedback = (page: Page) => page.locator('.grid-feedback')

test.beforeEach(async ({ page }) => {
  await page.route('**/bindings/changeme/internal/database/postgresservice.*', route => route.fulfill({ contentType: 'text/javascript', body: fixture }))
  await page.route('**/bindings/changeme/internal/updates/updateservice.*', route => route.fulfill({ contentType: 'text/javascript', body: 'export async function CheckForUpdates() { return { available: false, version: "dev", releaseUrl: "" } }; export async function InstallUpdate() {}' }))
  await page.goto('/')
  await page.getByRole('treeitem', { name: 'items', exact: true }).click()
  await expect(cell(page, 0, 1)).toHaveText('alpha')
})

test('typing into a cell keeps the first character', async ({ page }) => {
  await cell(page, 0, 1).click()
  await page.keyboard.type('Renamed')
  const editor = page.getByRole('textbox', { name: 'Edit name', exact: true })
  await expect(editor).toHaveValue('Renamed')
  await page.keyboard.press('Enter')
  await expect(cell(page, 0, 1)).toHaveText('Renamed')
  // Backspace starts an empty edit; double-click and Enter select the value for replacement.
  await page.keyboard.press('Backspace')
  await expect(editor).toHaveValue('')
  await page.keyboard.press('Escape')
  await cell(page, 1, 1).dblclick()
  await page.keyboard.type('x')
  await expect(editor).toHaveValue('x')
  await page.keyboard.press('Escape')
  await page.getByRole('button', { name: 'Save changes', exact: true }).click()
  await expect.poll(async () => (await state(page)).saves[0]?.[0].values).toEqual({ name: 'Renamed' })
})

test('the floating editor does not change the row height', async ({ page }) => {
  const before = (await cell(page, 0, 2).boundingBox())!
  await cell(page, 0, 2).dblclick()
  const editor = page.getByRole('textbox', { name: 'Edit note', exact: true })
  await editor.fill('A long value\nthat spans\nseveral lines of text to edit comfortably')
  const after = (await cell(page, 0, 2).boundingBox())!
  expect(after.height).toBe(before.height)
  expect((await editor.boundingBox())!.height).toBeGreaterThan(before.height * 2)
  await page.keyboard.press('Escape')
})

test('single cells copy raw values; ranges copy CSV without headers unless asked', async ({ page }) => {
  await cell(page, 0, 2).click()
  await page.keyboard.press('Control+c')
  await expect.poll(() => clipboard(page)).toBe('a "quoted", note')
  await expect(feedback(page)).toHaveText('Copied the cell value.')
  await page.keyboard.press('Shift+ArrowRight')
  await page.keyboard.press('Control+c')
  await expect.poll(() => clipboard(page)).toBe('"a ""quoted"", note",1.5')
  await cell(page, 0, 2).click({ button: 'right' })
  await page.getByRole('menuitem', { name: 'Copy with headers', exact: true }).click()
  await expect.poll(() => clipboard(page)).toBe('note,amount\r\n"a ""quoted"", note",1.5')
  await expect(feedback(page)).toHaveText('Copied 2 cells as CSV with column headers.')
})

test('Delete sets nullable cells to NULL, explains skipped cells, and undo restores them', async ({ page }) => {
  await cell(page, 0, 1).click()
  await cell(page, 0, 3).click({ modifiers: ['Shift'] })
  await page.keyboard.press('Delete')
  await expect(cell(page, 0, 2)).toHaveText('NULL')
  await expect(cell(page, 0, 3)).toHaveText('NULL')
  await expect(cell(page, 0, 1)).toHaveText('alpha')
  await expect(feedback(page)).toHaveText('Set 2 cells to NULL. 1 cell skipped: not nullable or read-only.')
  await page.keyboard.press('Control+z')
  await expect(cell(page, 0, 2)).toHaveText('a "quoted", note')
  await expect(page.getByRole('button', { name: 'Save changes', exact: true })).toHaveCount(0)
  await page.keyboard.press('Control+Shift+z')
  await expect(cell(page, 0, 2)).toHaveText('NULL')
  // Whole selected rows are marked for deletion instead.
  await page.getByRole('rowheader').nth(2).click()
  await page.keyboard.press('Delete')
  await expect(page.locator('tr.is-deleted')).toHaveCount(1)
})

test('read-only cells explain why they cannot be edited', async ({ page }) => {
  await cell(page, 0, 0).dblclick()
  await expect(page.getByRole('textbox', { name: 'Edit id', exact: true })).toHaveCount(0)
  await expect(feedback(page)).toHaveText('id is an identity column (GENERATED ALWAYS) and can’t be edited.')
  await expect(cell(page, 0, 0)).toHaveAttribute('aria-label', 'Row 1, id: 1')
})

test('Home, End, Ctrl+Home, Ctrl+End and PageDown move the active cell', async ({ page }) => {
  await cell(page, 2, 1).click()
  await page.keyboard.press('End')
  await expect(cell(page, 2, 3)).toBeFocused()
  await page.keyboard.press('Home')
  await expect(cell(page, 2, 0)).toBeFocused()
  await page.keyboard.press('Control+End')
  await expect(cell(page, 39, 3)).toBeFocused()
  await page.keyboard.press('Control+Home')
  await expect(cell(page, 0, 0)).toBeFocused()
  await page.keyboard.press('PageDown')
  const focused = await page.evaluate(() => document.activeElement?.getAttribute('data-cell'))
  expect(Number(focused!.split(':')[0])).toBeGreaterThan(3)
})

test('discard can be undone from the feedback line', async ({ page }) => {
  await cell(page, 0, 1).click()
  await page.keyboard.type('one')
  await page.keyboard.press('Enter')
  await cell(page, 1, 1).click()
  await page.keyboard.type('two')
  await page.keyboard.press('Enter')
  await expect(page.getByText('2 unsaved row changes')).toBeVisible()
  await page.getByRole('button', { name: 'Discard changes', exact: true }).click()
  await expect(cell(page, 0, 1)).toHaveText('alpha')
  await expect(feedback(page)).toHaveText('Discarded 2 changes.')
  await page.getByRole('button', { name: 'Undo', exact: true }).click()
  await expect(cell(page, 0, 1)).toHaveText('one')
  await expect(cell(page, 1, 1)).toHaveText('two')
})

test('numeric columns are right aligned and sort cycles through ascending, descending and none', async ({ page }) => {
  await expect(cell(page, 0, 3)).toHaveClass(/is-numeric/)
  await expect(cell(page, 0, 3)).toHaveCSS('text-align', 'right')
  await expect(cell(page, 0, 1)).not.toHaveClass(/is-numeric/)
  const header = page.getByRole('columnheader').filter({ has: page.getByRole('button', { name: 'Sort by name', exact: true }) })
  await page.getByRole('button', { name: 'Sort by name', exact: true }).click()
  await expect(header).toHaveAttribute('aria-sort', 'ascending')
  await expect(header.locator('.column-sort-icon')).toBeVisible()
})

test('export uses saved values while edits are pending and reports success', async ({ page }) => {
  await cell(page, 0, 1).click()
  await page.keyboard.type('draft')
  await page.keyboard.press('Enter')
  await page.locator('.export-menu summary').click()
  await expect(page.locator('.export-note')).toContainText('Unsaved edits')
  await page.getByRole('button', { name: 'Save file', exact: true }).click()
  await expect.poll(async () => (await state(page)).files[0]?.contents.split('\r\n')[1]).toBe('1,alpha,"a ""quoted"", note",1.5')
  await expect(feedback(page)).toHaveText('Exported 40 rows to items.csv.')
})

test('filters close with Escape, validate empty values and focus new conditions', async ({ page }) => {
  const toggle = page.getByRole('button', { name: 'Filters', exact: true })
  await toggle.click()
  await page.getByRole('button', { name: 'Add condition' }).click()
  await expect(page.getByLabel('Filter 1 column')).toBeFocused()
  // Icon-only buttons are named and titled, and draw an icon rather than a glyph.
  for (const [name, title] of [['Remove filter 1', 'Remove condition'], ['Close filters', 'Close filters (Esc)']]) {
    const button = page.getByRole('button', { name, exact: true })
    await expect(button).toHaveAttribute('title', title)
    await expect(button.locator('svg.ui-icon')).toHaveCount(1)
    await expect(button).toHaveText('')
  }
  await page.getByRole('button', { name: 'Apply', exact: true }).click()
  await expect(page.getByLabel('Filter 1 value')).toBeFocused()
  await expect(page.getByLabel('Filter 1 value')).toHaveAttribute('aria-invalid', 'true')
  await expect(page.getByText('Enter a value, or choose Is NULL / Is not NULL.')).toBeVisible()
  expect((await state(page)).queries).toHaveLength(0)
  await page.keyboard.press('Escape')
  await expect(page.locator('.filter-panel')).toHaveCount(0)
  await expect(toggle).toBeFocused()
  await toggle.click()
  await page.getByLabel('Filter 1 value').fill('alpha')
  await page.getByRole('button', { name: 'Apply', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Filters · 1', exact: true })).toBeVisible()
  const clear = page.getByRole('button', { name: 'Clear filters', exact: true })
  await expect(clear).toHaveAttribute('title', 'Clear filters')
  await expect(clear.locator('svg.ui-icon')).toHaveCount(1)
  await clear.click()
  await expect(page.getByRole('button', { name: 'Filters', exact: true })).toBeVisible()
})

test('the connection tree is one Tab stop with arrow-key navigation', async ({ page }) => {
  const tree = page.getByRole('tree', { name: 'Connections' })
  await expect(tree.locator('[role="treeitem"][tabindex="0"]')).toHaveCount(1)
  await expect(tree.getByRole('treeitem', { name: 'items', exact: true })).toHaveAttribute('aria-selected', 'true')
  await tree.getByRole('treeitem', { name: 'items', exact: true }).focus()
  await page.keyboard.press('ArrowDown')
  await expect(tree.getByRole('treeitem', { name: 'other', exact: true })).toBeFocused()
  await page.keyboard.press('ArrowLeft')
  await expect(tree.getByRole('treeitem', { name: 'public', exact: true })).toBeFocused()
  await page.keyboard.press('ArrowLeft')
  await expect(tree.getByRole('treeitem', { name: 'public', exact: true })).toHaveAttribute('aria-expanded', 'false')
  await page.keyboard.press('ArrowRight')
  await expect(tree.getByRole('treeitem', { name: 'public', exact: true })).toHaveAttribute('aria-expanded', 'true')
  await page.keyboard.press('Home')
  await expect(tree.getByRole('treeitem', { name: 'Test database', exact: true })).toBeFocused()
  await page.keyboard.press('End')
  await expect(tree.getByRole('treeitem', { name: 'Second server', exact: true })).toBeFocused()
  await page.keyboard.press('t')
  await expect(tree.getByRole('treeitem', { name: 'Test database', exact: true })).toBeFocused()
  await expect(tree.locator('[role="treeitem"][tabindex="0"]')).toHaveCount(1)
  await page.keyboard.press('Delete')
  const dialog = page.getByRole('alertdialog', { name: 'Delete “Test database”?' })
  await expect(dialog.getByRole('button', { name: 'Cancel', exact: true })).toBeFocused()
  await page.keyboard.press('Escape')
  await expect(dialog).toHaveCount(0)
  await expect(tree.getByRole('treeitem', { name: 'Test database', exact: true })).toBeFocused()
  await page.getByRole('treeitem', { name: 'other', exact: true }).focus()
  await page.keyboard.press('Enter')
  await expect(page.getByRole('tab', { name: /^other(, unsaved changes)?$/ })).toHaveAttribute('aria-selected', 'true')
})

test('structure details are not clipped and DDL can be copied', async ({ page }) => {
  await page.getByRole('tab', { name: 'Structure', exact: true }).click()
  const indexes = page.getByRole('table', { name: 'Indexes' })
  await expect(indexes.getByRole('columnheader', { name: 'Definition' })).toBeVisible()
  const details = page.locator('.table-details')
  expect(await details.evaluate((element) => element.scrollHeight <= element.clientHeight + 1)).toBe(true)
  await page.getByText('DDL', { exact: true }).click()
  await page.getByRole('button', { name: 'Copy', exact: true }).click()
  await expect.poll(() => clipboard(page)).toBe('CREATE TABLE public.items (id bigint);')
  await expect(page.getByRole('button', { name: 'Copied', exact: true })).toBeVisible()
})
