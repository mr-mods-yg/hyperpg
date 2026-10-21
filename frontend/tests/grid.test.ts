import assert from 'node:assert/strict'
import test from 'node:test'
import { cellRange, draftValue, editValue, selectionCSV, tableChanges, type ColumnInfo, type DraftRow } from '../src/grid.ts'

const column: ColumnInfo = { name: 'value', dataType: 'text', nullable: true, hasDefault: false, generated: false, autoIncrement: false }
const row: DraftRow = { id: 'row-0', original: ['original'], identity: { tableOID: '123', ctid: '(0,1)', version: '42' }, added: false }

test('range selection works in both drag directions and includes boundaries', () => {
  const forward = cellRange({ row: 0, column: 1 }, { row: 2, column: 2 })
  assert.equal(forward.size, 6)
  assert.deepEqual(forward, cellRange({ row: 2, column: 2 }, { row: 0, column: 1 }))
})

test('CSV escapes commas, quotes, CR/LF, JSON and preserves exact numeric text', () => {
  const rows = [['a,b', 'say "hello"', 'one\ntwo'], [null, '9007199254740993', { answer: true }]]
  assert.equal(selectionCSV(rows, cellRange({ row: 0, column: 0 }, { row: 1, column: 2 })), '"a,b","say ""hello""","one\ntwo"\r\n,9007199254740993,"{""answer"":true}"')
})

test('disjoint selections retain positions and omit unselected values', () => {
  assert.equal(selectionCSV([['secret', 'chosen', 'hidden'], ['unused', 'skip', 'last']], new Set(['0:1', '1:2'])), 'chosen,\r\n,last')
  assert.equal(selectionCSV([['a']], new Set()), '')
  assert.equal(selectionCSV([['a']], new Set(['99:0'])), '')
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
