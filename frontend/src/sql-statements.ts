export type StatementRange = { from: number; to: number }

type Scan = {
  /** Offsets just after each top-level semicolon, preceded by 0. */
  boundaries: number[]
  /** Code ranges of non-empty statements, excluding surrounding whitespace and comments. */
  statements: StatementRange[]
}

/** Split SQL on top-level semicolons, ignoring delimiters in SQL literals and comments. */
function scan(sql: string): Scan {
  const boundaries = [0]
  const statements: StatementRange[] = []
  let codeFrom = -1, codeTo = -1
  const mark = (from: number, to: number) => { if (codeFrom < 0) codeFrom = from; codeTo = to }
  const flush = () => { if (codeFrom >= 0) statements.push({ from: codeFrom, to: codeTo }); codeFrom = codeTo = -1 }
  let i = 0
  while (i < sql.length) {
    const c = sql[i], next = sql[i + 1]
    if (c === "'" || c === '"') {
      const start = i
      const quote = c; const escaped = c === "'" && i > 0 && /[eE]/.test(sql[i - 1]) && (i < 2 || !/[\w$\u0080-\uffff]/.test(sql[i - 2])); i++
      while (i < sql.length) {
        if (sql[i] === quote && sql[i + 1] === quote) { i += 2; continue }
        if (sql[i] === quote) { i++; break }
        // PostgreSQL escape strings use backslashes to escape quotes.
        if (escaped && sql[i] === '\\' && i + 1 < sql.length) i += 2
        else i++
      }
      mark(start, i)
    } else if (c === '-' && next === '-') {
      i += 2; while (i < sql.length && sql[i] !== '\n') i++
    } else if (c === '/' && next === '*') {
      i += 2; let depth = 1
      while (i < sql.length && depth) {
        if (sql[i] === '/' && sql[i + 1] === '*') { depth++; i += 2 }
        else if (sql[i] === '*' && sql[i + 1] === '/') { depth--; i += 2 }
        else i++
      }
    } else if (c === '$') {
      const start = i
      const tag = sql.slice(i).match(/^\$(?:[A-Za-z_\u0080-\uffff][\w\u0080-\uffff]*)?\$/)?.[0]
      // Like Go's isIdentifierRune, whitespace never belongs to a tag.
      if (tag && !/\s/.test(tag)) { const end = sql.indexOf(tag, i + tag.length); i = end < 0 ? sql.length : end + tag.length }
      else i++
      mark(start, i)
    } else if (c === ';') {
      if (codeFrom >= 0) codeTo = i + 1
      boundaries.push(++i)
      flush()
    } else if (/\s/.test(c)) i++
    else if (/[A-Za-z_\u0080-\uffff]/.test(c)) {
      // Identifiers and keywords are consumed whole, because PostgreSQL allows $
      // inside them: x$y$ is an identifier, not the start of a dollar quote.
      const start = i
      i++
      while (i < sql.length && /[\w$\u0080-\uffff]/.test(sql[i]) && !/\s/.test(sql[i])) i++
      mark(start, i)
    } else { mark(i, i + 1); i++ }
  }
  flush()
  return { boundaries, statements }
}

/** Return the range of the statement containing the cursor, trimmed of surrounding whitespace. */
export function currentStatementRange(sql: string, cursor: number): StatementRange {
  const { boundaries } = scan(sql)
  const pos = Math.max(0, Math.min(cursor, sql.length))
  let index = boundaries.findIndex((boundary, n) => n > 0 && pos < boundary)
  if (index < 0) index = boundaries.length
  // A cursor at the end of a terminated script belongs to the preceding statement.
  if (index === boundaries.length && pos === sql.length && !sql.slice(boundaries[index - 1]).trim() && index > 1) index--
  let from = boundaries[index - 1], to = boundaries[index] ?? sql.length
  while (from < to && /\s/.test(sql[from])) from++
  while (to > from && /\s/.test(sql[to - 1])) to--
  return { from, to }
}

/** Return the statement containing the cursor, ignoring delimiters in SQL literals and comments. */
export function currentStatement(sql: string, cursor: number): string {
  const { from, to } = currentStatementRange(sql, cursor)
  return sql.slice(from, to)
}

/**
 * Return the code range of every statement PostgreSQL would run, in order.
 * Matches splitStatements in internal/database/sqlstatements.go.
 */
export function statementRanges(sql: string): StatementRange[] {
  return scan(sql).statements
}

/** Convert PostgreSQL's 1-based character position into a 0-based UTF-16 offset. */
export function characterOffset(text: string, position: number): number {
  let offset = 0
  let characters = 0
  for (const character of text) {
    if (characters >= position - 1) break
    offset += character.length
    characters++
  }
  return offset
}
