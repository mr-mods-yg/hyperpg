import { expect, test, type Page } from '@playwright/test'

// Replace the desktop IPC boundary. The Excel functions are optional so the
// menu item can be checked against builds that do not provide them.
const postgresFixture = (withExcel: boolean) => `
const connections = [
  { id: 'primary', name: 'Development', host: 'localhost', database: 'app', username: 'postgres', showAllDatabases: false },
];
const state = window.excelTestState = { exports: [], cancels: [], listed: [], progressCalls: 0, pending: null };
export async function ListSavedConnections() { return structuredClone(connections); }
export async function OpenSavedConnection(id) { return structuredClone(connections.find(item => item.id === id)); }
export async function ListDatabases(id) { return ['app']; }
export async function OpenDatabase(id, database) { return id; }
export async function ListTables() { return [{ schema: 'audit', name: 'items' }, { schema: 'public', name: 'orders' }, { schema: 'public', name: 'users' }]; }
export async function GetTableData() { return { columns: [], rows: [], rowCount: 0, identities: [] }; }
export async function CloseConnection() {}
${withExcel ? `
export async function ListExcelExportTables(id, database) {
  state.listed.push([id, database]);
  return [
    { schema: 'audit', name: 'items', kind: 'table', estimatedRows: 12, readable: true },
    { schema: 'public', name: 'orders', kind: 'table', estimatedRows: 45000, readable: true },
    { schema: 'public', name: 'recent_orders', kind: 'view', estimatedRows: -1, readable: true },
    { schema: 'public', name: 'secrets', kind: 'table', estimatedRows: 3, readable: false },
    { schema: 'public', name: 'users', kind: 'table', estimatedRows: 2, readable: true },
  ];
}
export function ExportDatabaseToExcel(id, database, options) {
  state.exports.push(structuredClone([id, database, options]));
  return new Promise((resolve, reject) => { state.pending = resolve; state.fail = reject; });
}
export async function GetExcelExportProgress(exportId) {
  state.progressCalls++;
  return { active: true, phase: 'exporting', tableIndex: 2, tableCount: 2, schema: 'public', table: 'orders', tableRows: 45000, totalRows: 45012 };
}
export async function CancelExcelExport(exportId) {
  state.cancels.push(exportId);
  state.pending?.({ path: '', sheets: [], totalRows: 0, warnings: [], cancelled: true });
  return true;
}` : ''}
`

const tree = (page: Page) => page.getByRole('navigation', { name: 'Connections', exact: true })
const databaseNode = (page: Page) => tree(page).getByRole('group', { name: 'Databases in Development', exact: true }).getByRole('treeitem', { name: 'app', exact: true })
const exportDialog = (page: Page) => page.getByRole('dialog', { name: /Export to Excel|Export complete/ })
const state = (page: Page) => page.evaluate(() => (window as any).excelTestState)
const finishExport = (page: Page, result: object) => page.evaluate((value) => (window as any).excelTestState.pending(value), result)

async function load(page: Page, withExcel = true) {
  await page.route('**/bindings/changeme/internal/database/postgresservice.*', route => route.fulfill({ contentType: 'text/javascript', body: postgresFixture(withExcel) }))
  await page.route('**/bindings/changeme/internal/updates/updateservice.*', route => route.fulfill({ contentType: 'text/javascript', body: 'export async function CheckForUpdates() { return { available: false, version: "dev", releaseUrl: "" } }; export async function InstallUpdate() {}' }))
  await page.goto('/')
  await expect(databaseNode(page)).toBeVisible()
}

async function openExportDialog(page: Page) {
  await databaseNode(page).click({ button: 'right' })
  const menu = page.getByRole('menu', { name: 'Actions for app' })
  await expect(menu.getByRole('menuitem', { name: 'Open database' })).toBeVisible()
  await menu.getByRole('menuitem', { name: 'Export to Excel…' }).click()
  const dialog = exportDialog(page)
  await expect(dialog.getByRole('checkbox', { name: 'orders' })).toBeVisible()
  return dialog
}

test('exports the selected tables of a database to Excel', async ({ page }) => {
  await load(page)
  const dialog = await openExportDialog(page)
  // React's development mode may run the loading effect twice.
  expect(new Set((await state(page)).listed.map(String))).toEqual(new Set(['primary,app']))

  // Base tables start selected; views are hidden until requested and tables
  // the role cannot read are disabled.
  for (const name of ['items', 'orders', 'users']) await expect(dialog.getByRole('checkbox', { name, exact: true })).toBeChecked()
  await expect(dialog.getByRole('checkbox', { name: 'recent_orders' })).toHaveCount(0)
  await expect(dialog.getByRole('checkbox', { name: 'secrets' })).toBeDisabled()
  await expect(dialog.getByText('3 tables of 3 selected')).toBeVisible()

  await dialog.getByRole('checkbox', { name: 'users', exact: true }).uncheck()
  await expect(dialog.getByRole('checkbox', { name: 'All tables in public' })).not.toBeChecked()
  await dialog.getByRole('checkbox', { name: 'Include views' }).check()
  await expect(dialog.getByRole('checkbox', { name: 'recent_orders' })).toBeChecked()
  await dialog.getByRole('checkbox', { name: 'Include views' }).uncheck()
  await expect(dialog.getByRole('checkbox', { name: 'recent_orders' })).toHaveCount(0)

  await dialog.getByRole('button', { name: 'Export 2 tables…' }).click()
  await expect(dialog.getByRole('status').filter({ hasText: 'Exporting table 2 of 2: orders, 45,000 rows' })).toBeVisible()
  await expect(dialog.getByRole('progressbar', { name: 'Export progress' })).toHaveAttribute('aria-valuenow', '50')
  const [[connectionId, database, options]] = (await state(page)).exports
  expect([connectionId, database]).toEqual(['primary', 'app'])
  expect(options.includeViews).toBe(false)
  expect(options.exportId).toBeTruthy()
  expect(options.tables).toEqual([{ schema: 'audit', name: 'items' }, { schema: 'public', name: 'orders' }])

  await finishExport(page, {
    path: '/home/me/app.xlsx', totalRows: 45012, cancelled: false,
    sheets: [{ sheet: 'items', schema: 'audit', table: 'items', kind: 'table', rows: 12, rowsTruncated: false, truncatedCells: 0 },
      { sheet: 'orders', schema: 'public', table: 'orders', kind: 'table', rows: 45000, rowsTruncated: false, truncatedCells: 2 }],
    warnings: ['public.orders: 2 values longer than 32,767 characters were shortened.'],
  })
  await expect(dialog.getByRole('heading', { name: 'Export complete' })).toBeVisible()
  await expect(dialog.getByText('2 sheets, 45,012 rows')).toBeVisible()
  await expect(dialog.getByText('/home/me/app.xlsx')).toBeVisible()
  await expect(dialog.getByRole('note', { name: 'Export warnings' })).toContainText('2 values longer than 32,767 characters')
  await dialog.getByRole('button', { name: 'Done' }).click()
  await expect(exportDialog(page)).toHaveCount(0)
  await expect(databaseNode(page)).toBeFocused()
})

test('the database menu opens from the keyboard and Cancel stops a running export', async ({ page }) => {
  await load(page)
  await databaseNode(page).focus()
  await page.keyboard.press('Shift+F10')
  const menu = page.getByRole('menu', { name: 'Actions for app' })
  await expect(menu.getByRole('menuitem', { name: 'Open database' })).toBeFocused()
  await page.keyboard.press('ArrowDown')
  await expect(menu.getByRole('menuitem', { name: 'Export to Excel…' })).toBeFocused()
  await page.keyboard.press('Enter')
  const dialog = exportDialog(page)
  await dialog.getByRole('button', { name: 'Select none' }).click()
  await expect(dialog.getByRole('button', { name: /^Export/ })).toBeDisabled()
  await dialog.getByRole('button', { name: 'Select all' }).click()
  await dialog.getByRole('button', { name: 'Export 3 tables…' }).click()
  await dialog.getByRole('button', { name: 'Cancel export' }).click()
  await expect(dialog.getByText('Export cancelled. No file was saved.')).toBeVisible()
  expect((await state(page)).cancels).toHaveLength(1)
  await page.keyboard.press('Escape')
  await expect(exportDialog(page)).toHaveCount(0)
})

test('dismissing the save dialog closes the export dialog quietly, and errors are shown', async ({ page }) => {
  await load(page)
  let dialog = await openExportDialog(page)
  await dialog.getByRole('button', { name: 'Export 3 tables…' }).click()
  await finishExport(page, { path: '', sheets: [], totalRows: 0, warnings: [], cancelled: false })
  await expect(exportDialog(page)).toHaveCount(0)

  dialog = await openExportDialog(page)
  await dialog.getByRole('button', { name: 'Export 3 tables…' }).click()
  await expect(dialog.getByRole('button', { name: 'Cancel export' })).toBeEnabled()
  await page.evaluate(() => (window as any).excelTestState.fail(new Error('Could not create a file in /reports: permission denied. Choose a folder you can write to')))
  await expect(dialog.getByRole('alert')).toHaveText('Could not create a file in /reports: permission denied. Choose a folder you can write to')
  // The selection is kept so the export can be retried.
  await expect(dialog.getByRole('button', { name: 'Export 3 tables…' })).toBeEnabled()
})

test('the Export to Excel item is hidden when the binding is unavailable', async ({ page }) => {
  await load(page, false)
  await databaseNode(page).click({ button: 'right' })
  const menu = page.getByRole('menu', { name: 'Actions for app' })
  await expect(menu.getByRole('menuitem', { name: 'Open database' })).toBeVisible()
  await expect(menu.getByRole('menuitem', { name: 'Export to Excel…' })).toHaveCount(0)
})
