export type ExportFormat = 'csv' | 'json' | 'sql'
export function quoteIdentifier(value: string) { return `"${value.split('"').join('""')}"` }
export function exportData(columns: string[], rows: unknown[][], format: ExportFormat, table?: { schema: string; name: string }) {
  const text = (value: unknown) => typeof value === 'object' && value !== null ? JSON.stringify(value) : String(value)
  if (format === 'csv') {
    const cell = (value: unknown) => value == null ? '' : /[",\r\n]/.test(text(value)) ? `"${text(value).split('"').join('""')}"` : text(value)
    return [columns, ...rows].map((row) => row.map(cell).join(',')).join('\r\n') + '\r\n'
  }
  if (format === 'json') {
    // Preserve duplicate query aliases without discarding either value.
    const used = new Set<string>()
    const keys = columns.map((column) => {
      let key = column
      for (let suffix = 2; used.has(key); suffix++) key = `${column}_${suffix}`
      used.add(key)
      return key
    })
    return JSON.stringify(rows.map((row) => Object.fromEntries(keys.map((key, index) => [key, row[index]]))), null, 2)
  }
  if (!table) throw new Error('A table is required for SQL export.')
  const name = `${quoteIdentifier(table.schema)}.${quoteIdentifier(table.name)}`
  const literal = (value: unknown) => value === undefined ? 'DEFAULT' : value === null ? 'NULL' : typeof value === 'boolean' ? value ? 'TRUE' : 'FALSE' : `E'${text(value).split('\\').join('\\\\').split("'").join("''")}'`
  return rows.map((row) => `INSERT INTO ${name} (${columns.map(quoteIdentifier).join(', ')}) OVERRIDING SYSTEM VALUE VALUES (${row.map(literal).join(', ')});`).join('\n') + '\n'
}
