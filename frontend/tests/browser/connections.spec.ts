import { expect, test, type Page } from '@playwright/test'

// Keep the real connection dialogs, navigation guards, and nested tree; replace
// the desktop IPC boundary so every database read/write can be inspected.
const postgresFixture = `
const initial = [
  { id: 'primary', name: 'Development', host: 'localhost', database: 'app', username: 'postgres', showAllDatabases: false },
  { id: 'reporting', name: 'Reporting', host: 'reports.local', database: 'reports', username: 'reader', showAllDatabases: false },
];
const state = window.connectionTestState = {
  connections: JSON.parse(localStorage.getItem('test-connections') || 'null') || initial,
  updates: [], creates: [], reads: [], saves: [], opens: [], deleted: [], failUpdate: false, failDatabase: '',
};
const persist = () => localStorage.setItem('test-connections', JSON.stringify(state.connections));
const find = id => { const connection = state.connections.find(item => item.id === id); if (!connection) throw new Error('Connection removed'); return connection; };
const details = (id, url, name, showAllDatabases) => {
  const parsed = new URL(url);
  const database = decodeURIComponent(parsed.pathname.slice(1));
  return { id, name: name || database, host: parsed.hostname, database, username: parsed.username, showAllDatabases };
};
export async function ListSavedConnections() { return structuredClone(state.connections); }
export async function OpenSavedConnection(id) { return structuredClone(find(id)); }
export async function ListDatabases(id) {
  const connection = find(id);
  return connection.showAllDatabases ? [...new Set([connection.database, 'analytics', 'scratch'])].sort() : [connection.database];
}
export async function OpenDatabase(id, database) {
  const connection = find(id);
  state.opens.push([id, database]);
  if (state.failDatabase === database) throw new Error('Database access denied');
  if (connection.database !== database && !connection.showAllDatabases) throw new Error('Enable Show all databases');
  return database === connection.database ? id : id + ':' + database;
}
export async function ListTables(id) { return [{ schema: 'audit', name: 'items' }, ...['items', 'other'].map(name => ({ schema: 'public', name }))]; }
export async function GetTableData(id, schema, table) {
  state.reads.push([id, schema, table]);
  return { columns: [{ name: 'value', dataType: 'text', nullable: false, hasDefault: false, generated: false, autoIncrement: false }],
    rows: [[id + '/' + (schema === 'public' ? '' : schema + '/') + table]], rowCount: 1, identities: [{ tableOID: '1', ctid: '(0,1)', version: '42' }] };
}
export async function SaveTableChanges(...args) { state.saves.push(structuredClone(args)); }
export async function UpdateSavedConnection(id, url, name, showAllDatabases) {
  state.updates.push({ id, url, name, showAllDatabases });
  if (state.failUpdate) throw new Error('Could not connect to the replacement URL');
  const connection = url ? details(id, url, name, showAllDatabases) : { ...find(id), name, showAllDatabases };
  state.connections = state.connections.map(item => item.id === id ? connection : item);
  persist();
  return structuredClone(connection);
}
export async function Connect(url, name, showAllDatabases) {
  state.creates.push({ url, name, showAllDatabases });
  const connection = details('new-' + state.creates.length, url, name, showAllDatabases);
  state.connections.unshift(connection); persist(); return structuredClone(connection);
}
export async function DeleteSavedConnection(id) {
  state.deleted.push(id); state.connections = state.connections.filter(item => item.id !== id); persist();
}
export async function CloseConnection() {}
`

const connections = (page: Page) => page.getByRole('navigation', { name: 'Connections', exact: true })
const databases = (page: Page, name = 'Development') => connections(page).getByRole('group', { name: `Databases in ${name}`, exact: true })
const schemas = (page: Page, name = 'app') => databases(page).getByRole('group', { name: `Schemas in ${name}`, exact: true })
const tables = (page: Page, name = 'app', schema = 'public') => schemas(page, name).getByRole('group', { name: `Tables in ${schema} schema`, exact: true })
const state = (page: Page) => page.evaluate(() => (window as any).connectionTestState)

test.beforeEach(async ({ page }) => {
  await page.route('**/bindings/changeme/postgresservice.*', route => route.fulfill({ contentType: 'text/javascript', body: postgresFixture }))
  await page.route('**/bindings/changeme/updateservice.*', route => route.fulfill({ contentType: 'text/javascript', body: 'export async function CheckForUpdates() { return { available: false, version: "dev", releaseUrl: "" } }; export async function InstallUpdate() {}' }))
  await page.goto('/')
  await expect(tables(page).getByRole('button', { name: 'Open items table', exact: true })).toBeVisible()
})

test('connections expand into databases, schemas and tables, with edit beside delete', async ({ page }) => {
  await expect(connections(page).getByRole('button', { name: 'Select Development', exact: true })).toHaveAttribute('aria-expanded', 'true')
  await expect(databases(page).getByRole('button', { name: 'Open app database', exact: true })).toBeVisible()
  await expect(databases(page).getByRole('button', { name: 'Open analytics database', exact: true })).toHaveCount(0)
  const actions = connections(page).getByRole('button', { name: 'Edit Development', exact: true }).locator('..')
  await expect(actions.getByRole('button', { name: 'Remove Development', exact: true })).toBeVisible()
  await tables(page).getByRole('button', { name: 'Open items table', exact: true }).click()
  await expect(page.getByRole('gridcell')).toHaveText('primary/items')
  await connections(page).getByRole('button', { name: 'Select Development', exact: true }).click()
  await expect(databases(page)).toHaveCount(0)
  await connections(page).getByRole('button', { name: 'Select Development', exact: true }).click({ button: 'right' })
  await page.getByRole('menuitem', { name: 'Open connection', exact: true }).click()
  await expect(tables(page).getByRole('button', { name: 'Open items table', exact: true })).toBeVisible()
})

test('schema groups collapse and search independently, and same-named tables use their own schema', async ({ page }) => {
  const publicSchema = schemas(page).getByRole('button', { name: 'Toggle public schema', exact: true })
  await publicSchema.click()
  await expect(publicSchema).toHaveAttribute('aria-expanded', 'false')
  await expect(tables(page)).toHaveCount(0)
  await expect(tables(page, 'app', 'audit').getByRole('button', { name: 'Open items table', exact: true })).toBeVisible()
  await page.getByRole('textbox', { name: 'Find a table', exact: true }).fill('public.items')
  await expect(tables(page).getByRole('button', { name: 'Open items table', exact: true })).toBeVisible()
  await expect(schemas(page).getByRole('button', { name: 'Toggle audit schema', exact: true })).toHaveCount(0)
  await page.getByRole('textbox', { name: 'Find a table', exact: true }).fill('')
  await publicSchema.click()
  await tables(page).getByRole('button', { name: 'Open items table', exact: true }).click()
  await expect(page.getByRole('gridcell')).toHaveText('primary/items')
  await tables(page, 'app', 'audit').getByRole('button', { name: 'Open items table', exact: true }).click()
  await expect(page.getByRole('gridcell')).toHaveText('primary/audit/items')
  await page.getByRole('gridcell').dblclick()
  await page.getByRole('textbox', { name: 'Edit value', exact: true }).fill('audit edit')
  await page.keyboard.press('Enter')
  await page.getByRole('button', { name: 'Save changes', exact: true }).click()
  expect((await state(page)).saves[0].slice(0, 3)).toEqual(['primary', 'audit', 'items'])
})

test('dragging the divider changes the actual sidebar width, clamps it, and persists it', async ({ page }) => {
  const sidebar = page.locator('#database-sidebar')
  const divider = page.getByRole('separator', { name: 'Resize sidebar', exact: true })
  const bounds = await divider.boundingBox()
  const y = bounds!.y + bounds!.height / 2
  const width = async () => (await sidebar.boundingBox())!.width
  await page.mouse.move(bounds!.x + bounds!.width / 2, y)
  await page.mouse.down()
  await page.mouse.move(350, y, { steps: 10 })
  await expect.poll(width).toBe(350)
  await expect(divider).toHaveAttribute('aria-valuenow', '350')
  await page.mouse.move(900, y, { steps: 10 })
  await expect.poll(width).toBe(420)
  await page.mouse.move(50, y, { steps: 10 })
  await expect.poll(width).toBe(190)
  await page.mouse.up()
  await expect(page.locator('.app-shell')).not.toHaveClass(/is-resizing-sidebar/)
  await page.reload()
  await expect.poll(width).toBe(190)
  await divider.focus()
  await page.keyboard.press('End')
  await expect.poll(width).toBe(420)
  await page.keyboard.press('Home')
  await page.keyboard.press('ArrowRight')
  await expect.poll(width).toBe(206)
  await page.keyboard.press('End')
  await page.setViewportSize({ width: 600, height: 900 })
  await expect.poll(width).toBe(280)
  await expect(divider).toHaveAttribute('aria-valuenow', '280')
})

test('right click and keyboard menus edit without selecting another connection and dismiss cleanly', async ({ page }) => {
  const reporting = connections(page).getByRole('button', { name: 'Select Reporting', exact: true })
  await reporting.click({ button: 'right' })
  await expect(page.getByRole('menu', { name: 'Actions for Reporting' })).toBeVisible()
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('app')
  await page.keyboard.press('Escape')
  await expect(page.getByRole('menu')).toHaveCount(0)
  await expect(reporting).toBeFocused()
  await page.keyboard.press('Shift+F10')
  await page.keyboard.press('ArrowDown')
  await page.keyboard.press('Enter')
  const dialog = page.getByRole('dialog', { name: 'Edit connection', exact: true })
  await expect(dialog.getByLabel('Connection name')).toHaveValue('Reporting')
  await expect(dialog.getByLabel('Database URL', { exact: true })).toHaveValue('')
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click()
  await reporting.click({ button: 'right' })
  await page.getByRole('heading', { level: 1 }).click()
  await expect(page.getByRole('menu')).toHaveCount(0)
})

test('edit keeps the URL when blank and persists visibility across restart', async ({ page }) => {
  await connections(page).getByRole('button', { name: 'Edit Development', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: 'Edit connection', exact: true })
  await dialog.getByLabel('Connection name').fill('Local server')
  await dialog.getByRole('checkbox', { name: 'Show all databases', exact: true }).check()
  await dialog.getByRole('button', { name: 'Save connection', exact: true }).click()
  await expect(databases(page, 'Local server').getByRole('button', { name: 'Open analytics database', exact: true })).toBeVisible()
  expect((await state(page)).updates).toEqual([{ id: 'primary', url: '', name: 'Local server', showAllDatabases: true }])
  await expect(connections(page).getByRole('button', { name: /^Select / })).toHaveCount(2)
  await page.reload()
  await expect(databases(page, 'Local server').getByRole('button', { name: 'Open analytics database', exact: true })).toBeVisible()
  await connections(page).getByRole('button', { name: 'Edit Local server', exact: true }).click()
  await expect(page.getByRole('checkbox', { name: 'Show all databases', exact: true })).toBeChecked()
  await page.getByRole('checkbox', { name: 'Show all databases', exact: true }).uncheck()
  await page.getByRole('button', { name: 'Save connection', exact: true }).click()
  await expect(databases(page, 'Local server').getByRole('button', { name: 'Open analytics database', exact: true })).toHaveCount(0)
  await expect(databases(page, 'Local server').getByRole('button', { name: 'Open app database', exact: true })).toBeVisible()
})

test('changing the URL updates the same connection; a failed edit preserves its settings', async ({ page }) => {
  await connections(page).getByRole('button', { name: 'Edit Development', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: 'Edit connection', exact: true })
  await dialog.getByLabel('Database URL', { exact: true }).fill('postgresql://user:password@new-host:5432/replacement')
  await page.evaluate(() => { (window as any).connectionTestState.failUpdate = true })
  await dialog.getByRole('button', { name: 'Save connection', exact: true }).click()
  await expect(dialog.getByRole('alert')).toContainText('Could not connect')
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('app')
  await expect(dialog.getByLabel('Database URL', { exact: true })).toHaveValue('postgresql://user:password@new-host:5432/replacement')
  await page.evaluate(() => { (window as any).connectionTestState.failUpdate = false })
  await dialog.getByRole('button', { name: 'Save connection', exact: true }).click()
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('replacement')
  await expect(databases(page).getByRole('button', { name: 'Open replacement database', exact: true })).toBeVisible()
  await expect(connections(page).getByRole('button', { name: /^Select / })).toHaveCount(2)
  expect((await state(page)).connections[0]).toMatchObject({ id: 'primary', host: 'new-host', database: 'replacement' })
})

test('add connection offers show all databases and starts a new nested branch', async ({ page }) => {
  await page.getByRole('button', { name: 'Add a database connection', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: 'New connection', exact: true })
  await expect(dialog.getByRole('checkbox', { name: 'Show all databases', exact: true })).not.toBeChecked()
  await dialog.getByLabel('Connection name').fill('Staging')
  await dialog.getByLabel('Database URL', { exact: true }).fill('postgresql://user:password@staging:5432/staging')
  await dialog.getByRole('checkbox', { name: 'Show all databases', exact: true }).check()
  await dialog.getByRole('button', { name: 'Connect database', exact: true }).click()
  await expect(databases(page, 'Staging').getByRole('button', { name: 'Open analytics database', exact: true })).toBeVisible()
  expect((await state(page)).creates[0]).toMatchObject({ name: 'Staging', showAllDatabases: true })
})

test('same-named tables read and save through the selected database and protect unsaved changes', async ({ page }) => {
  await connections(page).getByRole('button', { name: 'Edit Development', exact: true }).click()
  await page.getByRole('checkbox', { name: 'Show all databases', exact: true }).check()
  await page.getByRole('button', { name: 'Save connection', exact: true }).click()
  await tables(page).getByRole('button', { name: 'Open items table', exact: true }).click()
  await page.getByRole('gridcell').dblclick()
  await page.getByRole('textbox', { name: 'Edit value', exact: true }).fill('keep this draft')
  await page.keyboard.press('Enter')
  const analytics = databases(page).getByRole('button', { name: 'Open analytics database', exact: true })
  await analytics.click()
  await expect(page.getByRole('dialog', { name: 'Unsaved changes', exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Keep editing', exact: true }).click()
  await expect(page.getByRole('gridcell')).toHaveText('keep this draft')
  // Expanded branches stay available even while navigation is deferred.
  await tables(page, 'analytics').getByRole('button', { name: 'Open items table', exact: true }).click()
  await page.getByRole('button', { name: 'Save and continue', exact: true }).click()
  await expect(page.getByRole('gridcell')).toHaveText('primary:analytics/items')
  expect((await state(page)).saves[0][0]).toBe('primary')
  await page.getByRole('gridcell').dblclick()
  await page.getByRole('textbox', { name: 'Edit value', exact: true }).fill('analytics edit')
  await page.keyboard.press('Enter')
  await page.getByRole('button', { name: 'Save changes', exact: true }).click()
  expect((await state(page)).saves[1][0]).toBe('primary:analytics')
  await expect(page.locator('.main-footer')).toHaveCount(0)
  await expect(page.locator('.breadcrumbs')).toHaveText('Developmentanalyticspublicitems')
})

test('delete from the context menu removes the branch and opens the next saved connection', async ({ page }) => {
  await connections(page).getByRole('button', { name: 'Select Development', exact: true }).click({ button: 'right' })
  await page.getByRole('menuitem', { name: 'Delete connection', exact: true }).click()
  await expect(connections(page).getByRole('button', { name: 'Select Development', exact: true })).toHaveCount(0)
  await expect(databases(page, 'Reporting').getByRole('button', { name: 'Open reports database', exact: true })).toBeVisible()
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('reports')
  expect((await state(page)).deleted).toEqual(['primary'])
})
