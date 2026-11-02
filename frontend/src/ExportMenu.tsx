import Button, { buttonClassName } from './ui/Button'
import { useLayoutEffect, useRef, useState, type CSSProperties } from 'react'
import { PostgresService } from './services'
import { exportData, type ExportFormat } from './export-data'
import Icon from './Icon'
import type { TableQueryOptions } from './table-query'
import './ExportMenu.css'

type FullTable = { databaseId: string; schema: string; name: string; options: TableQueryOptions }
export default function ExportMenu({ columns, rows, selectedRows, table, generatedColumns = [], fileName = 'results' }: { columns: string[]; rows: unknown[][]; selectedRows?: unknown[][]; table?: FullTable; fileName?: string; generatedColumns?: string[] }) {
  const [format, setFormat] = useState<ExportFormat>('csv')
  const [scope, setScope] = useState('loaded')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [open, setOpen] = useState(false)
  const [position, setPosition] = useState<CSSProperties>({ visibility: 'hidden' })
  const menuRef = useRef<HTMLDetailsElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)

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
  return <details className="export-menu" ref={menuRef} onToggle={(event) => { setOpen(event.currentTarget.open); if (!event.currentTarget.open) setPosition({ visibility: 'hidden' }) }} onKeyDown={(event) => { if (event.key === 'Escape' && menuRef.current?.open) { menuRef.current.open = false; menuRef.current.querySelector('summary')?.focus(); event.preventDefault(); event.stopPropagation() } }}>
    <summary className={buttonClassName()}><Icon name="download" />Export</summary>
    <div className="export-menu-panel" ref={panelRef} style={position}><label>Format<select aria-label="Export format" value={format} disabled={busy} onChange={(event) => setFormat(event.target.value as ExportFormat)}><option value="csv">CSV</option><option value="json">JSON</option>{table ? <option value="sql">SQL inserts</option> : null}</select></label>
      <label>Rows<select aria-label="Export rows" value={scope} disabled={busy} onChange={(event) => setScope(event.target.value)}><option value="loaded">Loaded rows</option>{selectedRows ? <option value="selected" disabled={!selectedRows.length}>Selected rows</option> : null}{table ? <option value="table">Entire filtered table</option> : null}</select></label>
      {error ? <span role="alert">{error}</span> : null}<Button variant="primary" type="button" disabled={busy || scope === 'selected' && !selectedRows?.length} onClick={() => void save()}>{busy ? 'Exporting…' : 'Save file'}</Button>
    </div>
  </details>
}
