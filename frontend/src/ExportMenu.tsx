import Button, { buttonClassName } from './ui/Button'
import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from 'react'
import { PostgresService } from './services'
import { exportData, type ExportFormat } from './export-data'
import Icon from './Icon'
import type { TableQueryOptions } from './table-query'
import './ExportMenu.css'

type FullTable = { databaseId: string; schema: string; name: string; options: TableQueryOptions }
type Props = {
  columns: string[]
  rows: unknown[][]
  selectedRows?: unknown[][]
  table?: FullTable
  fileName?: string
  generatedColumns?: string[]
  // The rows were narrowed by "Search this page".
  searchActive?: boolean
  // Shown above the options, e.g. to explain that unsaved edits are excluded.
  note?: string
  // Receives the success message; without it the menu shows the message itself.
  onExported?: (message: string) => void
}

const plural = (count: number, one: string) => `${count.toLocaleString()} ${count === 1 ? one : `${one}s`}`
const baseName = (path: string) => path.split(/[\\/]/).pop() || path

export default function ExportMenu({ columns, rows, selectedRows, table, generatedColumns = [], fileName = 'results', searchActive = false, note, onExported }: Props) {
  const [format, setFormat] = useState<ExportFormat>('csv')
  const [scope, setScope] = useState('loaded')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [status, setStatus] = useState('')
  const [open, setOpen] = useState(false)
  const [position, setPosition] = useState<CSSProperties>({ visibility: 'hidden' })
  const menuRef = useRef<HTMLDetailsElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!status) return
    const timer = window.setTimeout(() => setStatus(''), 8000)
    return () => window.clearTimeout(timer)
  }, [status])
  useLayoutEffect(() => {
    if (!open) return
    const menu = menuRef.current
    const panel = panelRef.current
    const trigger = menu?.querySelector('summary')
    if (!menu || !panel || !trigger) return
    const place = () => {
      const anchor = trigger.getBoundingClientRect()
      const height = panel.getBoundingClientRect().height
      const below = window.innerHeight - anchor.bottom - 14
      const above = anchor.top - 14
      const placeAbove = height > below && above > below
      const available = Math.max(0, placeAbove ? above : below)
      const top = placeAbove ? Math.max(8, anchor.top - Math.min(height, available) - 6) : anchor.bottom + 6
      const left = Math.max(8, Math.min(anchor.right - panel.offsetWidth, window.innerWidth - panel.offsetWidth - 8))
      setPosition({ top, left, maxHeight: available, visibility: 'visible' })
    }
    const dismiss = (event: Event) => {
      if (!menu.contains(event.target as Node)) menu.open = false
    }
    const observer = new ResizeObserver(place)
    observer.observe(panel)
    place()
    document.addEventListener('pointerdown', dismiss)
    document.addEventListener('focusin', dismiss)
    window.addEventListener('resize', place)
    window.addEventListener('scroll', place, true)
    return () => {
      observer.disconnect()
      document.removeEventListener('pointerdown', dismiss)
      document.removeEventListener('focusin', dismiss)
      window.removeEventListener('resize', place)
      window.removeEventListener('scroll', place, true)
    }
  }, [open])
  async function save() {
    setBusy(true); setError(''); setStatus('')
    try {
      const name = `${fileName.replace(/[\\/:*?"<>|]/g, '_')}.${format}`
      const path = await PostgresService.ChooseExportPath(name)
      if (!path) return
      let message: string
      if (scope === 'table' && table) {
        await PostgresService.ExportTableData(table.databaseId, table.schema, table.name, table.options, format, path)
        message = `Exported all matching rows to ${baseName(path)}.`
      } else {
        const included = columns.map((column, index) => ({ column, index })).filter(({ column }) => format !== 'sql' || !generatedColumns.includes(column))
        const source = scope === 'selected' ? selectedRows ?? [] : rows
        await PostgresService.WriteExportFile(path, exportData(included.map(({ column }) => column), source.map((row) => included.map(({ index }) => row[index])), format, table))
        message = `Exported ${plural(source.length, 'row')} to ${baseName(path)}.`
      }
      if (onExported) onExported(message)
      else setStatus(message)
      if (menuRef.current) menuRef.current.open = false
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)) }
    finally { setBusy(false) }
  }
  const loadedLabel = table ? searchActive ? `Rows matching page search (${rows.length.toLocaleString()})` : `Rows on this page (${rows.length.toLocaleString()})` : `Displayed rows (${rows.length.toLocaleString()})`
  return <>
    <details className="export-menu" ref={menuRef} onToggle={(event) => { setOpen(event.currentTarget.open); if (!event.currentTarget.open) setPosition({ visibility: 'hidden' }) }} onKeyDown={(event) => { if (event.key === 'Escape' && menuRef.current?.open) { menuRef.current.open = false; menuRef.current.querySelector('summary')?.focus(); event.preventDefault(); event.stopPropagation() } }}>
      <summary className={buttonClassName()} title="Export rows to a CSV, JSON or SQL file"><Icon name="download" />Export</summary>
      <div className="export-menu-panel" ref={panelRef} style={position}>
        {note ? <p className="export-note"><Icon name="info" /><span>{note}</span></p> : null}
        <label>Format<select aria-label="Export format" value={format} disabled={busy} onChange={(event) => setFormat(event.target.value as ExportFormat)}><option value="csv">CSV</option><option value="json">JSON</option>{table ? <option value="sql">SQL INSERT statements</option> : null}</select></label>
        <label>Rows<select aria-label="Export rows" value={scope} disabled={busy} onChange={(event) => setScope(event.target.value)}>
          <option value="loaded">{loadedLabel}</option>
          {selectedRows ? <option value="selected" disabled={!selectedRows.length}>{`Selected rows (${selectedRows.length.toLocaleString()})`}</option> : null}
          {table ? <option value="table">{table.options.filters.length ? 'All rows matching filters' : 'All rows in table'}</option> : null}
        </select></label>
        {scope === 'table' && table ? <p className="export-hint">Streams every matching saved row from PostgreSQL{table.options.sort.length ? ', in the current sort order' : ''}. Page search is not applied.</p> : null}
        {error ? <span role="alert">{error}</span> : null}
        <Button variant="primary" type="button" disabled={busy || scope === 'selected' && !selectedRows?.length} onClick={() => void save()}>{busy ? 'Exporting…' : 'Save file'}</Button>
      </div>
    </details>
    {!onExported ? <span className="export-status" role="status" aria-live="polite">{status ? <><Icon name="check" />{status}</> : null}</span> : null}
  </>
}
