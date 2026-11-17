import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { characterOffset, currentStatement, currentStatementRange, statementRanges } from '../src/sql-statements.ts'

// Mirrors TestSplitStatements in internal/database/sqlscript_test.go so both
// splitters are checked against the same inputs.
const splitCases: [string, number][] = [
  ['', 0],
  ['select 1', 1],
  ['select 1; select 2;', 2],
  ['select 1;;  ; -- only a comment\n', 1],
  ["select 'a;b'; select \"a;b\"; select $tag$a;b$tag$; select E'a\\';b'; select 1 /* x; /* y; */ z */; select 2", 6],
  // $ inside an identifier does not start a dollar quote.
  ['select 1 as x$y$; select 2', 2],
  ['select 1 as a$$; select $$;$$', 2],
  // Dollar-quote tags may contain non-ASCII letters.
  ['select $é$a;b$é$; select 2', 2],
  ['select $1; select $2', 2],
  // Backslashes only escape in E'' strings, and only after a standalone E.
  ["select 'a\\'; select 2", 2],
  ["select pe'\\'; select 2", 2],
  ["select e'it\\'s;'; select 2", 2],
  // Quoted identifiers with doubled quotes and semicolons.
  ['select "a;""b" from t; select 2', 2],
  // Comments: line comments end at a newline, block comments nest.
  ['select 1 -- c;\n; select 2', 2],
  ['/* a; /* b; */ c; */ select 1; select 2 /* ; */', 2],
  // psql meta commands are sent to the server as part of the next statement.
  ['\\set x 1\nselect 1; select 2', 2],
]

test('splits statements like the Go splitter', () => {
  for (const [sql, want] of splitCases) {
    assert.equal(statementRanges(sql).length, want, JSON.stringify(sql))
  }
})
test('finds the statement at the cursor', () => {
  const sql = 'select 1;\nselect 2;'
  assert.equal(currentStatement(sql, 2), 'select 1;')
  assert.equal(currentStatement(sql, 12), 'select 2;')
  assert.equal(currentStatement(sql, sql.length), 'select 2;')
})
test('ignores semicolons in literals, identifiers, comments and dollar quotes', () => {
  for (const expression of ["'a;b'", '"a;b"', '"a;""b"', '$tag$a;b$tag$', '$é$a;b$é$', "E'a\\';b'", "e'it\\'s;'", '1 /* outer; /* inner; */ end */', '1 -- comment;\n']) {
    const sql = `select ${expression}; select 2;`
    assert.equal(currentStatement(sql, sql.indexOf(';')), `select ${expression};`)
  }
})
test('treats $ inside identifiers as part of the identifier', () => {
  const sql = 'select 1 as x$y$; select 2'
  assert.equal(currentStatement(sql, 3), 'select 1 as x$y$;')
  assert.equal(currentStatement(sql, sql.length), 'select 2')
  assert.deepEqual(statementRanges('select 1 as a$$; select $$;$$'), [{ from: 0, to: 16 }, { from: 17, to: 29 }])
  // Positional parameters are not dollar quotes either.
  assert.deepEqual(statementRanges('select $1; select $2'), [{ from: 0, to: 10 }, { from: 11, to: 20 }])
})
test('reports the trimmed range of the statement at the cursor', () => {
  const sql = '  select 1;\n\n  select 2  '
  const range = currentStatementRange(sql, sql.length)
  assert.equal(sql.slice(range.from, range.to), 'select 2')
  assert.deepEqual(currentStatementRange(sql, 0), { from: 2, to: 11 })
})
test('lists statement code ranges like the Go splitter', () => {
  const sql = "-- lead\nselect 'é';\n  select 2"
  assert.deepEqual(statementRanges(sql), [{ from: 8, to: 19 }, { from: 22, to: 30 }])
  // A psql meta line belongs to the statement after it.
  assert.deepEqual(statementRanges('\\set x 1\nselect 1; select 2'), [{ from: 0, to: 18 }, { from: 19, to: 27 }])
})
test('maps multibyte PostgreSQL positions to statements', () => {
  // Mirrors TestStatementAtMultibyte.
  const script = "/* ü */ SELECT '😀;';\n-- é\nSELECT bad"
  const ranges = statementRanges(script)
  assert.equal(ranges.length, 2)
  assert.equal(script.slice(ranges[0].from, ranges[0].to), "SELECT '😀;';")
  const position = [...script.slice(0, script.indexOf('bad'))].length + 1
  const offset = characterOffset(script, position)
  assert.equal(offset, script.indexOf('bad'))
  assert.equal(ranges.findIndex(range => offset < range.to) + 1, 2)
})
test('converts PostgreSQL character positions to UTF-16 offsets', () => {
  assert.equal(characterOffset('select 1', 1), 0)
  assert.equal(characterOffset('select 1', 8), 7)
  assert.equal(characterOffset("select '😀', nope", 14), 14)
})
