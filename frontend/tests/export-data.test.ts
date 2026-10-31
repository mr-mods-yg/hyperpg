import assert from 'node:assert/strict'
import test from 'node:test'
import { exportData } from '../src/export-data.ts'

test('CSV exports headers and escapes text without losing exact values', () => {
  assert.equal(exportData(['name', 'amount'], [['a,"b"', '9007199254740993'], ['line\nnext', null]], 'csv'), 'name,amount\r\n"a,""b""",9007199254740993\r\n"line\nnext",\r\n')
})
test('JSON preserves NULL, booleans, precision strings, and duplicate aliases', () => {
  assert.deepEqual(JSON.parse(exportData(['value', 'value', '__proto__'], [[null, '12345678901234567890.01', false]], 'json')), [{ value: null, value_2: '12345678901234567890.01', '__proto__': false }].map(item => ({ ...item, ['__proto__']: false })))
})
test('SQL escapes qualified names, backslashes, quotes, NULL, and DEFAULT', () => {
  assert.equal(exportData(['a"b', 'nil', 'default'], [["a\\b'c", null, undefined]], 'sql', { schema: 'a"s', name: 'table' }), 'INSERT INTO "a""s"."table" ("a""b", "nil", "default") OVERRIDING SYSTEM VALUE VALUES (E\'a\\\\b\'\'c\', NULL, DEFAULT);\n')
  assert.throws(() => exportData(['a'], [['b']], 'sql'), /table is required/)
})
