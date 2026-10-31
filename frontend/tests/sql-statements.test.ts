import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { currentStatement } from '../src/sql-statements.ts'

test('finds the statement at the cursor', () => {
  const sql = 'select 1;\nselect 2;'
  assert.equal(currentStatement(sql, 2), 'select 1;')
  assert.equal(currentStatement(sql, 12), 'select 2;')
  assert.equal(currentStatement(sql, sql.length), 'select 2;')
})
test('ignores semicolons in literals, identifiers, comments and dollar quotes', () => {
  for (const expression of ["'a;b'", '"a;b"', '$tag$a;b$tag$', "E'a\\';b'", '1 /* outer; /* inner; */ end */', '1 -- comment;\n']) {
    const sql = `select ${expression}; select 2;`
    assert.equal(currentStatement(sql, sql.indexOf(';')), `select ${expression};`)
  }
})
