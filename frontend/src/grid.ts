export type ColumnInfo = {
  name: string; dataType: string; nullable: boolean; hasDefault: boolean; generated: boolean; autoIncrement: boolean
  defaultValue?: string; generationExpression?: string; identityGeneration?: string
}
export type RowIdentity = { tableOID: string; ctid: string; version: string }
export type TableData = { columns: ColumnInfo[]; rows: unknown[][]; rowCount: number; identities: RowIdentity[] }
export type CellPosition = { row: number; column: number }
export type CellInput = string | null
export type DraftRow = { id: string; original: unknown[]; identity: RowIdentity | null; added: boolean }
export type RowEdits = Record<string, Record<string, CellInput>>
export type TableChange = { kind: string; identity: RowIdentity | null; values: Record<string, CellInput> }

export function valueText(value: unknown): string {
  if (value === null || value === undefined) return ''
  return typeof value === 'object' ? JSON.stringify(value) : String(value)
}

export function cellKey(position: CellPosition) { return `${position.row}:${position.column}` }

export function cellRange(start: CellPosition, end: CellPosition): Set<string> {
  const cells = new Set<string>()
  for (let row = Math.min(start.row, end.row); row <= Math.max(start.row, end.row); row++) {
    for (let column = Math.min(start.column, end.column); column <= Math.max(start.column, end.column); column++) {
      cells.add(cellKey({ row, column }))
    }
  }
  return cells
}

// Keep disjoint selections in their grid positions; unselected cells inside
// the bounding rectangle become empty fields. NULL/default also copy as empty.
// Column headers are only included when requested.
export function selectionCSV(rows: unknown[][], selection: Set<string>, headers?: string[]): string {
  const positions = [...selection].map((key) => key.split(':').map(Number))
    .filter(([row, column]) => row >= 0 && row < rows.length && column >= 0 && column < rows[row].length)
  if (!positions.length) return ''
  let minRow = rows.length, maxRow = 0, minColumn = Infinity, maxColumn = 0
  for (const [row, column] of positions) {
    minRow = Math.min(minRow, row); maxRow = Math.max(maxRow, row)
    minColumn = Math.min(minColumn, column); maxColumn = Math.max(maxColumn, column)
  }
  const csvField = (text: string) => /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
  const lines: string[] = headers ? [headers.slice(minColumn, maxColumn + 1).map(csvField).join(',')] : []
  for (let row = minRow; row <= maxRow; row++) {
    const fields: string[] = []
    for (let column = minColumn; column <= maxColumn; column++) {
      const text = selection.has(cellKey({ row, column })) ? valueText(rows[row][column]) : ''
      fields.push(csvField(text))
    }
    lines.push(fields.join(','))
  }
  return lines.join('\r\n')
}

// A single cell copies its raw value so it can be pasted anywhere unchanged.
export function selectionClipboardText(rows: unknown[][], selection: Set<string>, headers?: string[]): string {
  if (selection.size === 1 && !headers) {
    const [row, column] = [...selection][0].split(':').map(Number)
    return row >= 0 && row < rows.length && column >= 0 && column < rows[row].length ? valueText(rows[row][column]) : ''
  }
  return selectionCSV(rows, selection, headers)
}

const numericType = /^(smallint|integer|bigint|int|int2|int4|int8|numeric|decimal|real|double precision|float4|float8|money|oid|smallserial|serial|bigserial)\b/i
export function isNumericType(dataType: string) { return numericType.test(dataType.trim()) && !dataType.includes('[]') }
export function isBooleanType(dataType: string) { return /^bool(ean)?$/i.test(dataType.trim()) }

export type SaveSummary = { inserted: number; updated: number; deleted: number; total: number; message: string }
export function saveSummary(changes: TableChange[], schema: string, table: string): SaveSummary {
  const count = (kind: string) => changes.filter((change) => change.kind === kind).length
  const total = changes.length
  return { inserted: count('insert'), updated: count('update'), deleted: count('delete'), total, message: `Saved ${total} ${total === 1 ? 'change' : 'changes'} to ${schema}.${table}.` }
}

export function draftValue(row: DraftRow, column: ColumnInfo, index: number, edits: RowEdits): unknown {
  if (Object.prototype.hasOwnProperty.call(edits[row.id] ?? {}, column.name)) return edits[row.id][column.name]
  return row.added ? undefined : row.original[index]
}

export function editValue(edits: RowEdits, row: DraftRow, column: ColumnInfo, index: number, value: CellInput | undefined): RowEdits {
  let values = { ...edits[row.id] }
  const unchanged = !row.added && (row.original[index] == null ? value === null : value !== null && value !== undefined && valueText(row.original[index]) === value)
  if (value === undefined || unchanged) delete values[column.name]
  else values = { ...values, [column.name]: value }
  const next = { ...edits }
  if (Object.keys(values).length) next[row.id] = values
  else delete next[row.id]
  return next
}

export function tableChanges(rows: DraftRow[], edits: RowEdits, deleted: Set<string>): TableChange[] {
  // Delete first so replacing a row with the same unique key works in one save.
  return [
    ...rows.filter((row) => !row.added && deleted.has(row.id)).map((row) => ({ kind: 'delete', identity: row.identity, values: {} })),
    ...rows.filter((row) => !deleted.has(row.id) && (row.added || Object.keys(edits[row.id] ?? {}).length > 0))
      .map((row) => ({ kind: row.added ? 'insert' : 'update', identity: row.identity, values: edits[row.id] ?? {} })),
  ]
}
