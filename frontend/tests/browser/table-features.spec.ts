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

test('narrow filter conditions keep long columns and between/null values usable', async ({ page }) => {
  const longColumn = 'customer_identifier_with_a_very_long_column_name_for_regional_accounts'
  const longColumns = fixture.replace("name: 'id', dataType", `name: '${longColumn}', dataType`)
  await page.route('**/bindings/changeme/internal/database/postgresservice.*', route => route.fulfill({ contentType: 'text/javascript', body: longColumns }))
  await page.evaluate(() => localStorage.setItem('hyperpg-font-size-px', '18'))
  await page.setViewportSize({ width: 390, height: 600 })
  await page.reload()
  await expect(page.locator('[data-cell="0:1"]')).toHaveText('first')
  await page.getByRole('button', { name: 'Filters', exact: true }).click()
  await expect(page.getByText('Add a condition to filter rows.')).toBeVisible()
  await page.getByRole('button', { name: 'Add condition' }).click()
  const first = page.getByRole('group', { name: 'Condition 1' })
  const column = first.getByLabel('Filter 1 column')
  await expect(column).toHaveAttribute('title', longColumn)
  await first.getByLabel('Filter 1 operator').selectOption('between')
  await first.getByLabel('Filter 1 start value', { exact: true }).fill('100')
  await first.getByLabel('Filter 1 end value').fill('999')
  await first.getByLabel('Filter 1 operator').selectOption('isNotNull')
  await expect(first.getByLabel('Filter 1 value', { exact: true })).toHaveCount(0)
  await first.getByLabel('Filter 1 operator').selectOption('between')
  await expect(first.getByLabel('Filter 1 end value')).toHaveValue('999')
  await page.getByRole('button', { name: 'Add condition' }).click()
  const second = page.getByRole('group', { name: 'Condition 2' })
  await second.getByLabel('Filter 2 column').selectOption('name')
  await second.getByLabel('Filter 2 operator').selectOption('isNull')
  await expect(second.getByLabel('Filter 2 value', { exact: true })).toHaveCount(0)
  for (const control of [column, first.getByLabel('Filter 1 end value'), second.getByLabel('Filter 2 operator'), second.getByRole('button', { name: 'Remove filter 2' })]) {
    await control.scrollIntoViewIfNeeded()
    const bounds = (await control.boundingBox())!
    expect(bounds.x).toBeGreaterThanOrEqual(0)
    expect(bounds.x + bounds.width).toBeLessThanOrEqual(390)
    expect(await control.evaluate((element) => { const rect = element.getBoundingClientRect(); return element.contains(document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2)) })).toBe(true)
  }
  await page.getByRole('button', { name: 'Apply', exact: true }).click()
  await expect(page.getByRole('tabpanel', { name: 'Data' })).toBeFocused()
  await expect.poll(() => page.evaluate(() => (window as any).featureState.queries.at(-1)?.options.filters)).toEqual([
    { column: longColumn, operator: 'between', value: '100', value2: '999' },
    { column: 'name', operator: 'isNull', value: '', value2: '' },
  ])
  await page.getByRole('button', { name: 'Filters · 2' }).click()
  const remove = page.getByRole('button', { name: 'Remove filter 2' })
  await remove.focus()
  await page.keyboard.press('Enter')
  await expect(page.getByRole('button', { name: 'Add condition' })).toBeFocused()
  await page.getByRole('button', { name: 'Apply', exact: true }).click()
  await expect.poll(() => page.evaluate(() => (window as any).featureState.queries.at(-1)?.options.filters)).toEqual([
    { column: longColumn, operator: 'between', value: '100', value2: '999' },
  ])
  await page.getByRole('button', { name: 'Filters · 1' }).click()
  await page.getByRole('button', { name: 'Reset', exact: true }).click()
  await expect(page.getByRole('tabpanel', { name: 'Data' })).toBeFocused()
  await expect(page.getByRole('button', { name: 'Filters', exact: true })).toBeVisible()
  await expect(page.locator('[data-cell="0:1"]')).toHaveText('first')
})

test('applying filters keeps focus stable while rows load and does not steal it later', async ({ page }) => {
  const delayed = fixture.replace('window.featureState.queries.push({options,limit,offset}); return data', 'window.featureState.queries.push({options,limit,offset}); await new Promise(resolve => { window.finishFilterLoad = resolve }); return data')
  await page.route('**/bindings/changeme/internal/database/postgresservice.*', route => route.fulfill({ contentType: 'text/javascript', body: delayed }))
  await page.reload()
  await page.getByRole('button', { name: 'Filters', exact: true }).click()
  await page.getByRole('button', { name: 'Add condition' }).click()
  await page.getByLabel('Filter 1 value').fill('1')
  await page.getByRole('button', { name: 'Apply', exact: true }).focus()
  await page.keyboard.press('Enter')
  const workspace = page.getByRole('tabpanel', { name: 'Data' })
  await expect(workspace).toBeFocused()
  await expect.poll(() => page.evaluate(() => typeof (window as any).finishFilterLoad)).toBe('function')
  const newSql = page.getByRole('button', { name: 'New SQL script' })
  await newSql.focus()
  await page.evaluate(() => (window as any).finishFilterLoad())
  await expect(page.getByRole('button', { name: 'Filters · 1' })).toBeVisible()
  await expect(newSql).toBeFocused()
})

test('filter apply after discarding table edits returns focus to the table workspace', async ({ page }) => {
  await page.locator('[data-cell="0:1"]').dblclick()
  await page.getByRole('textbox', { name: 'Edit name' }).fill('edited')
  await page.keyboard.press('Enter')
  await page.getByRole('button', { name: 'Filters', exact: true }).click()
  await page.getByRole('button', { name: 'Add condition' }).click()
  await page.getByLabel('Filter 1 value').fill('1')
  await page.getByRole('button', { name: 'Apply', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: /unsaved/i })
  await expect(dialog).toBeVisible()
  await dialog.getByRole('button', { name: /discard/i }).click()
  await expect(page.getByRole('button', { name: 'Filters · 1' })).toBeVisible()
  await expect(page.getByRole('tabpanel', { name: 'Data' })).toBeFocused()
})

test('a rejected filter can be corrected or reset without leaving the table', async ({ page }) => {
  const failing = fixture.replace('window.featureState.queries.push({options,limit,offset}); return data', "window.featureState.queries.push({options,limit,offset}); if (options.filters[0]?.value === 'invalid') throw new Error('Invalid filter value'); return data")
  await page.route('**/bindings/changeme/internal/database/postgresservice.*', route => route.fulfill({ contentType: 'text/javascript', body: failing }))
  await page.evaluate(() => localStorage.setItem('hyperpg-font-size-px', '18'))
  await page.setViewportSize({ width: 390, height: 600 })
  await page.reload()
  await page.getByRole('button', { name: 'Filters', exact: true }).click()
  await page.getByRole('button', { name: 'Add condition' }).click()
  await page.getByLabel('Filter 1 value').fill('invalid')
  await page.getByRole('button', { name: 'Apply', exact: true }).click()
  await expect(page.getByRole('alert')).toContainText('Invalid filter value')
  await expect(page.getByLabel('Filter 1 value')).toHaveValue('invalid')
  await page.getByLabel('Filter 1 value').fill('2')
  await page.getByRole('button', { name: 'Apply', exact: true }).click()
  await expect(page.locator('[data-cell="0:0"]')).toHaveText('599')
  await expect.poll(() => page.evaluate(() => (window as any).featureState.queries.at(-1)?.options.filters[0].value)).toBe('2')
  await page.getByRole('button', { name: 'Filters · 1' }).click()
  await page.getByLabel('Filter 1 value').fill('invalid')
  await page.getByRole('button', { name: 'Apply', exact: true }).click()
  await expect(page.getByRole('alert')).toContainText('Invalid filter value')
  await page.getByRole('button', { name: 'Reset', exact: true }).click()
  await expect(page.locator('[data-cell="0:1"]')).toHaveText('first')
  await expect(page.getByRole('button', { name: 'Filters', exact: true })).toBeVisible()
})

test('retrying an unchanged filter after a transient error requests the rows again', async ({ page }) => {
  const failingOnce = fixture.replace('window.featureState.queries.push({options,limit,offset}); return data', "window.featureState.queries.push({options,limit,offset}); if (window.featureState.queries.length === 1) throw new Error('Temporary read failure'); return data")
  await page.route('**/bindings/changeme/internal/database/postgresservice.*', route => route.fulfill({ contentType: 'text/javascript', body: failingOnce }))
  await page.reload()
  await page.getByRole('button', { name: 'Filters', exact: true }).click()
  await page.getByRole('button', { name: 'Add condition' }).click()
  await page.getByLabel('Filter 1 value').fill('1')
  await page.getByRole('button', { name: 'Apply', exact: true }).click()
  await expect(page.getByRole('alert')).toContainText('Temporary read failure')
  await page.getByRole('button', { name: 'Apply', exact: true }).click()
  await expect(page.getByRole('tabpanel', { name: 'Data' })).toBeFocused()
  await expect(page.locator('[data-cell="0:0"]')).toHaveText('599')
  await expect.poll(() => page.evaluate(() => (window as any).featureState.queries.length)).toBe(2)
})

test('failed empty filter queries keep the builder available for retry and correction', async ({ page }) => {
  const failing = fixture.replace("return data([['1','first'],['2','second']],600)", "window.featureState.unfilteredReads = (window.featureState.unfilteredReads ?? 0) + 1; if (window.featureState.blockUnfiltered) throw new Error('Unfiltered read failed'); return data([['1','first'],['2','second']],600)")
  await page.route('**/bindings/changeme/internal/database/postgresservice.*', route => route.fulfill({ contentType: 'text/javascript', body: failing }))
  await page.reload()
  await page.getByRole('button', { name: 'Filters', exact: true }).click()
  await page.getByRole('button', { name: 'Add condition' }).click()
  await page.getByLabel('Filter 1 value').fill('123')
  await page.getByRole('button', { name: 'Apply', exact: true }).click()
  await expect(page.locator('[data-cell="0:0"]')).toHaveText('599')
  await page.evaluate(() => { (window as any).featureState.blockUnfiltered = true })
  await page.getByRole('button', { name: 'Filters · 1' }).click()
  await page.getByRole('button', { name: 'Reset', exact: true }).click()
  // Reset returns to a page cached moments ago, so request fresh rows before
  // checking that the simulated read failure is surfaced.
  await page.getByRole('button', { name: 'Refresh', exact: true }).click()
  await expect(page.getByRole('alert')).toContainText('Unfiltered read failed')
  await expect(page.getByRole('button', { name: 'Filters', exact: true })).toBeVisible()
  const attempts = await page.evaluate(() => (window as any).featureState.unfilteredReads)
  await page.getByRole('button', { name: 'Apply', exact: true }).click()
  await expect.poll(() => page.evaluate(() => (window as any).featureState.unfilteredReads)).toBe(attempts + 1)
  await expect(page.getByRole('alert')).toContainText('Unfiltered read failed')
  await page.getByRole('button', { name: 'Add condition' }).click()
  await page.getByLabel('Filter 1 value').fill('123')
  await page.getByRole('button', { name: 'Apply', exact: true }).click()
  await expect(page.locator('[data-cell="0:0"]')).toHaveText('599')
  await page.getByRole('button', { name: 'Filters · 1' }).click()
  await page.getByRole('button', { name: 'Remove filter 1' }).click()
  await page.getByRole('button', { name: 'Apply', exact: true }).click()
  await expect(page.getByRole('alert')).toContainText('Unfiltered read failed')
  await expect(page.getByRole('button', { name: 'Add condition' })).toBeVisible()
  await page.evaluate(() => { (window as any).featureState.blockUnfiltered = false })
  await page.getByRole('button', { name: 'Reset', exact: true }).click()
  await expect(page.locator('[data-cell="0:1"]')).toHaveText('first')
})

test('cancelling a guarded Reset preserves the filter draft and accepting clears it', async ({ page }) => {
  await page.getByRole('button', { name: 'Filters', exact: true }).click()
  await page.getByRole('button', { name: 'Add condition' }).click()
  await page.getByLabel('Filter 1 value').fill('123')
  await page.getByRole('button', { name: 'Apply', exact: true }).click()
  await expect(page.locator('[data-cell="0:0"]')).toHaveText('599')
  await page.locator('[data-cell="0:1"]').dblclick()
  await page.getByRole('textbox', { name: 'Edit name' }).fill('edited')
  await page.keyboard.press('Enter')
  await expect(page.getByRole('button', { name: 'Save changes', exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Filters · 1' }).click()
  await page.getByLabel('Filter 1 value').fill('456')
  await page.getByRole('button', { name: 'Reset', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: /unsaved/i })
  await dialog.getByRole('button', { name: /keep editing/i }).click()
  await expect(page.getByLabel('Filter 1 value')).toHaveValue('456')
  await expect(page.locator('[data-cell="0:1"]')).toHaveText('edited')
  await expect(page.getByRole('button', { name: 'Filters · 1' })).toBeVisible()
  await page.getByRole('button', { name: 'Reset', exact: true }).click()
  await dialog.getByRole('button', { name: /discard/i }).click()
  await expect(page.locator('[data-cell="0:1"]')).toHaveText('first')
  await page.getByRole('button', { name: 'Filters', exact: true }).click()
  await expect(page.getByText('Add a condition to filter rows.')).toBeVisible()
  await page.getByRole('button', { name: 'Add condition' }).click()
  await page.getByLabel('Filter 1 value').fill('789')
  await page.getByRole('button', { name: 'Reset', exact: true }).click()
  await expect(page.getByRole('group', { name: 'Condition 1' })).toHaveCount(0)
  await expect(page.getByText('Add a condition to filter rows.')).toBeVisible()
})

test('filter recovery keeps the right columns after working in another table tab', async ({ page }) => {
  const multiple = fixture
    .replace("return [{ schema: 'public', name: 'items' }]", "return [{ schema: 'public', name: 'items' }, { schema: 'public', name: 'other' }]")
    .replace("export async function GetTableData() { return data([['1','first'],['2','second']],600) }", "export async function GetTableData(id,schema,table) { const page = data([['1','first'],['2','second']],600); if (table === 'other') page.columns = [{ name: 'other_id', dataType: 'integer', nullable: false }, { name: 'name', dataType: 'text', nullable: true }]; return page }")
    .replace('window.featureState.queries.push({options,limit,offset}); return data', "window.featureState.queries.push({options,limit,offset}); if (table === 'items' && window.featureState.failItems) throw new Error('Items query failed'); return data")
  await page.route('**/bindings/changeme/internal/database/postgresservice.*', route => route.fulfill({ contentType: 'text/javascript', body: multiple }))
  await page.reload()
  await page.getByRole('button', { name: 'Filters', exact: true }).click()
  await page.getByRole('button', { name: 'Add condition' }).click()
  await page.getByLabel('Filter 1 value').fill('items-value')
  await page.getByRole('button', { name: 'Apply', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Filters · 1' })).toBeVisible()
  await page.getByRole('button', { name: 'Open other table', exact: true }).click()
  await page.getByRole('button', { name: 'Filters', exact: true }).click()
  await page.getByRole('button', { name: 'Add condition' }).click()
  await expect(page.getByLabel('Filter 1 column')).toHaveValue('other_id')
  await page.getByLabel('Filter 1 value').fill('other-value')
  await page.getByRole('button', { name: 'Apply', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Filters · 1' })).toBeVisible()
  await page.evaluate(() => { (window as any).featureState.failItems = true })
  await page.getByRole('tab', { name: 'items', exact: true }).click()
  // The tab reuses its cached page now, so request fresh rows to exercise
  // the failure path before checking that the filter draft was retained.
  await page.getByRole('button', { name: 'Refresh', exact: true }).click()
  await expect(page.getByRole('alert')).toContainText('Items query failed')
  await expect(page.getByLabel('Filter 1 value')).toHaveValue('items-value')
  await expect(page.getByLabel('Filter 1 column')).toHaveValue('id')
})
