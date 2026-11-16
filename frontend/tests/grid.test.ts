import assert from 'node:assert/strict'
import test from 'node:test'
import { cellRange, draftValue, editValue, isBooleanType, isNumericType, saveSummary, selectionClipboardText, selectionCSV, tableChanges, type ColumnInfo, type DraftRow } from '../src/grid.ts'

const column: ColumnInfo = { name: 'value', dataType: 'text', nullable: true, hasDefault: false, generated: false, autoIncrement: false }
const row: DraftRow = { id: 'row-0', original: ['original'], identity: { tableOID: '123', ctid: '(0,1)', version: '42' }, added: false }

test('range selection works in both drag directions and includes boundaries', () => {
  const forward = cellRange({ row: 0, column: 1 }, { row: 2, column: 2 })
  assert.equal(forward.size, 6)
  assert.deepEqual(forward, cellRange({ row: 2, column: 2 }, { row: 0, column: 1 }))
})

test('CSV escapes commas, quotes, CR/LF, JSON and preserves exact numeric text', () => {
  const rows = [['a,b', 'say "hello"', 'one\ntwo'], [null, '9007199254740993', { answer: true }]]
  const all = cellRange({ row: 0, column: 0 }, { row: 1, column: 2 })
  assert.equal(selectionCSV(rows, all), '"a,b","say ""hello""","one\ntwo"\r\n,9007199254740993,"{""answer"":true}"')
  assert.equal(selectionCSV(rows, all, ['first,heading', 'second', 'third']), '"first,heading",second,third\r\n"a,b","say ""hello""","one\ntwo"\r\n,9007199254740993,"{""answer"":true}"')
})

test('disjoint selections retain positions and omit unselected values', () => {
  assert.equal(selectionCSV([['secret', 'chosen', 'hidden'], ['unused', 'skip', 'last']], new Set(['0:1', '1:2'])), 'chosen,\r\n,last')
  assert.equal(selectionCSV([['secret', 'chosen', 'hidden'], ['unused', 'skip', 'last']], new Set(['0:1', '1:2']), ['ignored', 'middle', 'last']), 'middle,last\r\nchosen,\r\n,last')
  assert.equal(selectionCSV([['a']], new Set()), '')
  assert.equal(selectionCSV([['a']], new Set(['99:0'])), '')
})

test('a single copied cell is its raw value; headers or several cells use CSV', () => {
  const rows = [['a,"b"\nc', null, { key: 1 }]]
  assert.equal(selectionClipboardText(rows, new Set(['0:0'])), 'a,"b"\nc')
  assert.equal(selectionClipboardText(rows, new Set(['0:1'])), '')
  assert.equal(selectionClipboardText(rows, new Set(['0:2'])), '{"key":1}')
  assert.equal(selectionClipboardText(rows, new Set(['0:0']), ['value']), 'value\r\n"a,""b""\nc"')
  assert.equal(selectionClipboardText(rows, new Set(['0:0', '0:2'])), '"a,""b""\nc",,"{""key"":1}"')
  assert.equal(selectionClipboardText(rows, new Set(['5:0'])), '')
})

test('column types classify numeric and boolean values', () => {
  for (const type of ['bigint', 'integer', 'numeric(10,2)', 'double precision', 'real', 'smallint', 'money']) assert.ok(isNumericType(type), type)
  for (const type of ['text', 'integer[]', 'interval', 'character varying(20)', 'boolean', 'json']) assert.ok(!isNumericType(type), type)
  assert.ok(isBooleanType('boolean')); assert.ok(!isBooleanType('boolean[]'))
})

test('save summaries count each change kind', () => {
  const summary = saveSummary([{ kind: 'delete', identity: null, values: {} }, { kind: 'insert', identity: null, values: {} }, { kind: 'update', identity: null, values: {} }], 'public', 'users')
  assert.deepEqual(summary, { inserted: 1, updated: 1, deleted: 1, total: 3, message: 'Saved 3 changes to public.users.' })
  assert.equal(saveSummary([{ kind: 'update', identity: null, values: {} }], 'public', 'users').message, 'Saved 1 change to public.users.')
})

test('no-op editing and reverting remove pending changes', () => {
  const changed = editValue({}, row, column, 0, 'edited')
  assert.equal(draftValue(row, column, 0, changed), 'edited')
  assert.deepEqual(editValue(changed, row, column, 0, 'original'), {})
  assert.deepEqual(editValue(changed, row, column, 0, undefined), {})
})

test('column names that match JavaScript prototype properties are preserved', () => {
  const named = { ...column, name: '__proto__' }
  const edits = editValue({}, row, named, 0, 'edited')
  assert.equal(draftValue(row, named, 0, edits), 'edited')
  assert.equal(JSON.stringify(edits), '{"row-0":{"__proto__":"edited"}}')
})

test('NULL, empty strings and omitted defaults remain distinct', () => {
  const added: DraftRow = { id: 'new-0', original: [], identity: null, added: true }
  assert.equal(draftValue(added, column, 0, {}), undefined)
  assert.equal(draftValue(added, column, 0, editValue({}, added, column, 0, null)), null)
  assert.equal(draftValue(added, column, 0, editValue({}, added, column, 0, '')), '')
  const nullRow = { ...row, original: [null] }
  assert.deepEqual(editValue({}, nullRow, column, 0, null), {})
  assert.deepEqual(editValue({}, nullRow, column, 0, ''), { 'row-0': { value: '' } })
})

test('save serializes deletes first, omits deleted edits, and retains default-only inserts', () => {
  const added: DraftRow = { id: 'new-0', original: [], identity: null, added: true }
  const other = { ...row, id: 'row-1' }
  assert.deepEqual(tableChanges([added, row, other], { 'row-0': { value: 'ignored' }, 'row-1': { value: 'changed' } }, new Set(['row-0'])), [
    { kind: 'delete', identity: row.identity, values: {} },
    { kind: 'insert', identity: null, values: {} },
    { kind: 'update', identity: row.identity, values: { value: 'changed' } },
  ])
  assert.deepEqual(tableChanges([added], {}, new Set(['new-0'])), [])
})
