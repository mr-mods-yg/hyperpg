/** Return the statement containing the cursor, ignoring delimiters in SQL literals and comments. */
export function currentStatement(sql: string, cursor: number): string {
  const boundaries = [0]
  let i = 0
  while (i < sql.length) {
    const c = sql[i], next = sql[i + 1]
    if (c === "'" || c === '"') {
      const quote = c; const escaped = c === "'" && i > 0 && /[eE]/.test(sql[i - 1]) && (i < 2 || !/[\w$]/.test(sql[i - 2])); i++
      while (i < sql.length) {
        if (sql[i] === quote && sql[i + 1] === quote) { i += 2; continue }
        if (sql[i] === quote) { i++; break }
        // PostgreSQL escape strings use backslashes to escape quotes.
        if (escaped && sql[i] === '\\' && i + 1 < sql.length) i += 2
        else i++
      }
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
      const tag = sql.slice(i).match(/^\$(?:[a-zA-Z_][\w]*)?\$/)?.[0]
      if (tag) { const end = sql.indexOf(tag, i + tag.length); i = end < 0 ? sql.length : end + tag.length }
      else i++
    } else if (c === ';') { boundaries.push(++i) }
    else i++
  }
  const pos = Math.max(0, Math.min(cursor, sql.length))
  let index = boundaries.findIndex((boundary, n) => n > 0 && pos < boundary)
  if (index < 0) index = boundaries.length
  // A cursor at the end of a terminated script belongs to the preceding statement.
  if (index === boundaries.length && pos === sql.length && !sql.slice(boundaries[index - 1]).trim() && index > 1) index--
  return sql.slice(boundaries[index - 1], boundaries[index] ?? sql.length).trim()
}
