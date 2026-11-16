import { expect, test, type Page } from '@playwright/test'

const fixture = `
const connection = { id: 'test', name: 'Test', host: 'localhost', database: 'test', username: 'test', showAllDatabases: false };
const state = window.sqlEditorState = { calls: [], cancels: [], pending: null };
export async function ListSavedConnections() { return [connection]; }
export async function OpenSavedConnection() { return connection; }
export async function ListDatabases() { return ['test']; }
export async function OpenDatabase() { return 'test'; }
export async function ListTables() { return []; }
export async function GetSchemaCompletions() { return []; }
export async function ExecuteSQLScript(id, script, executionId) {
  state.calls.push({ id, script, executionId });
  if (script.includes('late_start')) {
    // The backend registers the run only after a delay, so early cancels report false.
    return new Promise(resolve => { setTimeout(() => { state.pending = { executionId, resolve }; }, 400); });
  }
  if (script.includes('pg_sleep')) {
    return new Promise(resolve => { state.pending = { executionId, resolve }; });
  }
  if (script.includes('nme')) {
    return {
      results: [
        { columns: ['value'], rows: [['1']], command: 'SELECT 1', truncated: false, durationMs: 1.5 },
        { columns: [], rows: [], command: 'UPDATE 2', truncated: false, durationMs: 0.6 },
      ],
      error: 'ERROR: column "nme" does not exist\\nLINE 3: SELECT nme FROM users;\\n               ^\\nHINT: Perhaps you meant to reference the column "users.name".',
      rolledBack: false, cancelled: false, statementCount: 5, failedStatement: 3,
      errorPosition: Array.from(script).length - Array.from(script.slice(script.indexOf('nme'))).length + 1, rolledBackFrom: 1,
    };
  }
  return { results: [{ columns: ['value', 'amount'], rows: [['ok', '12.50'], [null, '3']], command: 'SELECT 2', truncated: false, durationMs: 2 }], error: '', rolledBack: false, statementCount: 1 };
}
export async function CancelSQLScript(executionId) {
  state.cancels.push(executionId);
  const pending = state.pending;
  if (!pending || pending.executionId !== executionId) return false;
  setTimeout(() => pending.resolve({ results: [{ columns: ['value'], rows: [['1']], command: 'SELECT 1', truncated: false }], error: 'Query cancelled', rolledBack: true, cancelled: true, statementCount: 2, failedStatement: 2, errorPosition: 0, rolledBackFrom: 0 }), 50);
  return true;
}
`

async function openEditor(page: Page) {
  await page.route('**/bindings/changeme/internal/database/postgresservice.*', route => route.fulfill({ contentType: 'text/javascript', body: fixture }))
  await page.route('**/bindings/changeme/internal/updates/updateservice.*', route => route.fulfill({ contentType: 'text/javascript', body: 'export async function CheckForUpdates() { return { available: false } }' }))
  await page.goto('/')
  await page.getByRole('button', { name: 'New SQL script' }).click()
  return page.getByRole('textbox', { name: 'SQL script' })
}

const calls = (page: Page) => page.evaluate(() => (window as any).sqlEditorState.calls.map(({ script }: { script: string }) => script))

test('Mod-Enter runs the selection or current statement and Shift-Mod-Enter runs the script', async ({ page }) => {
  const editor = await openEditor(page)
  const run = page.getByRole('button', { name: 'Run script', exact: true })
  await expect(run).toHaveAttribute('aria-keyshortcuts', 'Control+Shift+Enter')
  await expect(run).toHaveAttribute('title', 'Run script (Ctrl+Shift+Enter)')
  await editor.fill('SELECT 1;\nSELECT 2;')
  await editor.focus()
  await page.keyboard.press('Control+End')
  await page.keyboard.press('Control+Enter')
  await expect.poll(() => calls(page)).toEqual(['SELECT 2;'])
  // The shortcut runs instead of inserting a newline.
  await expect(editor.locator('.cm-line')).toHaveCount(2)
  await expect(page.getByRole('cell', { name: 'ok' })).toBeVisible()
  await expect(page.getByRole('status').filter({ hasText: 'statement succeeded' })).toHaveText(/^1 statement succeeded · 2 rows · \d+ ms$/)
  await expect(page.getByRole('region', { name: 'Query results' })).not.toHaveAttribute('aria-live', /.*/)
  await expect(page.getByRole('cell', { name: '12.50' })).toHaveCSS('text-align', 'right')
  await expect(page.getByRole('rowheader', { name: '1' })).toBeVisible()

  await page.keyboard.press('Control+Home')
  await page.keyboard.press('Control+Enter')
  await expect.poll(() => calls(page)).toEqual(['SELECT 2;', 'SELECT 1;'])

  await page.keyboard.press('Shift+End')
  await expect(page.getByRole('button', { name: 'Run selection' })).toHaveAttribute('aria-keyshortcuts', 'Control+Enter')
  await page.keyboard.press('Control+Enter')
  await expect.poll(() => calls(page)).toEqual(['SELECT 2;', 'SELECT 1;', 'SELECT 1;'])

  await page.keyboard.press('Control+Shift+Enter')
  await expect.poll(() => calls(page)).toEqual(['SELECT 2;', 'SELECT 1;', 'SELECT 1;', 'SELECT 1;\nSELECT 2;'])
  const ids = await page.evaluate(() => (window as any).sqlEditorState.calls.map(({ executionId }: { executionId: string }) => executionId))
  expect(new Set(ids).size).toBe(4)
  for (const id of ids) expect(id).toMatch(/\S{8,}/)
})

test('a running query shows a live timer and can be cancelled', async ({ page }) => {
  const editor = await openEditor(page)
  await editor.fill('SELECT 1; SELECT pg_sleep(60);')
  await page.getByRole('button', { name: 'Run script', exact: true }).click()
  const cancel = page.getByRole('button', { name: 'Cancel', exact: true })
  await expect(cancel).toBeVisible()
  await expect(cancel).toHaveAttribute('aria-keyshortcuts', 'Escape')
  await expect(page.getByRole('button', { name: 'Run script', exact: true })).toHaveCount(0)
  await expect(page.getByRole('status').filter({ hasText: 'Running query…' })).toBeVisible()
  const timer = page.locator('.sql-run-timer')
  await expect(timer).toHaveText(/^Running… \d+\.\d s$/)
  const first = await timer.textContent()
  await expect.poll(() => timer.textContent(), { timeout: 2000 }).not.toBe(first)
  // Closing a running script cancels its query first.
  await expect(page.getByRole('button', { name: 'Cancel query and close Script 1' })).toBeEnabled()

  await editor.focus()
  await page.keyboard.press('Escape')
  await expect(page.getByRole('status').filter({ hasText: 'Query cancelled' })).toBeVisible()
  const executionId = await page.evaluate(() => (window as any).sqlEditorState.calls[0].executionId)
  expect(await page.evaluate(() => (window as any).sqlEditorState.cancels)).toEqual([executionId])
  const banner = page.locator('.sql-error')
  await expect(banner).toContainText('Query cancelled')
  await expect(banner).toContainText('Stopped during statement 2 of 2.')
  await expect(banner).toContainText('The open transaction was rolled back.')
  await expect(page.getByRole('button', { name: 'Run script', exact: true })).toBeEnabled()
  await expect(page.getByRole('button', { name: 'Close Script 1' })).toBeEnabled()
  // The editor marks the statement that was running.
  await expect(page.locator('.cm-sql-error-statement')).toHaveText('SELECT pg_sleep(60);')

  // The Cancel button works as well as Escape.
  await page.getByRole('button', { name: 'Run script', exact: true }).click()
  await page.getByRole('button', { name: 'Cancel', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Run script', exact: true })).toBeEnabled()
  expect(await page.evaluate(() => (window as any).sqlEditorState.cancels.length)).toBe(2)
})

test('a cancel sent before the backend registers the run is retried until it lands', async ({ page }) => {
  const editor = await openEditor(page)
  await editor.fill('SELECT late_start, pg_sleep(60);')
  await page.getByRole('button', { name: 'Run script', exact: true }).click()
  await page.getByRole('button', { name: 'Cancel', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Cancelling…' })).toBeDisabled()
  await expect(page.getByRole('status').filter({ hasText: 'Query cancelled' })).toBeVisible()
  const { executionId, cancels } = await page.evaluate(() => ({ executionId: (window as any).sqlEditorState.calls[0].executionId, cancels: (window as any).sqlEditorState.cancels }))
  // The first attempts were refused, then a retry reached the registered run.
  expect(cancels.length).toBeGreaterThan(1)
  expect(new Set(cancels)).toEqual(new Set([executionId]))
  await expect(page.getByRole('button', { name: 'Run script', exact: true })).toBeEnabled()
  // Retries stop once the run has finished.
  const settled = cancels.length
  await page.waitForTimeout(400)
  expect(await page.evaluate(() => (window as any).sqlEditorState.cancels.length)).toBe(settled)
})

test('multi-statement errors name the failed statement and mark it in the editor', async ({ page }) => {
  const editor = await openEditor(page)
  await editor.fill('SELECT 1;\nUPDATE users SET name = name;\nSELECT nme FROM users;\nSELECT 4;\nSELECT 5;')
  await page.keyboard.press('Control+Shift+Enter')
  await expect(page.getByRole('status').filter({ hasText: 'Statement 3 of 5 failed' })).toBeVisible()
  const banner = page.locator('.sql-error')
  await expect(banner).toContainText('Statement 3 of 5 failed')
  await expect(banner).toContainText('Changes from statements 1–2 were rolled back. Statements 4–5 were not run.')
  const text = banner.locator('pre')
  await expect(text).toHaveCSS('white-space', 'pre-wrap')
  expect(await text.evaluate((element) => element.textContent)).toContain('LINE 3: SELECT nme FROM users;\n               ^\nHINT:')
  // The error sits after the results that completed before the failure.
  expect(await page.locator('.sql-results').evaluate((element) => {
    const children = Array.from(element.querySelectorAll('.sql-result, .sql-result-command, .sql-error'))
    return children.map((child) => child.className.split(' ')[0])
  })).toEqual(['sql-result', 'sql-result-command', 'sql-error'])
  await expect(page.locator('.sql-result-command')).toHaveText(/UPDATE 2/)
  await expect(page.locator('.cm-sql-error-statement')).toHaveText('SELECT nme FROM users;')
  await expect(page.locator('.cm-sql-error-point')).toHaveText('nme')

  await editor.focus()
  await page.keyboard.press('Control+End')
  await page.keyboard.type(' ')
  await expect(page.locator('.cm-sql-error-statement')).toHaveCount(0)
  await expect(page.locator('.cm-sql-error-point')).toHaveCount(0)
})
