import { useRef, useState } from 'react'
import { PostgresService } from './services'
import { exportData, type ExportFormat } from './export-data'
import type { TableQueryOptions } from './table-query'
import './feature-panels.css'

type FullTable = { databaseId: string; schema: string; name: string; options: TableQueryOptions }
export default function ExportMenu({ columns, rows, selectedRows, table, generatedColumns = [], fileName = 'results' }: { columns: string[]; rows: unknown[][]; selectedRows?: unknown[][]; table?: FullTable; fileName?: string; generatedColumns?: string[] }) {
  const [format, setFormat] = useState<ExportFormat>('csv')
  const [scope, setScope] = useState('loaded')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const menuRef = useRef<HTMLDetailsElement>(null)
  async function save() {
    setBusy(true); setError('')
    try {
      const name = `${fileName.replace(/[\\/:*?"<>|]/g, '_')}.${format}`
      const path = await PostgresService.ChooseExportPath(name)
      if (!path) return
      if (scope === 'table' && table) await PostgresService.ExportTableData(table.databaseId, table.schema, table.name, table.options, format, path)
      else {
        const included = columns.map((column, index) => ({ column, index })).filter(({ column }) => format !== 'sql' || !generatedColumns.includes(column))
        const source = scope === 'selected' ? selectedRows ?? [] : rows
        await PostgresService.WriteExportFile(path, exportData(included.map(({ column }) => column), source.map((row) => included.map(({ index }) => row[index])), format, table))
      }
      if (menuRef.current) menuRef.current.open = false
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)) }
    finally { setBusy(false) }
  }
  return <details className="export-menu" ref={menuRef} onKeyDown={(event) => { if (event.key === 'Escape' && menuRef.current) { menuRef.current.open = false; menuRef.current.querySelector('summary')?.focus(); event.stopPropagation() } }}>
    <summary className="pagination-button">Export</summary>
    <div className="export-menu-panel"><label>Format<select aria-label="Export format" value={format} disabled={busy} onChange={(event) => setFormat(event.target.value as ExportFormat)}><option value="csv">CSV</option><option value="json">JSON</option>{table ? <option value="sql">SQL inserts</option> : null}</select></label>
      <label>Rows<select aria-label="Export rows" value={scope} disabled={busy} onChange={(event) => setScope(event.target.value)}><option value="loaded">Loaded rows</option>{selectedRows ? <option value="selected" disabled={!selectedRows.length}>Selected rows</option> : null}{table ? <option value="table">Entire filtered table</option> : null}</select></label>
      {error ? <span role="alert">{error}</span> : null}<button className="pagination-button" type="button" disabled={busy || scope === 'selected' && !selectedRows?.length} onClick={() => void save()}>{busy ? 'Exporting…' : 'Save file'}</button>
    </div>
  </details>
}
