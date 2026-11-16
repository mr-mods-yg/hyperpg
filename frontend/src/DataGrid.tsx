import Button from './ui/Button'
import ActionGroup from './ui/ActionGroup'
import { forwardRef, useEffect, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState, type ClipboardEvent, type KeyboardEvent, type PointerEvent, type ReactNode } from 'react'
import { PostgresService } from './services'
import { cellKey, cellRange, draftValue, editValue, isBooleanType, isNumericType, saveSummary, selectionClipboardText, tableChanges, valueText, type CellPosition, type DraftRow, type RowEdits, type SaveSummary, type TableData } from './grid'
import Icon from './Icon'
import ExportMenu from './ExportMenu'
import { emptyTableQuery, type TableQueryOptions, type TableSort } from './table-query'
import './DataGrid.css'

export type { SaveSummary } from './grid'
export type DataGridHandle = { save: () => Promise<boolean>; discard: () => void; focusActiveCell: () => void }
type Props = {
  data: TableData
  queryControls?: ReactNode
  connectionID: string
  schema: string
  table: string
  // Offset of the first row in `data`. When the owner changes it before the
  // new page arrives, rows keep the numbers of the page that is displayed.
  pageOffset: number
  // While true the current rows stay visible but read-only, with a progress bar.
  loading: boolean
  readOnly: boolean
  selectionVersion: number
  search: string
  onSearchChange: (search: string) => void
  onDirtyChange: (dirty: boolean) => void
  onSavingChange: (saving: boolean) => void
  onSaved: (rowCountDelta: number, summary: SaveSummary) => void
  queryOptions?: TableQueryOptions
  onSort?: (column: string) => void
  // Preferred over onSort: header clicks cycle ascending → descending → unsorted.
  onSortChange?: (sort: TableSort[]) => void
  // Number of staged row changes, e.g. for the owner's unsaved-changes dialog.
  onPendingCountChange?: (count: number) => void
  // Owner controls placed at the start and end of the toolbar row, and beside the feedback line.
  toolbarStart?: ReactNode
  toolbarEnd?: ReactNode
  footer?: ReactNode
}
type Editor = { row: DraftRow; column: number; text: string; touched: boolean; seeded: boolean }
type ContextMenu = { x: number; y: number; cell: CellPosition | null }
// Anchor insertions to a loaded row, so removing another draft cannot move them.
type InsertedRow = { row: DraftRow; beforeRowId: string | null }
type RowPlacement = { target: DraftRow; side: 'above' | 'below'; column: number }
type Draft = { edits: RowEdits; added: InsertedRow[]; deleted: Set<string> }
type Feedback = { text: string; undo?: boolean }

const emptyDraft: Draft = { edits: {}, added: [], deleted: new Set() }
const HISTORY_LIMIT = 100

function orderRows(baseRows: DraftRow[], added: InsertedRow[]): DraftRow[] {
  const baseIDs = new Set(baseRows.map((row) => row.id))
  const insertions = new Map<string | null, DraftRow[]>()
  for (const item of added) {
    const before = item.beforeRowId && baseIDs.has(item.beforeRowId) ? item.beforeRowId : null
    const group = insertions.get(before) ?? []
    group.push(item.row)
    insertions.set(before, group)
  }
  const ordered: DraftRow[] = []
  for (const row of baseRows) ordered.push(...(insertions.get(row.id) ?? []), row)
  ordered.push(...(insertions.get(null) ?? []))
  return ordered
}

const plural = (count: number, one: string, many = `${one}s`) => `${count} ${count === 1 ? one : many}`
const focusIsFree = (grid: HTMLElement | null) => {
  const focused = document.activeElement
  return !focused || focused === document.body || !!grid?.contains(focused)
}

const DataGrid = forwardRef<DataGridHandle, Props>(function DataGrid({ data, queryControls, connectionID, schema, table, pageOffset, loading, readOnly, selectionVersion, search, onSearchChange, onDirtyChange, onSavingChange, onSaved, queryOptions = emptyTableQuery(), onSort, onSortChange, onPendingCountChange, toolbarStart, toolbarEnd, footer }, ref) {
  const [draft, setDraftState] = useState<Draft>(emptyDraft)
  // Saved values stay on screen (read-only) until the refreshed page arrives.
  const [overlay, setOverlay] = useState<Draft | null>(null)
  const [selection, setSelection] = useState<Set<string>>(new Set())
  const [active, setActive] = useState<CellPosition | null>(null)
  const [editor, setEditor] = useState<Editor | null>(null)
  const [menu, setMenu] = useState<ContextMenu | null>(null)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [feedback, setFeedback] = useState<Feedback>({ text: '' })
  const [shownData, setShownData] = useState(data)
  const [rowOffset, setRowOffset] = useState(pageOffset)
  const draftRef = useRef<Draft>(emptyDraft)
  const undoStack = useRef<Draft[]>([])
  const redoStack = useRef<Draft[]>([])
  const pendingFocus = useRef<CellPosition | null>(null)
  const anchor = useRef<CellPosition | null>(null)
  const dragging = useRef<{ start: CellPosition; base: Set<string> } | null>(null)
  const nextRowID = useRef(0)
  const gridRef = useRef<HTMLDivElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const editorRef = useRef<HTMLTextAreaElement>(null)
  const savingRef = useRef(false)

  // New rows for the same grid (another page, a refresh, a new sort) replace
  // the draft in place, so the grid, its toolbar and focus stay mounted.
  if (shownData !== data) {
    setShownData(data)
    setRowOffset(pageOffset)
    draftRef.current = emptyDraft; undoStack.current = []; redoStack.current = []
    setDraftState(emptyDraft); setOverlay(null); setEditor(null); setMenu(null); setError('')
    setFeedback((current) => current.undo ? { text: current.text } : current)
    // Selection is kept (and clamped below) so resizing or refreshing a page
    // does not lose the user's place; the owner bumps selectionVersion to clear it.
    const restore = pendingFocus.current
    const clamped = restore && data.rows.length && data.columns.length
      ? { row: Math.min(restore.row, data.rows.length - 1), column: Math.min(restore.column, data.columns.length - 1) } : null
    pendingFocus.current = clamped
    if (clamped) { setSelection(new Set([cellKey(clamped)])); setActive(clamped); anchor.current = clamped }
  }

  const view = overlay ?? draft
  const baseRows = useMemo<DraftRow[]>(() => data.rows.map((original, index) => ({ id: `row-${index}`, original, identity: data.identities[index] ?? null, added: false })), [data])
  const rows = useMemo(() => orderRows(baseRows, view.added), [baseRows, view.added])
  const visibleRows = useMemo(() => {
    const query = search.trim().toLowerCase()
    // New rows are always visible.
    return rows.filter((row) => row.added || !query || row.original.some((value) => valueText(value).toLowerCase().includes(query)))
  }, [rows, search])
  const columnClasses = useMemo(() => data.columns.map((column) => isNumericType(column.dataType) ? 'is-numeric' : isBooleanType(column.dataType) ? 'is-boolean' : ''), [data.columns])
  const resolvedEdits = editor?.touched ? editValue(view.edits, editor.row, data.columns[editor.column], editor.column, editor.text) : view.edits
  const changes = overlay ? [] : tableChanges(rows, resolvedEdits, draft.deleted)
  const dirty = changes.length > 0
  const locked = saving || loading || readOnly || !!overlay
  const deleted = view.deleted
  const selectedRows = [...new Set([...selection].map((key) => Number(key.split(':')[0])))].sort((a, b) => a - b).map((index) => visibleRows[index]).filter(Boolean)
  const menuRow = menu?.cell ? visibleRows[menu.cell.row] : null
  const menuColumn = menu?.cell ? data.columns[menu.cell.column] : null
  const menuValue = menuRow && menuColumn && menu?.cell ? draftValue(menuRow, menuColumn, menu.cell.column, resolvedEdits) : undefined
  const menuValueText = menuValue === undefined ? 'DEFAULT' : menuValue === null ? 'NULL' : valueText(menuValue) || 'Empty string'
  const menuCellChanged = !!menuRow && !!menuColumn && Object.prototype.hasOwnProperty.call(resolvedEdits[menuRow.id] ?? {}, menuColumn.name)
  const currentSort = queryOptions.sort[0]
  const rowLabel = (row: DraftRow) => row.added ? 'New row' : `Row ${rowOffset + Number(row.id.slice(4)) + 1}`
  // Exports describe the database, not the draft: saved values of loaded rows.
  const savedVisibleRows = visibleRows.filter((row) => !row.added).map((row) => row.original)
  const savedSelectedRows = selectedRows.filter((row) => !row.added).map((row) => row.original)

  useEffect(() => { onDirtyChange(dirty) }, [dirty, onDirtyChange])
  useEffect(() => { onPendingCountChange?.(changes.length) }, [changes.length, onPendingCountChange])
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
  // If the owner never refreshes after a save, stop showing the saved overlay.
  useEffect(() => {
    if (!overlay || loading) return
    const timer = window.setTimeout(() => setOverlay(null), 1500)
    return () => window.clearTimeout(timer)
  }, [overlay, loading])
  useEffect(() => {
    const target = pendingFocus.current
    if (!target) return
    pendingFocus.current = null
    if (focusIsFree(gridRef.current)) focusCell(target)
  }, [shownData])
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
  // Grow the floating editor with its content and keep it inside the grid.
  useLayoutEffect(() => {
    const field = editorRef.current
    if (!field) return
    field.style.height = 'auto'
    field.style.height = `${Math.min(field.scrollHeight + 4, 260)}px`
    const scroller = gridRef.current?.querySelector<HTMLElement>('.data-grid-scroll')
    const cell = field.parentElement
    if (!scroller || !cell) return
    const bounds = scroller.getBoundingClientRect()
    const cellBounds = cell.getBoundingClientRect()
    field.classList.toggle('opens-left', cellBounds.left + field.offsetWidth > bounds.right && cellBounds.right - field.offsetWidth >= bounds.left)
  }, [editor?.text, editor?.row.id, editor?.column])

  function announce(text: string, undo = false) { setFeedback({ text, undo }) }

  function updateDraft(update: (current: Draft) => Draft, record = true) {
    const current = draftRef.current
    const next = update(current)
    if (next === current) return
    if (record) { undoStack.current = [...undoStack.current, current].slice(-HISTORY_LIMIT); redoStack.current = [] }
    draftRef.current = next
    setDraftState(next)
  }

  function setCellValue(current: Draft, row: DraftRow, columnIndex: number, value: string | null | undefined): Draft {
    const edits = editValue(current.edits, row, data.columns[columnIndex], columnIndex, value)
    return JSON.stringify(edits) === JSON.stringify(current.edits) ? current : { ...current, edits }
  }

  function focusCell(position: CellPosition) {
    requestAnimationFrame(() => gridRef.current?.querySelector<HTMLElement>(`[data-cell="${cellKey(position)}"]`)?.focus({ preventScroll: true }))
  }

  function commitEditor() {
    if (!editor) return
    const { row, column, text, touched } = editor
    setEditor(null)
    if (touched) updateDraft((current) => setCellValue(current, row, column, text))
  }

  function travel(direction: 'undo' | 'redo') {
    if (locked) return
    const from = direction === 'undo' ? undoStack : redoStack
    const to = direction === 'undo' ? redoStack : undoStack
    const target = from.current[from.current.length - 1]
    if (!target) { announce(direction === 'undo' ? 'Nothing to undo.' : 'Nothing to redo.'); return }
    from.current = from.current.slice(0, -1)
    to.current = [...to.current, draftRef.current]
    draftRef.current = target
    setEditor(null); setMenu(null); setError('')
    setDraftState(target)
    announce(direction === 'undo' ? 'Undid the last change.' : 'Redid the change.')
  }

  function discard(undoable = true) {
    if (savingRef.current) return
    const count = changes.length
    if (undoable) commitEditor()
    setEditor(null); setError(''); setMenu(null)
    setSelection(new Set()); setActive(null); anchor.current = null
    updateDraft(() => emptyDraft, undoable)
    if (!undoable) { undoStack.current = []; redoStack.current = [] }
    announce(undoable && count ? `Discarded ${plural(count, 'change')}.` : 'Changes discarded.', undoable && count > 0)
    onDirtyChange(false)
  }

  async function save(): Promise<boolean> {
    if (savingRef.current || loading || readOnly || overlay) return false
    commitEditor()
    const current = draftRef.current
    const pending = tableChanges(orderRows(baseRows, current.added), current.edits, current.deleted)
    if (!pending.length) return true
    const focusTarget = active
    savingRef.current = true; setSaving(true); onSavingChange(true); setError(''); setMenu(null)
    try {
      await PostgresService.SaveTableChanges(connectionID, schema, table, pending)
      const summary = saveSummary(pending, schema, table)
      setOverlay(current)
      updateDraft(() => emptyDraft, false); undoStack.current = []; redoStack.current = []
      setEditor(null)
      onDirtyChange(false)
      announce(summary.message)
      pendingFocus.current = focusTarget
      // The Save button disappears; return focus to the cell the user was on.
      if (focusTarget) requestAnimationFrame(() => { if (focusIsFree(gridRef.current)) focusCell(focusTarget) })
      onSaved(summary.inserted - summary.deleted, summary)
      return true
    } catch (reason) {
      setError(typeof reason === 'string' ? reason : reason instanceof Error ? reason.message : 'Could not save changes. Your draft has been kept.')
      return false
    } finally {
      savingRef.current = false; setSaving(false); onSavingChange(false)
    }
  }
  useImperativeHandle(ref, () => ({ save, discard: () => discard(false), focusActiveCell: () => focusCell(active ?? { row: 0, column: 0 }) }))

  function readOnlyReason(position: CellPosition): string | null {
    const row = visibleRows[position.row]
    const column = data.columns[position.column]
    if (!row || !column) return null
    if (saving) return 'Changes are being saved.'
    if (loading || overlay) return 'Rows are loading. Editing resumes when they arrive.'
    if (readOnly) return 'This page is read-only until it refreshes.'
    if (column.generated) return column.identityGeneration
      ? `${column.name} is an identity column (GENERATED ${column.identityGeneration.toUpperCase()}) and can’t be edited.`
      : `${column.name} is a generated column and can’t be edited.`
    if (deleted.has(row.id)) return `${rowLabel(row)} is marked for deletion. Restore it to edit.`
    return null
  }

  function beginEdit(position: CellPosition, initialText?: string) {
    const row = visibleRows[position.row]
    const column = data.columns[position.column]
    if (!row || !column) return
    const reason = readOnlyReason(position)
    if (reason) { announce(reason); return }
    setMenu(null); setSelection(new Set([cellKey(position)])); setActive(position); anchor.current = position
    setEditor({ row, column: position.column, text: initialText ?? valueText(draftValue(row, column, position.column, view.edits)), touched: initialText !== undefined, seeded: initialText !== undefined })
  }

  function selectCell(event: PointerEvent<HTMLTableCellElement>, position: CellPosition) {
    if (event.button !== 0 || saving || (event.target as HTMLElement).closest('textarea')) return
    event.preventDefault(); commitEditor(); setMenu(null); announce('')
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

  function clipboardText(headers: boolean) {
    const values = visibleRows.map((row) => data.columns.map((column, index) => draftValue(row, column, index, resolvedEdits)))
    return selectionClipboardText(values, selection, headers ? data.columns.map((column) => column.name) : undefined)
  }

  function copiedMessage(headers: boolean) {
    return selection.size === 1 && !headers ? 'Copied the cell value.' : `Copied ${plural(selection.size, 'cell')} as CSV${headers ? ' with column headers' : ''}.`
  }

  function handleCopy(event: ClipboardEvent) {
    if ((event.target as HTMLElement).closest('textarea, input, select') || !selection.size) return
    event.preventDefault()
    const text = clipboardText(false)
    event.clipboardData.setData('text/plain', text)
    if (selection.size > 1) event.clipboardData.setData('text/csv', text)
    announce(copiedMessage(false))
  }

  async function copySelection(headers = false) {
    setMenu(null)
    const text = clipboardText(headers)
    try {
      await navigator.clipboard.writeText(text)
      announce(copiedMessage(headers))
    } catch {
      // Desktop webviews may not expose the async Clipboard API.
      const field = document.createElement('textarea')
      field.value = text; field.style.cssText = 'position:fixed;opacity:0;pointer-events:none'
      document.body.append(field); field.select()
      const copied = document.execCommand('copy'); field.remove()
      announce(copied ? copiedMessage(headers) : 'Clipboard unavailable. Focus the grid and press Ctrl/Cmd+C.')
    }
    if (active) focusCell(active)
  }

  function addRow(duplicate?: DraftRow, placement?: RowPlacement) {
    if (locked) return
    commitEditor()
    const row: DraftRow = { id: `new-${nextRowID.current++}`, original: [], identity: null, added: true }
    let values: Record<string, string | null> | null = null
    if (duplicate) {
      values = {}
      data.columns.forEach((column, index) => {
        if (column.generated || column.autoIncrement) return
        const value = draftValue(duplicate, column, index, resolvedEdits)
        if (value !== undefined) values = { ...values, [column.name]: value === null ? null : valueText(value) }
      })
    }
    const targetIndex = placement ? rows.findIndex((item) => item.id === placement.target.id) : -1
    const insertIndex = targetIndex < 0 ? rows.length : targetIndex + (placement?.side === 'below' ? 1 : 0)
    const following = rows.slice(insertIndex)
    const beforeRowId = following.find((item) => !item.added)?.id ?? null
    const nextAddedId = following.find((item) => item.added)?.id
    updateDraft((current) => {
      const index = nextAddedId ? current.added.findIndex((item) => item.row.id === nextAddedId) : -1
      const insertion = index < 0 ? current.added.length : index
      return {
        ...current,
        edits: values ? { ...current.edits, [row.id]: values } : current.edits,
        added: [...current.added.slice(0, insertion), { row, beforeRowId }, ...current.added.slice(insertion)],
      }
    })
    setMenu(null); setError('')
    announce(placement ? 'Row staged. Its position may change after saving.' : 'New row staged. Untouched cells use database defaults.')
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
    if (locked) return
    commitEditor(); setMenu(null)
    const ids = new Set(selectedRows.map((row) => row.id))
    const addedIDs = new Set(selectedRows.filter((row) => row.added).map((row) => row.id))
    updateDraft((current) => ({
      added: current.added.filter((item) => !ids.has(item.row.id)),
      edits: Object.fromEntries(Object.entries(current.edits).filter(([id]) => !addedIDs.has(id))),
      deleted: new Set([...current.deleted, ...selectedRows.filter((row) => !row.added).map((row) => row.id)]),
    }))
    const focusTarget = active
    setSelection(new Set()); anchor.current = null
    if (focusTarget) focusCell({ row: Math.min(focusTarget.row, Math.max(0, visibleRows.length - addedIDs.size - 1)), column: focusTarget.column })
    announce(`${plural(ids.size, 'row')} marked for deletion. Save to apply.`, true)
  }

  // Delete clears values to NULL; whole selected rows are marked for deletion.
  function clearSelection() {
    if (!selection.size) return
    if (locked) { if (active) announce(readOnlyReason(active) ?? 'The grid is read-only right now.'); return }
    const positions = [...selection].map((key) => key.split(':').map(Number) as [number, number])
    const columnsByRow = new Map<number, number>()
    for (const [row] of positions) columnsByRow.set(row, (columnsByRow.get(row) ?? 0) + 1)
    if (data.columns.length > 1 && [...columnsByRow.values()].every((count) => count === data.columns.length)) { deleteRows(); return }
    commitEditor()
    let applied = 0
    let skipped = 0
    updateDraft((current) => {
      let next = current
      for (const [rowIndex, columnIndex] of positions) {
        const row = visibleRows[rowIndex]
        const column = data.columns[columnIndex]
        if (!row || !column || column.generated || !column.nullable || current.deleted.has(row.id)) { skipped++; continue }
        next = setCellValue(next, row, columnIndex, null)
        applied++
      }
      return next
    })
    const skippedText = skipped ? `${plural(skipped, 'cell')} skipped: not nullable or read-only.` : ''
    announce(applied ? `Set ${plural(applied, 'cell')} to NULL.${skippedText ? ` ${skippedText}` : ''}` : selection.size === 1 && active
      ? readOnlyReason(active) ?? `${data.columns[active.column]?.name ?? 'This column'} doesn’t allow NULL.`
      : `Nothing changed. ${skippedText}`, applied > 0)
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

  function nextTabCell(position: CellPosition, backwards: boolean): CellPosition | null {
    const index = position.row * data.columns.length + position.column + (backwards ? -1 : 1)
    if (index < 0 || index >= visibleRows.length * data.columns.length) return null
    return { row: Math.floor(index / data.columns.length), column: index % data.columns.length }
  }

  function rowsPerPage() {
    const scroller = gridRef.current?.querySelector<HTMLElement>('.data-grid-scroll')
    const head = scroller?.querySelector<HTMLElement>('thead')
    const row = scroller?.querySelector<HTMLElement>('tbody tr')
    if (!scroller || !row?.offsetHeight) return 10
    return Math.max(1, Math.floor((scroller.clientHeight - (head?.offsetHeight ?? 0)) / row.offsetHeight) - 1)
  }

  function moveTo(next: CellPosition, extend: boolean) {
    setSelection(extend ? cellRange(anchor.current ?? active ?? next, next) : new Set([cellKey(next)]))
    if (!extend) anchor.current = next
    setActive(next); focusCell(next)
    gridRef.current?.querySelector(`[data-cell="${cellKey(next)}"]`)?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
  }

  function sortBy(column: string) {
    if (loading || saving || readOnly) return
    if (!onSortChange) { onSort?.(column); return }
    const direction = currentSort?.column === column ? currentSort.direction.toUpperCase() : ''
    onSortChange(direction === 'ASC' ? [{ column, direction: 'DESC' }] : direction === 'DESC' ? [] : [{ column, direction: 'ASC' }])
  }

  function keyDown(event: KeyboardEvent<HTMLDivElement>) {
    if ((event.target as HTMLElement).closest('textarea, input, select, button, summary, [role="menu"]')) return
    const command = event.ctrlKey || event.metaKey
    if (saving) return
    const key = event.key
    if (command && key.toLowerCase() === 'a') {
      event.preventDefault()
      if (!visibleRows.length || !data.columns.length) return
      setSelection(cellRange({ row: 0, column: 0 }, { row: visibleRows.length - 1, column: data.columns.length - 1 }))
      return
    }
    if (command && !event.altKey && (key.toLowerCase() === 'z' || key.toLowerCase() === 'y')) {
      event.preventDefault()
      travel(key.toLowerCase() === 'y' || event.shiftKey ? 'redo' : 'undo')
      return
    }
    if (key === 'Escape') { setMenu(null); setSelection(new Set()); return }
    if (!active) return
    if (key === 'ContextMenu' || (event.shiftKey && key === 'F10')) {
      event.preventDefault()
      const box = gridRef.current?.querySelector(`[data-cell="${cellKey(active)}"]`)?.getBoundingClientRect()
      if (box) openMenu(box.left, box.bottom, active)
      return
    }
    if (key === 'Enter' || key === 'F2') { event.preventDefault(); beginEdit(active); return }
    if (key === 'Delete') { event.preventDefault(); clearSelection(); return }
    if (key === 'Backspace') { event.preventDefault(); beginEdit(active, ''); return }
    if (!command && !event.altKey && key.length === 1 && !event.nativeEvent.isComposing) { event.preventDefault(); beginEdit(active, key); return }
    const lastRow = visibleRows.length - 1
    const lastColumn = data.columns.length - 1
    if (lastRow < 0 || lastColumn < 0) return
    let next: CellPosition | null = null
    if (key === 'Tab') next = nextTabCell(active, event.shiftKey)
    else if (key === 'Home') next = command ? { row: 0, column: 0 } : { row: active.row, column: 0 }
    else if (key === 'End') next = command ? { row: lastRow, column: lastColumn } : { row: active.row, column: lastColumn }
    else if (key === 'PageUp' || key === 'PageDown') next = { row: Math.max(0, Math.min(lastRow, active.row + (key === 'PageUp' ? -1 : 1) * rowsPerPage())), column: active.column }
    else {
      const deltas: Record<string, [number, number]> = { ArrowUp: [-1, 0], ArrowDown: [1, 0], ArrowLeft: [0, -1], ArrowRight: [0, 1] }
      const delta = deltas[key]
      if (!delta) return
      next = command
        ? { row: delta[0] ? (delta[0] < 0 ? 0 : lastRow) : active.row, column: delta[1] ? (delta[1] < 0 ? 0 : lastColumn) : active.column }
        : { row: Math.max(0, Math.min(lastRow, active.row + delta[0])), column: Math.max(0, Math.min(lastColumn, active.column + delta[1])) }
    }
    // At the grid boundary, Tab leaves the grid normally.
    if (!next) return
    event.preventDefault()
    moveTo(next, event.shiftKey && key !== 'Tab')
  }

  const canUndo = undoStack.current.length > 0 && !locked
  return <div className={`editable-grid${loading ? ' is-loading' : ''}`} ref={gridRef} onCopy={handleCopy} onKeyDown={keyDown}>
    <div className="grid-actions">
      {toolbarStart}
      <Button className="compact-toolbar-action" type="button" onClick={() => addRow()} disabled={locked || !data.columns.length}><Icon name="plus" />Add row</Button>
      {queryControls}
      <ActionGroup label="Table actions">
      <Button type="button" onClick={() => void copySelection()} disabled={!selection.size || saving} title="Copy selected cells (Ctrl+C). One cell copies its value; several copy as CSV."><Icon name="copy" />Copy CSV</Button>
      <ExportMenu generatedColumns={data.columns.filter((column) => column.generated && !column.identityGeneration).map((column) => column.name)} columns={data.columns.map((column) => column.name)}
        rows={savedVisibleRows} selectedRows={savedSelectedRows} table={{ databaseId: connectionID, schema, name: table, options: queryOptions }} fileName={table}
        searchActive={!!search.trim()} note={dirty || overlay ? 'Unsaved edits, new rows and deletions are not included. Exports use the saved values.' : undefined}
        onExported={(text) => announce(text)} />
      <label className="row-search" title="Search the rows loaded on this page"><Icon name="search" /><input value={search} onChange={(event) => onSearchChange(event.target.value)} placeholder="Search this page" aria-label="Search this page" /></label>
      </ActionGroup>
      {selection.size ? <span className="grid-selection-count">{selection.size} selected</span> : null}
      {toolbarEnd}
    </div>
    {dirty ? <div className="grid-change-bar" role="status">
      <span>{changes.length} unsaved {changes.length === 1 ? 'row change' : 'row changes'}</span>
      <Button variant="ghost" iconOnly size="sm" type="button" onClick={() => travel('undo')} disabled={!canUndo} aria-label="Undo last change" title="Undo last change (Ctrl+Z)"><Icon name="undo" /></Button>
      <Button type="button" onClick={() => discard()} disabled={saving} title="Discard all unsaved changes. You can undo this.">Discard changes</Button>
      <Button variant="primary" type="button" onClick={() => void save()} disabled={locked}>{saving ? 'Saving…' : 'Save changes'}</Button>
    </div> : null}
    {error ? <div className="notice notice-error" role="alert">{error}</div> : null}
    <div className={`data-grid-wrap${loading ? ' is-loading' : ''}`} onContextMenu={(event) => {
      if ((event.target as HTMLElement).closest('textarea')) return
      event.preventDefault()
      if (!(event.target as HTMLElement).closest('[data-cell], .row-index')) openMenu(event.clientX, event.clientY, null)
    }}>
      {loading ? <div className="grid-progress" role="progressbar" aria-label="Loading rows" /> : null}
      <div className="data-grid-scroll">
        <table className="data-grid selectable-grid" role="grid" aria-label={`${schema}.${table} data`} aria-multiselectable="true" aria-busy={saving || loading} aria-readonly={locked || undefined} aria-rowcount={data.rowCount + view.added.length + 1}>
          <thead><tr role="row" aria-rowindex={1}><th className="row-index-heading" role="columnheader">#</th>{data.columns.map((column, columnIndex) => {
            const sorted = currentSort?.column === column.name ? currentSort.direction.toUpperCase() === 'ASC' ? 'ascending' : 'descending' : 'none'
            const nextSort = sorted === 'ascending' ? 'Sort descending' : sorted === 'descending' && onSortChange ? 'Clear sort' : 'Sort ascending'
            return <th key={column.name} role="columnheader" className={`${columnClasses[columnIndex]}${sorted !== 'none' ? ' is-sorted' : ''}`} aria-sort={sorted}>
              <span className="column-name">{onSort || onSortChange ? <button type="button" className="column-sort" aria-disabled={loading || saving || readOnly || undefined} onClick={() => sortBy(column.name)} aria-label={`Sort by ${column.name}`} title={`${column.name}: ${nextSort}`}>
                <span className="column-label">{column.name}</span>{sorted !== 'none' ? <Icon name={sorted === 'ascending' ? 'sort-asc' : 'sort-desc'} className="column-sort-icon" /> : null}
              </button> : column.name}{column.generated ? <Icon name="lock" className="column-lock" /> : null}</span><small title={column.dataType}>{column.dataType}</small></th>
          })}</tr></thead>
          <tbody>{visibleRows.map((row, rowIndex) => {
            const rowDeleted = deleted.has(row.id)
            const label = rowLabel(row)
            return <tr key={row.id} role="row" aria-rowindex={row.added ? undefined : rowOffset + Number(row.id.slice(4)) + 2} className={`${row.added ? 'is-added' : ''} ${rowDeleted ? 'is-deleted' : ''}`}>
            <td className="row-index" role="rowheader" aria-label={`${label}${row.added ? '' : rowDeleted ? ', marked for deletion' : ''}`} onPointerDown={(event) => {
              if (event.button !== 0 || saving) return
              event.preventDefault(); commitEditor()
              const first = { row: rowIndex, column: 0 }
              const range = cellRange(event.shiftKey ? { row: anchor.current?.row ?? rowIndex, column: 0 } : first, { row: rowIndex, column: data.columns.length - 1 })
              setSelection(event.ctrlKey || event.metaKey ? new Set([...selection, ...range]) : range)
              setActive(first); if (!event.shiftKey) anchor.current = first; focusCell(first)
            }} onContextMenu={(event) => {
              event.preventDefault(); openMenu(event.clientX, event.clientY, { row: rowIndex, column: 0 }, true)
            }} title={row.added ? 'New row' : rowDeleted ? 'Marked for deletion' : 'Select row'}>{row.added ? <Icon name="plus" className="row-added-icon" /> : rowOffset + Number(row.id.slice(4)) + 1}</td>
            {data.columns.map((column, columnIndex) => {
              const position = { row: rowIndex, column: columnIndex }
              const key = cellKey(position)
              const value = draftValue(row, column, columnIndex, view.edits)
              const selected = selection.has(key)
              const selectionEdges = selected ? [
                !selection.has(cellKey({ row: rowIndex - 1, column: columnIndex })) ? 'selection-top' : '',
                !selection.has(cellKey({ row: rowIndex, column: columnIndex + 1 })) ? 'selection-right' : '',
                !selection.has(cellKey({ row: rowIndex + 1, column: columnIndex })) ? 'selection-bottom' : '',
                !selection.has(cellKey({ row: rowIndex, column: columnIndex - 1 })) ? 'selection-left' : '',
              ].join(' ') : ''
              const editing = editor?.row.id === row.id && editor.column === columnIndex
              const changed = Object.prototype.hasOwnProperty.call(view.edits[row.id] ?? {}, column.name)
              const cellReadOnly = readOnly || column.generated || rowDeleted
              const shown = value === undefined ? 'DEFAULT' : value === null ? 'NULL' : valueText(value)
              return <td key={column.name} role="gridcell" data-cell={key} aria-selected={selected} aria-readonly={cellReadOnly} tabIndex={editing ? -1 : active ? cellKey(active) === key ? 0 : -1 : rowIndex === 0 && columnIndex === 0 ? 0 : -1}
                className={[columnClasses[columnIndex], selected ? 'is-selected' : '', selectionEdges, active && cellKey(active) === key ? 'is-active' : '', changed ? 'is-changed' : '', editing ? 'has-editor' : '', column.generated ? 'is-generated' : ''].filter(Boolean).join(' ')}
                aria-label={`${label}, ${column.name}: ${shown}${changed ? ', edited' : ''}`}
                onFocus={() => { if (!active) { setActive(position); setSelection(new Set([key])); anchor.current = position } }}
                onPointerDown={(event) => selectCell(event, position)} onPointerEnter={(event) => extendDrag(event, position)} onDoubleClick={() => beginEdit(position)}
                onContextMenu={(event) => { if (editing) return; event.preventDefault(); openMenu(event.clientX, event.clientY, position) }}>
                <div className="cell-value-scroll" title={valueText(value)}>{value === undefined ? <span className="null-value">DEFAULT</span> : value === null ? <span className="null-value">NULL</span> : typeof value === 'boolean' ? <span className={`boolean-value ${value ? 'is-true' : 'is-false'}`}>{String(value)}</span> : <span className="cell-text">{valueText(value)}</span>}</div>
                {editing ? <textarea ref={editorRef} className={`grid-cell-editor${editor.text.length > 40 || editor.text.includes('\n') ? ' is-long' : ''}`} aria-label={`Edit ${column.name}`} value={editor.text} autoFocus disabled={locked} spellCheck={false}
                  onFocus={(event) => {
                    // A typed key seeds the editor; keep it and continue typing after it.
                    const field = event.currentTarget
                    if (editor.seeded) field.setSelectionRange(field.value.length, field.value.length)
                    else field.select()
                  }}
                  onChange={(event) => setEditor({ ...editor, text: event.target.value, touched: true })} onBlur={commitEditor} onKeyDown={(event) => {
                    event.stopPropagation()
                    if (event.key === 'Escape') { event.preventDefault(); setEditor(null); focusCell(position) }
                    else if ((event.key === 'Enter' && !event.shiftKey && !event.altKey) || event.key === 'Tab') {
                      // At the grid boundary, native Tab moves out; blur commits the edit.
                      if (event.key === 'Tab' && !nextTabCell(position, event.shiftKey)) return
                      event.preventDefault(); commitEditor()
                      const next = event.key === 'Tab' ? nextTabCell(position, event.shiftKey)! : position
                      setActive(next); setSelection(new Set([cellKey(next)])); anchor.current = next; focusCell(next)
                    }
                  }} /> : null}
              </td>
            })}
          </tr>
          })}</tbody>
        </table>
        {!visibleRows.length ? <div className="empty-table">{search ? 'No rows match your search.' : 'This table has no rows yet. Use Add row to create one.'}</div> : null}
      </div>
    </div>
    <div className={`grid-feedback-row${footer ? ' has-footer' : ''}`}>
      <div className="grid-feedback" role="status" aria-live="polite" title={feedback.text || undefined}>{feedback.text}</div>
      {feedback.undo && canUndo ? <Button variant="ghost" size="sm" type="button" className="grid-feedback-undo" onClick={() => travel('undo')} title="Undo (Ctrl+Z)"><Icon name="undo" />Undo</Button> : null}
      {footer}
    </div>
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
          <span>{rowLabel(menuRow)}</span>
          <span>{menuColumn.nullable ? 'Nullable' : 'Not null'}</span>
          {menuColumn.generated ? <span>Generated</span> : null}
          {deleted.has(menuRow.id) ? <span>Deleted</span> : menuCellChanged ? <span>Edited</span> : null}
          {selection.size > 1 ? <span>{selection.size} cells selected</span> : null}
        </div>
        <div className={`grid-menu-cell-value ${menuValue === null || menuValue === undefined || menuValue === '' ? 'is-placeholder' : ''}`} title={menuValueText}>{menuValueText}</div>
      </div> : null}
      <button type="button" role="menuitem" disabled={locked || !menuRow || !menuColumn || menuColumn.generated || deleted.has(menuRow.id)} onClick={() => menu.cell && beginEdit(menu.cell)}><Icon name="edit" /><span>Edit cell</span></button>
      <button type="button" role="menuitem" disabled={!selection.size} onClick={() => void copySelection()}><Icon name="copy" /><span>Copy selection as CSV</span></button>
      <button type="button" role="menuitem" disabled={!selection.size} onClick={() => void copySelection(true)}><Icon name="table" /><span>Copy with headers</span></button>
      <button type="button" role="menuitem" disabled={locked || !menuRow || !menuColumn?.nullable || menuColumn.generated || deleted.has(menuRow.id)} onClick={() => {
        if (menuRow && menuColumn && menu.cell) { const column = menu.cell.column; updateDraft((current) => setCellValue(current, menuRow, column, null)) }
        setMenu(null)
      }}><Icon name="null" /><span>Set NULL</span></button>
      <button type="button" role="menuitem" disabled={locked || !menuRow || !menuColumn || !Object.prototype.hasOwnProperty.call(view.edits[menuRow.id] ?? {}, menuColumn.name)} onClick={() => {
        if (menuRow && menuColumn && menu.cell) { const column = menu.cell.column; updateDraft((current) => setCellValue(current, menuRow, column, undefined)) }
        setMenu(null)
      }}><Icon name="undo" /><span>{menuRow?.added ? 'Use default' : 'Revert cell'}</span></button>
      <hr />
      {menuRow && menu.cell ? <>
        <button type="button" role="menuitem" disabled={locked} onClick={() => addRow(undefined, { target: menuRow, side: 'above', column: menu.cell!.column })}><Icon name="row-above" /><span>Add row above</span></button>
        <button type="button" role="menuitem" disabled={locked} onClick={() => addRow(undefined, { target: menuRow, side: 'below', column: menu.cell!.column })}><Icon name="row-below" /><span>Add row below</span></button>
      </> : <button type="button" role="menuitem" disabled={locked} onClick={() => addRow()}><Icon name="plus" /><span>Add row</span></button>}
      <button type="button" role="menuitem" disabled={locked || !menuRow || deleted.has(menuRow.id)} onClick={() => menuRow && addRow(menuRow)}><Icon name="duplicate" /><span>Duplicate row</span></button>
      <hr />
      <button type="button" role="menuitem" disabled={locked || !selectedRows.length} className="danger-action" onClick={deleteRows}><Icon name="trash" /><span>Delete {selectedRows.length > 1 ? `${selectedRows.length} rows` : 'row'}</span></button>
      <button type="button" role="menuitem" disabled={locked || !selectedRows.some((row) => deleted.has(row.id))} onClick={() => {
        const ids = new Set(selectedRows.map((row) => row.id))
        updateDraft((current) => ({ ...current, deleted: new Set([...current.deleted].filter((id) => !ids.has(id))) })); setMenu(null)
      }}><Icon name="restore" /><span>Restore deleted rows</span></button>
    </div> : null}
  </div>
})

export default DataGrid
