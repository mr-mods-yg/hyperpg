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

test('nested export keeps busy and error states visible and allows retry', async ({ page }) => {
  const failingOnce = fixture.replace(
    'window.featureState.files.push({path,contents})',
    `window.featureState.writeAttempts = (window.featureState.writeAttempts ?? 0) + 1;
     if (window.featureState.writeAttempts === 1) {
       await new Promise(resolve => { window.finishFailedExport = resolve });
       throw new Error('Disk is full');
     }
     window.featureState.files.push({path,contents})`,
  )
  await page.route('**/bindings/changeme/internal/database/postgresservice.*', route => route.fulfill({ contentType: 'text/javascript', body: failingOnce }))
  await page.evaluate(() => localStorage.setItem('hyperpg-font-size-px', '18'))
  await page.setViewportSize({ width: 390, height: 600 })
  await page.reload()
  await expect(page.locator('[data-cell="0:1"]')).toHaveText('first')
  const actions = page.getByRole('button', { name: 'Table actions' })
  await actions.click()
  await page.locator('.export-menu summary').click()
  await page.getByRole('button', { name: 'Save file' }).click()
  await expect(page.getByRole('button', { name: 'Exporting…' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Exporting…' })).toBeDisabled()
  await expect(actions).toHaveAttribute('aria-expanded', 'true')
  await page.evaluate(() => (window as any).finishFailedExport())
  await expect(page.getByRole('alert')).toHaveText('Disk is full')
  await expect(page.getByRole('alert')).toBeVisible()
  await page.getByRole('button', { name: 'Save file' }).click()
  await expect.poll(() => page.evaluate(() => (window as any).featureState.files.length)).toBe(1)
  await expect(page.locator('.export-menu-panel')).toBeHidden()
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

test('export stays visible in a short workspace and dismisses with Escape or outside click', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 700, height: 560 })
  await page.getByRole('button', { name: 'Table actions' }).click()
  const trigger = page.locator('.export-menu summary')
  await trigger.click()
  const panel = page.locator('.export-menu-panel')
  await expect(page.getByRole('button', { name: 'Save file' })).toBeVisible()
  const bounds = (await panel.boundingBox())!
  expect(bounds.x).toBeGreaterThanOrEqual(8)
  expect(bounds.y).toBeGreaterThanOrEqual(8)
  expect(bounds.x + bounds.width).toBeLessThanOrEqual(692)
  expect(bounds.y + bounds.height).toBeLessThanOrEqual(552)
  expect(await page.getByRole('button', { name: 'Save file' }).evaluate((element) => {
    const rect = element.getBoundingClientRect()
    return element.contains(document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2))
  })).toBe(true)
  await page.screenshot({ path: testInfo.outputPath('export-panel.png') })
  await page.getByLabel('Export format').focus()
  await page.keyboard.press('Escape')
  await expect(panel).toBeHidden()
  await expect(trigger).toBeFocused()
  await trigger.click()
  await page.getByRole('button', { name: 'Filters', exact: true }).click()
  await expect(panel).toBeHidden()
})

test('large text in a short narrow window keeps grid rows and pagination reachable', async ({ page }) => {
  await page.evaluate(() => localStorage.setItem('hyperpg-font-size-px', '18'))
  await page.setViewportSize({ width: 390, height: 600 })
  await page.reload()
  const first = page.locator('[data-cell="0:1"]')
  await expect(first).toHaveText('first')
  const firstId = page.locator('[data-cell="0:0"]')
  const secondId = page.locator('[data-cell="1:0"]')
  for (const row of [firstId, secondId]) {
    const bounds = (await row.boundingBox())!
    expect(bounds.y).toBeGreaterThanOrEqual(0)
    expect(bounds.y + bounds.height).toBeLessThanOrEqual(600)
    expect(await row.evaluate(element => { const rect = element.getBoundingClientRect(); return element.contains(document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2)) })).toBe(true)
  }
  await expect.poll(() => first.evaluate((element) => {
    const rect = element.getBoundingClientRect()
    return element.contains(document.elementFromPoint(Math.max(rect.left + 5, Math.min(rect.right - 5, innerWidth - 15)), rect.y + rect.height / 2))
  })).toBe(true)
  await first.click()
  await expect(first).toBeFocused()
  const pagination = page.locator('.pagination-actions')
  expect(await pagination.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true)
  await page.getByRole('button', { name: 'End page' }).click()
  await expect(page.locator('.pagination-range')).toContainText('of 600 rows')
})


test('narrow table controls disclose search, export, and filters by keyboard', async ({ page }) => {
  await page.evaluate(() => localStorage.setItem('hyperpg-font-size-px', '18'))
  await page.setViewportSize({ width: 390, height: 600 })
  await page.reload()
  const trigger = page.getByRole('button', { name: 'Table actions' })
  await trigger.focus()
  await page.keyboard.press('Enter')
  await expect(trigger).toHaveAttribute('aria-expanded', 'true')
  await page.keyboard.press('Tab')
  // Copy is disabled without a selection; Export remains reachable.
  await expect(page.locator('.export-menu summary')).toBeFocused()
  await page.keyboard.press('Escape')
  await expect(trigger).toBeFocused()
  await expect(trigger).toHaveAttribute('aria-expanded', 'false')
  await trigger.click()
  await page.getByRole('textbox', { name: 'Search this page' }).fill('second')
  await expect(page.locator('[data-cell="0:1"]')).toHaveText('second')
  await page.getByRole('button', { name: 'Filters', exact: true }).click()
  await expect(trigger).toHaveAttribute('aria-expanded', 'false')
  await page.getByRole('button', { name: 'Add condition' }).click()
  await expect(page.getByLabel('Filter 1 column')).toBeVisible()
})

test('Structure markers and secondary labels use readable text in all four themes', async ({ page }) => {
  for (const theme of ['light', 'dark', 'cream', 'discord']) {
    await page.evaluate((theme) => localStorage.setItem('hyperpg-theme', theme), theme)
    await page.reload()
    await page.getByRole('tab', { name: 'Structure', exact: true }).click()
    for (const selector of ['.structure-empty', '.structure-intro span', '.workspace-identity > div > span']) {
      const label = page.locator(selector).first()
      await expect(label).toBeVisible()
      const ratio = await label.evaluate((element) => {
        const parse = (value: string) => value.match(/[\d.]+/g)!.slice(0, 3).map(Number).map(v => { v /= 255; return v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4 })
        const luminance = (value: string) => { const [r,g,b] = parse(value); return .2126*r + .7152*g + .0722*b }
        let surface: Element | null = element
        while (surface && (getComputedStyle(surface).backgroundColor === 'rgba(0, 0, 0, 0)' || getComputedStyle(surface).backgroundColor === 'transparent')) surface = surface.parentElement
        const foreground = luminance(getComputedStyle(element).color)
        const background = luminance(getComputedStyle(surface!).backgroundColor)
        return (Math.max(foreground, background) + .05) / (Math.min(foreground, background) + .05)
      })
      expect(ratio, `${theme} ${selector}`).toBeGreaterThanOrEqual(4.5)
    }
  }
})
