import { expect, test } from '@playwright/test'

const fixture = `
const connection = { id: 'test', name: 'Test', database: 'test', host: 'localhost', username: 'test' };
const columns = [{ name: 'id', dataType: 'integer', nullable: false }, { name: 'name', dataType: 'text', nullable: true }];
window.featureState = { queries: [], exports: [], files: [] };
export async function ListSavedConnections() { return [connection] }
export async function OpenSavedConnection() { return connection }
export async function OpenDatabase() { return 'test' }
export async function ListDatabases() { return ['test'] }
export async function ListTables() { return [{ schema: 'public', name: 'items' }] }
export async function GetSchemaCompletions() { return [{ schema: 'public', table: 'items', columns: ['id','name'] }] }
function data(rows, rowCount) { return { columns, rows, rowCount, identities: rows.map((r) => ({ tableOID: '1', ctid: '(0,'+r[0]+')', version: '1' })) } }
export async function GetTableData() { return data([['1','first'],['2','second']],600) }
export async function GetFilteredTableData(id,schema,table,limit,offset,options) { window.featureState.queries.push({options,limit,offset}); return data([['599','last']],1) }
export async function GetTableMetadata() { return { constraints: [{ name:'items_pkey',type:'PRIMARY KEY',definition:'PRIMARY KEY (id)' }], indexes: [{name:'items_name_idx',definition:'CREATE INDEX items_name_idx ON public.items (name)'}], ddl:'CREATE TABLE public.items (id integer PRIMARY KEY, name text);' } }
export async function GenerateTableSQL(id,schema,table,kind) { return kind === 'SELECT' ? 'SELECT * FROM public.items LIMIT 100;' : 'CREATE TABLE public.items (id integer);' }
export async function ChooseExportPath(name) { return '/tmp/'+name }
export async function WriteExportFile(path,contents) { window.featureState.files.push({path,contents}) }
export async function ExportTableData(id,schema,table,options,format,path) { window.featureState.exports.push({id,schema,table,options,format,path}) }
export async function ExecuteSQLScript() { return {results:[],error:'',rolledBack:false} }
`
test.beforeEach(async ({ page }) => {
  await page.route('**/bindings/changeme/internal/database/postgresservice.*', route => route.fulfill({ contentType: 'text/javascript', body: fixture }))
  await page.route('**/bindings/changeme/internal/updates/updateservice.*', route => route.fulfill({ contentType: 'text/javascript', body: 'export async function CheckForUpdates() { return {available:false} }' }))
  await page.goto('/')
  await page.getByRole('button', { name: 'Open items table', exact: true }).click()
  await expect(page.locator('[data-cell="0:1"]')).toHaveText('first')
})
test('filters and sorts through the database, retaining options across tabs', async ({ page }) => {
  await page.getByRole('button', { name: 'Filters', exact: true }).click()
  await page.getByRole('button', { name: 'Add condition' }).click()
  await page.getByLabel('Filter 1 operator', { exact: true }).selectOption('gte')
  await page.getByLabel('Filter 1 value', { exact: true }).fill('599')
  await page.getByRole('button', { name: 'Apply', exact: true }).click()
  await expect(page.locator('[data-cell="0:0"]')).toHaveText('599')
  await expect(page.locator('.pagination-range')).toContainText('of 1 rows')
  await page.getByRole('button', { name: 'Sort by id', exact: true }).click()
  await expect.poll(() => page.evaluate(() => (window as any).featureState.queries.at(-1).options.sort)).toEqual([{column:'id',direction:'ASC'}])
  await page.getByRole('button', { name: 'New SQL script' }).click()
  await page.getByRole('tab', { name: 'items', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Filters · 1', exact: true })).toBeVisible()
  await expect(page.getByRole('columnheader').filter({has:page.getByRole('button',{name:'Sort by id',exact:true})})).toHaveAttribute('aria-sort','ascending')
})
test('exports loaded rows to a file and streams an entire table separately', async ({ page }) => {
  await page.locator('.export-menu summary').click()
  await page.getByRole('button', { name: 'Save file' }).click()
  await expect.poll(() => page.evaluate(() => (window as any).featureState.files[0]?.contents)).toBe('id,name\r\n1,first\r\n2,second\r\n')
  await page.locator('.export-menu summary').click()
  await page.getByLabel('Export rows').selectOption('table')
  await page.getByLabel('Export format').selectOption('json')
  await page.getByRole('button', { name: 'Save file' }).click()
  await expect.poll(() => page.evaluate(() => (window as any).featureState.exports[0])).toMatchObject({id:'test',schema:'public',table:'items',format:'json',options:{filters:[],sort:[]}})
})
test('shows keys and indexes and opens generated SQL in a script tab', async ({ page }) => {
  await page.getByRole('tab', { name: 'Structure', exact: true }).click()
  await expect(page.getByText('PRIMARY KEY (id)', { exact: true })).toBeVisible()
  await expect(page.getByText('items_name_idx', { exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Generate SELECT', exact: true }).click()
  await expect(page.getByRole('tab', { name: 'items · SELECT', exact: true })).toHaveAttribute('aria-selected','true')
  await expect(page.getByRole('textbox', { name: 'SQL script' })).toHaveText('SELECT * FROM public.items LIMIT 100;')
})

test('late generated SQL cannot replace a table draft after leaving Structure', async ({ page }) => {
  const delayed = fixture.replace("return kind === 'SELECT'", "if (window.featureState.holdGeneration) { await new Promise(resolve => { window.finishGenerate = resolve }); window.generationFinished = true; } return kind === 'SELECT'")
  await page.route('**/bindings/changeme/internal/database/postgresservice.*', route => route.fulfill({ contentType:'text/javascript', body:delayed }))
  await page.reload()
  await page.getByRole('tab', { name:'Structure',exact:true }).click()
  await page.evaluate(() => { (window as any).featureState.holdGeneration = true })
  await page.getByRole('button', { name:'Generate SELECT',exact:true }).click()
  await expect.poll(() => page.evaluate(() => typeof (window as any).finishGenerate)).toBe('function')
  await page.getByRole('tab', { name:'Data',exact:true }).click()
  await page.locator('[data-cell="0:1"]').dblclick()
  await page.getByRole('textbox', {name:'Edit name',exact:true}).fill('draft')
  await page.keyboard.press('Enter')
  await page.evaluate(() => (window as any).finishGenerate())
  await expect.poll(() => page.evaluate(() => (window as any).generationFinished)).toBe(true)
  await expect(page.locator('[data-cell="0:1"]')).toHaveText('draft')
  await expect(page.getByRole('tab', { name:'items · SELECT',exact:true })).toHaveCount(0)
})
