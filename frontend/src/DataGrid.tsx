import { forwardRef, useEffect, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState, type ClipboardEvent, type KeyboardEvent, type PointerEvent } from 'react'
import { PostgresService } from './services'
import { cellKey, cellRange, draftValue, editValue, selectionCSV, tableChanges, valueText, type CellPosition, type DraftRow, type RowEdits, type TableData } from './grid'
import Icon from './Icon'
import ExportMenu from './ExportMenu'
import { emptyTableQuery, type TableQueryOptions } from './table-query'

export type DataGridHandle = { save: () => Promise<boolean>; discard: () => void }
type Props = {
  data: TableData
  connectionID: string
  schema: string
  table: string
  pageOffset: number
  loading: boolean
  readOnly: boolean
  selectionVersion: number
  search: string
  onSearchChange: (search: string) => void
  onDirtyChange: (dirty: boolean) => void
  onSavingChange: (saving: boolean) => void
  onSaved: (rowCountDelta: number) => void
  queryOptions?: TableQueryOptions
  onSort?: (column: string) => void
}
type Editor = { row: DraftRow; column: number; text: string; touched: boolean }
type ContextMenu = { x: number; y: number; cell: CellPosition | null }
// Anchor insertions to a loaded row, so removing another draft cannot move them.
type InsertedRow = { row: DraftRow; beforeRowId: string | null }
type RowPlacement = { target: DraftRow; side: 'above' | 'below'; column: number }

const DataGrid = forwardRef<DataGridHandle, Props>(function DataGrid({ data, connectionID, schema, table, pageOffset, loading, readOnly, selectionVersion, search, onSearchChange, onDirtyChange, onSavingChange, onSaved, queryOptions = emptyTableQuery(), onSort }, ref) {
  const baseRows = useMemo<DraftRow[]>(() => data.rows.map((original, index) => ({ id: `row-${index}`, original, identity: data.identities[index] ?? null, added: false })), [data])
  const [addedRows, setAddedRows] = useState<InsertedRow[]>([])
  const [edits, setEdits] = useState<RowEdits>({})
  const [deleted, setDeleted] = useState<Set<string>>(new Set())
  const [selection, setSelection] = useState<Set<string>>(new Set())
  const [active, setActive] = useState<CellPosition | null>(null)
  const [editor, setEditor] = useState<Editor | null>(null)
  const [menu, setMenu] = useState<ContextMenu | null>(null)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [message, setMessage] = useState('')
  const anchor = useRef<CellPosition | null>(null)
  const dragging = useRef<{ start: CellPosition; base: Set<string> } | null>(null)
  const nextRowID = useRef(0)
  const gridRef = useRef<HTMLDivElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const savingRef = useRef(false)

  const rows = useMemo(() => {
    const baseIDs = new Set(baseRows.map((row) => row.id))
    const insertions = new Map<string | null, DraftRow[]>()
    for (const added of addedRows) {
      const before = added.beforeRowId && baseIDs.has(added.beforeRowId) ? added.beforeRowId : null
      const group = insertions.get(before) ?? []
      group.push(added.row)
      insertions.set(before, group)
    }
    const ordered: DraftRow[] = []
    for (const row of baseRows) ordered.push(...(insertions.get(row.id) ?? []), row)
    ordered.push(...(insertions.get(null) ?? []))
    return ordered
  }, [baseRows, addedRows])
  const visibleRows = useMemo(() => {
    const query = search.trim().toLowerCase()
    // Keep a row visible while editing it; new rows are always visible.
    return rows.filter((row) => row.added || !query || row.original.some((value) => valueText(value).toLowerCase().includes(query)))
  }, [rows, search])
  const resolvedEdits = editor?.touched ? editValue(edits, editor.row, data.columns[editor.column], editor.column, editor.text) : edits
  const changes = tableChanges(rows, resolvedEdits, deleted)
  const dirty = changes.length > 0
  const selectedRows = [...new Set([...selection].map((key) => Number(key.split(':')[0])))].map((index) => visibleRows[index]).filter(Boolean)
  const menuRow = menu?.cell ? visibleRows[menu.cell.row] : null
  const menuColumn = menu?.cell ? data.columns[menu.cell.column] : null
  const menuValue = menuRow && menuColumn && menu?.cell ? draftValue(menuRow, menuColumn, menu.cell.column, resolvedEdits) : undefined
  const menuValueText = menuValue === undefined ? 'DEFAULT' : menuValue === null ? 'NULL' : valueText(menuValue) || 'Empty string'
  const menuCellChanged = !!menuRow && !!menuColumn && Object.prototype.hasOwnProperty.call(resolvedEdits[menuRow.id] ?? {}, menuColumn.name)

  useEffect(() => { onDirtyChange(dirty) }, [dirty, onDirtyChange])
  useEffect(() => () => { onDirtyChange(false); onSavingChange(false) }, [onDirtyChange, onSavingChange])
  useEffect(() => {
    setSelection(new Set()); setActive(null); anchor.current = null
  }, [search])
  useEffect(() => {
    setSelection(new Set()); setActive(null); anchor.current = null; setMenu(null)
  }, [selectionVersion])
  useEffect(() => {
    setSelection((current) => {
      const retained = [...current].filter((key) => {
        const [row, column] = key.split(':').map(Number)
        return row < visibleRows.length && column < data.columns.length
      })
      return retained.length === current.size ? current : new Set(retained)
    })
    setActive((current) => current && (current.row >= visibleRows.length || current.column >= data.columns.length) ? null : current)
    if (anchor.current && (anchor.current.row >= visibleRows.length || anchor.current.column >= data.columns.length)) anchor.current = null
    setMenu((current) => current?.cell && (current.cell.row >= visibleRows.length || current.cell.column >= data.columns.length) ? null : current)
  }, [visibleRows.length, data.columns.length])
  useEffect(() => { if (loading) setMenu(null) }, [loading])
  useEffect(() => {
    const end = () => { dragging.current = null }
    window.addEventListener('pointerup', end)
    window.addEventListener('pointercancel', end)
    return () => { window.removeEventListener('pointerup', end); window.removeEventListener('pointercancel', end) }
  }, [])
  useEffect(() => {
    if (!dirty) return
    const beforeUnload = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = '' }
    window.addEventListener('beforeunload', beforeUnload)
    return () => window.removeEventListener('beforeunload', beforeUnload)
  }, [dirty])
  useLayoutEffect(() => {
    if (!menu || !menuRef.current) return
    const element = menuRef.current
    const bounds = element.getBoundingClientRect()
    element.style.left = `${Math.max(8, Math.min(menu.x, window.innerWidth - bounds.width - 8))}px`
    element.style.top = `${Math.max(8, Math.min(menu.y, window.innerHeight - bounds.height - 8))}px`
    element.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus({ preventScroll: true })
  }, [menu])
  useEffect(() => {
    if (!menu) return
    const close = (event: Event) => {
      if (!menuRef.current?.contains(event.target as Node)) setMenu(null)
    }
    const grid = gridRef.current
    const scroller = grid?.querySelector<HTMLElement>('.data-grid-scroll')
    const scrollTop = scroller?.scrollTop
    const scrollLeft = scroller?.scrollLeft
    const closeOnScroll = (event: Event) => {
      if (menuRef.current?.contains(event.target as Node)) return
      // Ignore a queued scroll event from bringing the target cell into view.
      if (event.target === scroller && scroller?.scrollTop === scrollTop && scroller?.scrollLeft === scrollLeft) return
      setMenu(null)
    }
    window.addEventListener('pointerdown', close)
    window.addEventListener('resize', close)
    grid?.addEventListener('scroll', closeOnScroll, true)
    return () => {
      window.removeEventListener('pointerdown', close)
      window.removeEventListener('resize', close)
      grid?.removeEventListener('scroll', closeOnScroll, true)
    }
  }, [menu])

  function focusCell(position: CellPosition) {
    requestAnimationFrame(() => gridRef.current?.querySelector<HTMLElement>(`[data-cell="${cellKey(position)}"]`)?.focus({ preventScroll: true }))
  }

  function commitEditor() {
    if (!editor) return
    if (editor.touched) setEdits((current) => editValue(current, editor.row, data.columns[editor.column], editor.column, editor.text))
    setEditor(null)
  }

  function discard() {
    if (savingRef.current) return
    setEditor(null); setEdits({}); setAddedRows([]); setDeleted(new Set()); setError(''); setMenu(null)
    setSelection(new Set()); setActive(null); setMessage('Changes discarded.'); onDirtyChange(false)
  }

  async function save(): Promise<boolean> {
    if (savingRef.current || loading || readOnly) return false
    if (!changes.length) return true
    savingRef.current = true; setSaving(true); onSavingChange(true); setError(''); setMenu(null)
    commitEditor()
    try {
      await PostgresService.SaveTableChanges(connectionID, schema, table, changes)
      setEdits({}); setAddedRows([]); setDeleted(new Set()); setEditor(null)
      onDirtyChange(false)
      onSaved(changes.filter((change) => change.kind === 'insert').length - changes.filter((change) => change.kind === 'delete').length)
      return true
    } catch (reason) {
      setError(typeof reason === 'string' ? reason : reason instanceof Error ? reason.message : 'Could not save changes. Your draft has been kept.')
      return false
    } finally {
      savingRef.current = false; setSaving(false); onSavingChange(false)
    }
  }
  useImperativeHandle(ref, () => ({ save, discard }))

  function beginEdit(position: CellPosition, initialText?: string) {
    const row = visibleRows[position.row]
    const column = data.columns[position.column]
    if (!row || !column || column.generated || deleted.has(row.id) || saving || loading || readOnly) return
    setMenu(null); setSelection(new Set([cellKey(position)])); setActive(position); anchor.current = position
    setEditor({ row, column: position.column, text: initialText ?? valueText(draftValue(row, column, position.column, edits)), touched: initialText !== undefined })
  }

  function selectCell(event: PointerEvent<HTMLTableCellElement>, position: CellPosition) {
    if (event.button !== 0 || saving || (event.target as HTMLElement).closest('textarea')) return
    event.preventDefault(); commitEditor(); setMenu(null); setMessage('')
    const extend = event.shiftKey && anchor.current
    const additive = event.ctrlKey || event.metaKey
    const start = extend ? anchor.current! : position
    const base = additive ? new Set(selection) : new Set<string>()
    const next = new Set(base)
    if (additive && !extend && next.has(cellKey(position))) next.delete(cellKey(position))
    else for (const key of cellRange(start, position)) next.add(key)
    setSelection(next); setActive(position)
    if (!extend) anchor.current = position
    dragging.current = { start, base }
    event.currentTarget.focus({ preventScroll: true })
  }

  function extendDrag(event: PointerEvent<HTMLTableCellElement>, position: CellPosition) {
    if (!dragging.current || !(event.buttons & 1)) return
    setSelection(new Set([...dragging.current.base, ...cellRange(dragging.current.start, position)]))
    setActive(position)
  }

  function csvForSelection() {
    return selectionCSV(visibleRows.map((row) => data.columns.map((column, index) => draftValue(row, column, index, resolvedEdits))), selection)
  }

  function handleCopy(event: ClipboardEvent) {
    if ((event.target as HTMLElement).closest('textarea, input') || !selection.size) return
    event.preventDefault()
    const csv = csvForSelection()
    event.clipboardData.setData('text/plain', csv)
    event.clipboardData.setData('text/csv', csv)
    setMessage(`${selection.size} ${selection.size === 1 ? 'cell' : 'cells'} copied as CSV.`)
  }

  async function copySelection() {
    setMenu(null)
    try {
      await navigator.clipboard.writeText(csvForSelection())
      setMessage(`${selection.size} ${selection.size === 1 ? 'cell' : 'cells'} copied as CSV.`)
    } catch {
      // Desktop webviews may not expose the async Clipboard API.
      const field = document.createElement('textarea')
      field.value = csvForSelection(); field.style.cssText = 'position:fixed;opacity:0;pointer-events:none'
      document.body.append(field); field.select()
      const copied = document.execCommand('copy'); field.remove()
      setMessage(copied ? 'Selection copied as CSV.' : 'Clipboard unavailable. Focus the grid and press Ctrl/Cmd+C.')
    }
    if (active) focusCell(active)
  }

  function addRow(duplicate?: DraftRow, placement?: RowPlacement) {
    if (saving || loading || readOnly) return
    commitEditor()
    const row: DraftRow = { id: `new-${nextRowID.current++}`, original: [], identity: null, added: true }
    if (duplicate) {
      let values: Record<string, string | null> = {}
      data.columns.forEach((column, index) => {
        if (column.generated || column.autoIncrement) return
        const value = draftValue(duplicate, column, index, resolvedEdits)
        if (value !== undefined) values = { ...values, [column.name]: value === null ? null : valueText(value) }
      })
      setEdits((current) => ({ ...current, [row.id]: values }))
    }
    const targetIndex = placement ? rows.findIndex((item) => item.id === placement.target.id) : -1
    const insertIndex = targetIndex < 0 ? rows.length : targetIndex + (placement?.side === 'below' ? 1 : 0)
    const following = rows.slice(insertIndex)
    const beforeRowId = following.find((item) => !item.added)?.id ?? null
    const nextAddedId = following.find((item) => item.added)?.id
    setAddedRows((current) => {
      const index = nextAddedId ? current.findIndex((item) => item.row.id === nextAddedId) : -1
      const insertion = index < 0 ? current.length : index
      return [...current.slice(0, insertion), { row, beforeRowId }, ...current.slice(insertion)]
    })
    setMenu(null); setError('')
    setMessage(placement ? 'Row staged. Its position may change after saving.' : 'New row staged. Untouched cells use database defaults.')
    const visibleIndex = placement ? visibleRows.findIndex((item) => item.id === placement.target.id) : -1
    const preferredColumn = placement?.column
    const column = preferredColumn !== undefined && data.columns[preferredColumn] && !data.columns[preferredColumn].generated
      ? preferredColumn : Math.max(0, data.columns.findIndex((item) => !item.generated))
    const position = { row: visibleIndex < 0 ? visibleRows.length : visibleIndex + (placement?.side === 'below' ? 1 : 0), column }
    setSelection(new Set([cellKey(position)])); setActive(position); anchor.current = position
    requestAnimationFrame(() => {
      const cell = gridRef.current?.querySelector<HTMLElement>(`[data-cell="${cellKey(position)}"]`)
      cell?.scrollIntoView({ block: 'nearest', inline: 'nearest' }); cell?.focus()
    })
  }

  function deleteRows() {
    if (saving || loading || readOnly) return
    commitEditor(); setMenu(null)
    const ids = new Set(selectedRows.map((row) => row.id))
    const addedIDs = new Set(selectedRows.filter((row) => row.added).map((row) => row.id))
    setAddedRows((current) => current.filter((item) => !ids.has(item.row.id)))
    setEdits((current) => Object.fromEntries(Object.entries(current).filter(([id]) => !addedIDs.has(id))))
    setDeleted((current) => new Set([...current, ...selectedRows.filter((row) => !row.added).map((row) => row.id)]))
    setSelection(new Set()); setActive(null); anchor.current = null
    setMessage(`${ids.size} ${ids.size === 1 ? 'row' : 'rows'} marked for deletion. Save to apply.`)
  }

  function openMenu(x: number, y: number, position: CellPosition | null, wholeRow = false) {
    if (saving || loading) return
    commitEditor()
    if (position && (wholeRow ? !selectedRows.includes(visibleRows[position.row]) : !selection.has(cellKey(position)))) {
      setSelection(wholeRow ? cellRange(position, { ...position, column: data.columns.length - 1 }) : new Set([cellKey(position)]))
      anchor.current = position
    }
    if (position) setActive(position)
    setMenu({ x, y, cell: position })
  }

  function keyDown(event: KeyboardEvent<HTMLDivElement>) {
    if ((event.target as HTMLElement).closest('textarea, input, button, [role="menu"]')) return
    const command = event.ctrlKey || event.metaKey
    if (saving) return
    if (command && event.key.toLowerCase() === 'a') {
      event.preventDefault()
      if (!visibleRows.length || !data.columns.length) return
      setSelection(cellRange({ row: 0, column: 0 }, { row: visibleRows.length - 1, column: data.columns.length - 1 }))
      return
    }
    if (event.key === 'Escape') { setMenu(null); setSelection(new Set()); return }
    if (!active) return
    if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) {
      event.preventDefault()
      const box = gridRef.current?.querySelector(`[data-cell="${cellKey(active)}"]`)?.getBoundingClientRect()
      if (box) openMenu(box.left, box.bottom, active)
      return
    }
    if (event.key === 'Enter' || event.key === 'F2') { event.preventDefault(); beginEdit(active); return }
    if (!command && !event.altKey && event.key.length === 1) { event.preventDefault(); beginEdit(active, event.key); return }
    const deltas: Record<string, [number, number]> = { ArrowUp: [-1, 0], ArrowDown: [1, 0], ArrowLeft: [0, -1], ArrowRight: [0, 1], Tab: [0, event.shiftKey ? -1 : 1] }
    const delta = deltas[event.key]
    if (delta) {
      event.preventDefault()
      const next = { row: Math.max(0, Math.min(visibleRows.length - 1, active.row + delta[0])), column: Math.max(0, Math.min(data.columns.length - 1, active.column + delta[1])) }
      const extend = event.shiftKey && event.key !== 'Tab'
      setSelection(extend ? cellRange(anchor.current ?? active, next) : new Set([cellKey(next)]))
      if (!extend) anchor.current = next
      setActive(next); focusCell(next)
      gridRef.current?.querySelector(`[data-cell="${cellKey(next)}"]`)?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
    }
  }

  return <div className="editable-grid" ref={gridRef} onCopy={handleCopy} onKeyDown={keyDown}>
    <div className="grid-actions">
      <button className="pagination-button" type="button" onClick={() => addRow()} disabled={saving || loading || readOnly || !data.columns.length}><Icon name="plus" />Add row</button>
      <button className="pagination-button" type="button" onClick={() => void copySelection()} disabled={!selection.size || saving}><Icon name="copy" />Copy CSV</button>
      <ExportMenu generatedColumns={data.columns.filter((column) => column.generated && !column.identityGeneration).map((column) => column.name)} columns={data.columns.map((column) => column.name)} rows={visibleRows.map((row) => data.columns.map((column, index) => draftValue(row, column, index, resolvedEdits)))} selectedRows={selectedRows.map((row) => data.columns.map((column, index) => draftValue(row, column, index, resolvedEdits)))} table={{ databaseId: connectionID, schema, name: table, options: queryOptions }} fileName={table} />
      {selection.size ? <span className="grid-selection-count">{selection.size} selected</span> : null}
      <label className="row-search"><Icon name="search" /><input value={search} onChange={(event) => onSearchChange(event.target.value)} placeholder="Search this page" aria-label="Search this page" /></label>
    </div>
    {dirty ? <div className="grid-change-bar" role="status">
      <span>{changes.length} unsaved {changes.length === 1 ? 'row change' : 'row changes'}</span>
      <button className="cancel-button" type="button" onClick={discard} disabled={saving}>Discard changes</button>
      <button className="connect-button" type="button" onClick={() => void save()} disabled={saving || loading || readOnly}>{saving ? 'Saving…' : 'Save changes'}</button>
    </div> : null}
    {error ? <div className="notice notice-error" role="alert">{error}</div> : null}
    <div className="data-grid-wrap" onContextMenu={(event) => {
      if ((event.target as HTMLElement).closest('textarea')) return
      event.preventDefault()
      if (!(event.target as HTMLElement).closest('[data-cell], .row-index')) openMenu(event.clientX, event.clientY, null)
    }}>
      <div className="data-grid-scroll">
        <table className="data-grid selectable-grid" role="grid" aria-label={`${schema}.${table} data`} aria-multiselectable="true" aria-busy={saving || loading}>
          <thead><tr role="row"><th className="row-index-heading" role="columnheader">#</th>{data.columns.map((column) => <th key={column.name} role="columnheader" aria-sort={queryOptions.sort[0]?.column === column.name ? queryOptions.sort[0].direction.toUpperCase() === 'ASC' ? 'ascending' : 'descending' : 'none'}><span className="column-name">{onSort ? <button type="button" className="column-sort" disabled={loading || saving || readOnly} onClick={() => onSort(column.name)} aria-label={`Sort by ${column.name}`}>{column.name}{queryOptions.sort[0]?.column === column.name ? queryOptions.sort[0].direction.toUpperCase() === 'ASC' ? ' ↑' : ' ↓' : ''}</button> : column.name}{column.generated ? <Icon name="lock" className="column-lock" /> : null}</span><small>{column.dataType}</small></th>)}</tr></thead>
          <tbody>{visibleRows.map((row, rowIndex) => <tr key={row.id} role="row" className={`${row.added ? 'is-added' : ''} ${deleted.has(row.id) ? 'is-deleted' : ''}`}>
            <td className="row-index" role="rowheader" onPointerDown={(event) => {
              if (event.button !== 0 || saving) return
              event.preventDefault(); commitEditor()
              const first = { row: rowIndex, column: 0 }
              const range = cellRange(event.shiftKey ? { row: anchor.current?.row ?? rowIndex, column: 0 } : first, { row: rowIndex, column: data.columns.length - 1 })
              setSelection(event.ctrlKey || event.metaKey ? new Set([...selection, ...range]) : range)
              setActive(first); if (!event.shiftKey) anchor.current = first; focusCell(first)
            }} onContextMenu={(event) => {
              event.preventDefault(); openMenu(event.clientX, event.clientY, { row: rowIndex, column: 0 }, true)
            }} title={row.added ? 'New row' : deleted.has(row.id) ? 'Marked for deletion' : 'Select row'}>{row.added ? '+' : pageOffset + Number(row.id.slice(4)) + 1}</td>
            {data.columns.map((column, columnIndex) => {
              const position = { row: rowIndex, column: columnIndex }
              const key = cellKey(position)
              const value = draftValue(row, column, columnIndex, edits)
              const selected = selection.has(key)
              const selectionEdges = selected ? [
                !selection.has(cellKey({ row: rowIndex - 1, column: columnIndex })) ? 'selection-top' : '',
                !selection.has(cellKey({ row: rowIndex, column: columnIndex + 1 })) ? 'selection-right' : '',
                !selection.has(cellKey({ row: rowIndex + 1, column: columnIndex })) ? 'selection-bottom' : '',
                !selection.has(cellKey({ row: rowIndex, column: columnIndex - 1 })) ? 'selection-left' : '',
              ].join(' ') : ''
              const editing = editor?.row.id === row.id && editor.column === columnIndex
              const changed = Object.prototype.hasOwnProperty.call(edits[row.id] ?? {}, column.name)
              return <td key={column.name} role="gridcell" data-cell={key} aria-selected={selected} aria-readonly={readOnly || column.generated || deleted.has(row.id)} tabIndex={active ? cellKey(active) === key ? 0 : -1 : rowIndex === 0 && columnIndex === 0 ? 0 : -1}
                className={`${selected ? 'is-selected' : ''} ${selectionEdges} ${active && cellKey(active) === key ? 'is-active' : ''} ${changed ? 'is-changed' : ''} ${editing ? 'is-editing' : ''}`}
                aria-label={`Row ${rowIndex + 1}, ${column.name}: ${value === undefined ? 'DEFAULT' : value === null ? 'NULL' : valueText(value)}`}
                onFocus={() => { if (!active) { setActive(position); setSelection(new Set([key])); anchor.current = position } }}
                onPointerDown={(event) => selectCell(event, position)} onPointerEnter={(event) => extendDrag(event, position)} onDoubleClick={() => beginEdit(position)}
                onContextMenu={(event) => { if (editing) return; event.preventDefault(); openMenu(event.clientX, event.clientY, position) }}>
                {editing ? <textarea className="grid-cell-editor" aria-label={`Edit ${column.name}`} value={editor.text} autoFocus disabled={saving || loading || readOnly} onFocus={(event) => event.currentTarget.select()}
                  onChange={(event) => setEditor({ ...editor, text: event.target.value, touched: true })} onBlur={commitEditor} onKeyDown={(event) => {
                    event.stopPropagation()
                    if (event.key === 'Escape') { event.preventDefault(); setEditor(null); focusCell(position) }
                    else if ((event.key === 'Enter' && !event.shiftKey) || event.key === 'Tab') {
                      event.preventDefault(); commitEditor()
                      const next = event.key === 'Tab' ? { row: rowIndex, column: Math.max(0, Math.min(data.columns.length - 1, columnIndex + (event.shiftKey ? -1 : 1))) } : position
                      setActive(next); setSelection(new Set([cellKey(next)])); anchor.current = next; focusCell(next)
                    }
                  }} /> : <div className="cell-value-scroll" title={valueText(value)}>{value === undefined ? <span className="null-value">DEFAULT</span> : value === null ? <span className="null-value">NULL</span> : typeof value === 'boolean' ? <span className={`boolean-value ${value ? 'is-true' : 'is-false'}`}>{String(value)}</span> : <span className="cell-text">{valueText(value)}</span>}</div>}
              </td>
            })}
          </tr>)}</tbody>
        </table>
        {!visibleRows.length ? <div className="empty-table">{search ? 'No rows match your search.' : 'This table has no rows yet. Use Add row to create one.'}</div> : null}
      </div>
    </div>
    <div className="grid-feedback" role="status" aria-live="polite" title={message || undefined}>{message}</div>
    {menu ? <div className="grid-context-menu" role="menu" aria-label="Cell actions" ref={menuRef} style={{ left: menu.x, top: menu.y }} onKeyDown={(event) => {
      if (event.key === 'Escape') { event.preventDefault(); setMenu(null); if (active) focusCell(active) }
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp' || event.key === 'Home' || event.key === 'End') {
        event.preventDefault()
        const buttons = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')]
        const index = buttons.indexOf(document.activeElement as HTMLButtonElement)
        const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1
          : (index + (event.key === 'ArrowDown' ? 1 : buttons.length - 1)) % buttons.length
        buttons[next]?.focus()
      }
      if (event.key === 'Tab') setMenu(null)
    }}>
      {menuRow && menuColumn ? <div className="grid-menu-details" role="presentation">
        <div className="grid-menu-cell-heading"><strong title={menuColumn.name}>{menuColumn.name}</strong><span title={menuColumn.dataType}>{menuColumn.dataType}</span></div>
        <div className="grid-menu-cell-meta">
          <span>{menuRow.added ? 'New row' : `Row ${pageOffset + Number(menuRow.id.slice(4)) + 1}`}</span>
          <span>{menuColumn.nullable ? 'Nullable' : 'Not null'}</span>
          {menuColumn.generated ? <span>Generated</span> : null}
          {deleted.has(menuRow.id) ? <span>Deleted</span> : menuCellChanged ? <span>Edited</span> : null}
          {selection.size > 1 ? <span>{selection.size} cells selected</span> : null}
        </div>
        <div className={`grid-menu-cell-value ${menuValue === null || menuValue === undefined || menuValue === '' ? 'is-placeholder' : ''}`} title={menuValueText}>{menuValueText}</div>
      </div> : null}
      <button type="button" role="menuitem" disabled={readOnly || !menuRow || !menuColumn || menuColumn.generated || deleted.has(menuRow.id)} onClick={() => menu.cell && beginEdit(menu.cell)}><Icon name="edit" /><span>Edit cell</span></button>
      <button type="button" role="menuitem" disabled={!selection.size} onClick={() => void copySelection()}><Icon name="copy" /><span>Copy selection as CSV</span></button>
      <button type="button" role="menuitem" disabled={readOnly || !menuRow || !menuColumn?.nullable || menuColumn.generated || deleted.has(menuRow.id)} onClick={() => {
        if (menuRow && menuColumn && menu.cell) setEdits((current) => editValue(current, menuRow, menuColumn, menu.cell!.column, null))
        setMenu(null)
      }}><Icon name="null" /><span>Set NULL</span></button>
      <button type="button" role="menuitem" disabled={readOnly || !menuRow || !menuColumn || !Object.prototype.hasOwnProperty.call(edits[menuRow.id] ?? {}, menuColumn.name)} onClick={() => {
        if (menuRow && menuColumn && menu.cell) setEdits((current) => editValue(current, menuRow, menuColumn, menu.cell!.column, undefined))
        setMenu(null)
      }}><Icon name="undo" /><span>{menuRow?.added ? 'Use default' : 'Revert cell'}</span></button>
      <hr />
      {menuRow && menu.cell ? <>
        <button type="button" role="menuitem" disabled={readOnly} onClick={() => addRow(undefined, { target: menuRow, side: 'above', column: menu.cell!.column })}><Icon name="row-above" /><span>Add row above</span></button>
        <button type="button" role="menuitem" disabled={readOnly} onClick={() => addRow(undefined, { target: menuRow, side: 'below', column: menu.cell!.column })}><Icon name="row-below" /><span>Add row below</span></button>
      </> : <button type="button" role="menuitem" disabled={readOnly} onClick={() => addRow()}><Icon name="plus" /><span>Add row</span></button>}
      <button type="button" role="menuitem" disabled={readOnly || !menuRow || deleted.has(menuRow.id)} onClick={() => menuRow && addRow(menuRow)}><Icon name="duplicate" /><span>Duplicate row</span></button>
      <hr />
      <button type="button" role="menuitem" disabled={readOnly || !selectedRows.length} className="danger-action" onClick={deleteRows}><Icon name="trash" /><span>Delete {selectedRows.length > 1 ? `${selectedRows.length} rows` : 'row'}</span></button>
      <button type="button" role="menuitem" disabled={readOnly || !selectedRows.some((row) => deleted.has(row.id))} onClick={() => {
        const ids = new Set(selectedRows.map((row) => row.id))
        setDeleted((current) => new Set([...current].filter((id) => !ids.has(id)))); setMenu(null)
      }}><Icon name="restore" /><span>Restore deleted rows</span></button>
    </div> : null}
  </div>
})

export default DataGrid
