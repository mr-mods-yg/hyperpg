import { useEffect, useId, useMemo, useRef, useState } from 'react'
import { PostgresService } from './services'
import Button from './ui/Button'
import Icon from './Icon'
import './ExportDatabaseDialog.css'

type ExportTable = { schema: string; name: string; kind: string; estimatedRows: number; readable: boolean }
type ExportProgress = { active: boolean; phase: string; tableIndex: number; tableCount: number; schema: string; table: string; tableRows: number; totalRows: number }
type SheetResult = { sheet: string; schema: string; table: string; kind: string; rows: number; rowsTruncated: boolean; truncatedCells: number }
type ExportResult = { path: string; sheets: SheetResult[] | null; totalRows: number; warnings: string[] | null; cancelled: boolean }

type ExcelService = {
  ListExcelExportTables: (connectionId: string, database: string) => Promise<ExportTable[] | null>
  ExportDatabaseToExcel: (connectionId: string, database: string, options: { exportId: string; tables: { schema: string; name: string }[]; includeViews: boolean }) => Promise<ExportResult>
  GetExcelExportProgress: (exportId: string) => Promise<ExportProgress>
  CancelExcelExport: (exportId: string) => Promise<boolean>
}

// Older builds (and test doubles) may not provide the Excel bindings.
const excelService = PostgresService as unknown as Partial<ExcelService>
export function canExportToExcel() {
  return typeof excelService.ExportDatabaseToExcel === 'function' && typeof excelService.ListExcelExportTables === 'function'
}

const key = (table: { schema: string; name: string }) => `${table.schema}\u0000${table.name}`
const numberFormat = new Intl.NumberFormat()
const count = (value: number, one: string, many = `${one}s`) => `${numberFormat.format(value)} ${value === 1 ? one : many}`
const estimate = (rows: number) => rows < 0 ? '' : rows < 1000 ? `~${rows}` : `~${new Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 1 }).format(rows)}`
const POLL_MS = 250

type Phase = 'loading' | 'choose' | 'exporting' | 'done'

type Props = {
  connectionId: string
  connectionName: string
  database: string
  returnFocus: { current: HTMLElement | null }
  onClose: () => void
}

export default function ExportDatabaseDialog({ connectionId, connectionName, database, returnFocus, onClose }: Props) {
  const dialog = useRef<HTMLDialogElement>(null)
  const titleId = useId()
  const descriptionId = useId()
  const [phase, setPhase] = useState<Phase>('loading')
  const [tables, setTables] = useState<ExportTable[]>([])
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [includeViews, setIncludeViews] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [progress, setProgress] = useState<ExportProgress | null>(null)
  const [cancelling, setCancelling] = useState(false)
  const [result, setResult] = useState<ExportResult | null>(null)
  const exportId = useRef('')
  const mounted = useRef(true)
  const closeRef = useRef(onClose)
  closeRef.current = onClose

  useEffect(() => {
    const element = dialog.current
    if (!element) return
    const opener = document.activeElement instanceof HTMLElement && document.activeElement !== document.body ? document.activeElement : null
    // A native modal dialog makes the rest of the app inert and traps focus.
    if (!element.open) element.showModal?.()
    element.focus()
    mounted.current = true
    return () => {
      mounted.current = false
      // Never leave an export running behind a closed dialog.
      if (exportId.current) void excelService.CancelExcelExport?.(exportId.current)
      if (element.open) element.close()
      const target = [opener, returnFocus.current].find((candidate) => candidate?.isConnected)
      target?.focus()
    }
  }, [returnFocus])

  useEffect(() => {
    let cancelled = false
    excelService.ListExcelExportTables?.(connectionId, database)
      .then((items) => {
        if (cancelled) return
        const list = items ?? []
        setTables(list)
        setSelected(new Set(list.filter((table) => table.kind === 'table' && table.readable).map(key)))
        setPhase('choose')
      })
      .catch((reason: unknown) => { if (!cancelled) { setError(message(reason, 'Could not list the tables in this database.')); setPhase('choose') } })
    return () => { cancelled = true }
  }, [connectionId, database])

  // Move focus to the first control of each new step.
  useEffect(() => {
    const element = dialog.current
    if (!element || phase === 'loading') return
    const target = phase === 'choose' ? element.querySelector<HTMLElement>('input[type="checkbox"]:not(:disabled), .export-excel-actions button:not(:disabled)')
      : element.querySelector<HTMLElement>('.dialog-actions button:not(:disabled)')
    target?.focus()
  }, [phase])

  const visible = useMemo(() => tables.filter((table) => includeViews || table.kind === 'table'), [tables, includeViews])
  const schemas = useMemo(() => {
    const groups = new Map<string, ExportTable[]>()
    for (const table of visible) groups.set(table.schema, [...(groups.get(table.schema) ?? []), table])
    return [...groups]
  }, [visible])
  const chosen = visible.filter((table) => selected.has(key(table)))
  const selectable = visible.filter((table) => table.readable)

  const toggle = (items: ExportTable[], on: boolean) => setSelected((current) => {
    const next = new Set(current)
    for (const table of items) if (table.readable) { if (on) next.add(key(table)); else next.delete(key(table)) }
    return next
  })
  const setViews = (on: boolean) => {
    setIncludeViews(on)
    toggle(tables.filter((table) => table.kind !== 'table'), on)
  }

  const startExport = async () => {
    if (!chosen.length || !excelService.ExportDatabaseToExcel) return
    const id = typeof crypto.randomUUID === 'function' ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`
    exportId.current = id
    setError('')
    setNotice('')
    setCancelling(false)
    setProgress(null)
    setPhase('exporting')
    let polling = true
    const poll = async () => {
      while (polling && mounted.current) {
        try {
          const next = await excelService.GetExcelExportProgress?.(id)
          if (polling && mounted.current && next) setProgress(next)
        } catch { /* Progress is cosmetic; the export call reports failures. */ }
        await new Promise((resolve) => window.setTimeout(resolve, POLL_MS))
      }
    }
    void poll()
    try {
      const outcome = await excelService.ExportDatabaseToExcel(connectionId, database, {
        exportId: id, includeViews, tables: chosen.map(({ schema, name }) => ({ schema, name })),
      })
      if (!mounted.current) return
      if (outcome.cancelled) { setNotice('Export cancelled. No file was saved.'); setPhase('choose') }
      else if (!outcome.path) closeRef.current() // The save dialog was dismissed.
      else { setResult(outcome); setPhase('done') }
    } catch (reason) {
      if (!mounted.current) return
      setError(message(reason, 'The export failed. Check the connection and try again.'))
      setPhase('choose')
    } finally {
      polling = false
      exportId.current = ''
    }
  }

  const cancelExport = () => {
    if (!exportId.current || cancelling) return
    setCancelling(true)
    void excelService.CancelExcelExport?.(exportId.current)
  }

  const requestClose = () => { if (phase === 'exporting') cancelExport(); else onClose() }

  const exportingText = () => {
    if (cancelling) return 'Cancelling and removing the partial file…'
    if (!progress?.active) return 'Choose where to save the workbook…'
    if (progress.phase === 'preparing') return 'Starting a consistent snapshot…'
    if (progress.phase === 'saving') return `Saving the workbook (${count(progress.totalRows, 'row')})…`
    return `Exporting table ${progress.tableIndex} of ${progress.tableCount}: ${progress.table}, ${count(progress.tableRows, 'row')}`
  }
  const fraction = progress?.active && progress.tableCount
    ? progress.phase === 'saving' ? 1 : Math.max(0, progress.tableIndex - 1) / progress.tableCount
    : 0

  const sheets = result?.sheets ?? []
  const warnings = result?.warnings ?? []

  return <dialog ref={dialog} className="connection-dialog export-excel-dialog" aria-modal="true" aria-labelledby={titleId} aria-describedby={descriptionId} tabIndex={-1}
    aria-busy={phase === 'loading' || phase === 'exporting'}
    onCancel={(event) => { event.preventDefault(); requestClose() }}
    onClick={(event) => {
      // Clicks on the backdrop land on the dialog element outside its box.
      const box = event.currentTarget.getBoundingClientRect()
      if (phase !== 'exporting' && event.target === event.currentTarget && (event.clientX < box.left || event.clientX > box.right || event.clientY < box.top || event.clientY > box.bottom)) onClose()
    }}>
    <button className="dialog-close" type="button" aria-label="Close" onClick={requestClose} disabled={phase === 'exporting'}><Icon name="close" /></button>
    <div className="dialog-heading">
      <h2 id={titleId}>{phase === 'done' ? 'Export complete' : 'Export to Excel'}</h2>
      <p id={descriptionId}>{phase === 'done' ? <>Saved <strong>{database}</strong> as an Excel workbook.</>
        : <>Each table in <strong>{database}</strong> <span className="export-excel-connection">({connectionName})</span> becomes a sheet with a header row of column names.</>}</p>
    </div>

    {phase === 'loading' ? <div className="export-excel-status" role="status"><span className="tiny-spinner" />Loading tables…</div> : null}

    {phase === 'choose' ? <>
      <div className="export-excel-toolbar">
        <span className="export-excel-count" role="status">{tables.length ? `${count(chosen.length, 'table')} of ${numberFormat.format(selectable.length)} selected` : ''}</span>
        <div className="export-excel-actions">
          <Button size="sm" variant="ghost" onClick={() => toggle(visible, true)} disabled={!selectable.length || chosen.length === selectable.length}>Select all</Button>
          <Button size="sm" variant="ghost" onClick={() => toggle(visible, false)} disabled={!chosen.length}>Select none</Button>
        </div>
      </div>
      {schemas.length ? <div className="export-excel-list" role="group" aria-label="Tables to export">
        {schemas.map(([schema, items]) => <SchemaGroup key={schema} schema={schema} tables={items} selected={selected} onToggle={toggle} />)}
      </div> : !error ? <p className="export-excel-empty">{tables.length ? 'This database has only views. Turn on Include views to export them.' : 'This database has no tables to export.'}</p> : null}
      <label className="export-excel-option">
        <input type="checkbox" checked={includeViews} onChange={(event) => setViews(event.target.checked)} disabled={!tables.length} />
        <span>Include views<small>Views and materialized views are exported as their current query results.</small></span>
      </label>
      {notice ? <div className="dialog-note" role="status"><Icon name="info" /><span>{notice}</span></div> : null}
      {error ? <div className="form-error" role="alert"><Icon name="info" /><span>{error}</span></div> : null}
      <div className="dialog-actions">
        <Button size="lg" onClick={onClose}>Cancel</Button>
        <Button size="lg" variant="primary" onClick={() => void startExport()} disabled={!chosen.length}><Icon name="download" />Export {chosen.length ? count(chosen.length, 'table') : ''}…</Button>
      </div>
    </> : null}

    {phase === 'exporting' ? <>
      <div className="export-excel-progress">
        <p role="status" aria-live="polite">{exportingText()}</p>
        <div className="export-excel-bar" role="progressbar" aria-label="Export progress" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(fraction * 100)}>
          <span style={{ width: `${Math.round(fraction * 100)}%` }} className={progress?.active ? '' : 'is-indeterminate'} />
        </div>
        {progress?.active && progress.totalRows ? <small>{count(progress.totalRows, 'row')} exported so far</small> : null}
      </div>
      <div className="dialog-actions">
        <Button size="lg" onClick={cancelExport} disabled={cancelling || !progress?.active}>{cancelling ? 'Cancelling…' : 'Cancel export'}</Button>
      </div>
    </> : null}

    {phase === 'done' && result ? <>
      <div className="export-excel-success" role="status">
        <Icon name="check" />
        <div>
          <strong>{count(sheets.length, 'sheet')}, {count(result.totalRows, 'row')}</strong>
          <code title={result.path}>{result.path}</code>
        </div>
      </div>
      {warnings.length ? <div className="export-excel-warnings" role="note" aria-label="Export warnings">
        <strong>{count(warnings.length, 'warning')}</strong>
        <ul>{warnings.map((warning) => <li key={warning}>{warning}</li>)}</ul>
      </div> : null}
      <div className="dialog-actions">
        <Button size="lg" variant="primary" onClick={onClose}>Done</Button>
      </div>
    </> : null}
  </dialog>
}

function SchemaGroup({ schema, tables, selected, onToggle }: { schema: string; tables: ExportTable[]; selected: Set<string>; onToggle: (tables: ExportTable[], on: boolean) => void }) {
  const box = useRef<HTMLInputElement>(null)
  const id = useId()
  const readable = tables.filter((table) => table.readable)
  const checked = readable.filter((table) => selected.has(key(table))).length
  const all = readable.length > 0 && checked === readable.length
  useEffect(() => { if (box.current) box.current.indeterminate = checked > 0 && !all }, [checked, all])
  return <fieldset className="export-excel-schema">
    <legend>
      <label>
        <input ref={box} type="checkbox" checked={all} disabled={!readable.length} onChange={() => onToggle(tables, !all)} aria-label={`All tables in ${schema}`} />
        <Icon name="schema" /><span>{schema}</span><small>{checked}/{readable.length}</small>
      </label>
    </legend>
    {tables.map((table, index) => <label key={table.name} className={`export-excel-table ${table.readable ? '' : 'is-disabled'}`}>
      <input type="checkbox" checked={table.readable && selected.has(key(table))} disabled={!table.readable} onChange={(event) => onToggle([table], event.target.checked)}
        aria-label={table.name} aria-describedby={`${id}-${index}`} />
      <Icon name="table" />
      <span className="export-excel-table-name" title={`${table.schema}.${table.name}`}>{table.name}</span>
      <span id={`${id}-${index}`} className="export-excel-meta">
        {table.kind !== 'table' ? <span className="export-excel-kind">{table.kind}</span> : null}
        <small aria-label={table.readable ? table.estimatedRows < 0 ? undefined : `about ${numberFormat.format(table.estimatedRows)} rows` : undefined}>{table.readable ? estimate(table.estimatedRows) : 'No access'}</small>
      </span>
    </label>)}
  </fieldset>
}

function message(error: unknown, fallback: string) {
  return typeof error === 'string' ? error : error instanceof Error ? error.message : fallback
}
