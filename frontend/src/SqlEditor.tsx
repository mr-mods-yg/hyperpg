import Button from './ui/Button'
import ActionGroup from './ui/ActionGroup'
import { createPortal } from 'react-dom'
import { useEffect, useId, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import { PostgresService } from './services'
import { EditorState, Compartment, Prec, StateEffect, StateField, type Range } from '@codemirror/state'
import { EditorView, Decoration, type DecorationSet, lineNumbers, highlightActiveLine, highlightActiveLineGutter, keymap } from '@codemirror/view'
import { sql, PostgreSQL, type SQLNamespace } from '@codemirror/lang-sql'
import { autocompletion, completionKeymap, completionStatus } from '@codemirror/autocomplete'
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands'
import { syntaxHighlighting, HighlightStyle } from '@codemirror/language'
import { tags } from '@lezer/highlight'
import { characterOffset, currentStatementRange, statementRanges } from './sql-statements'
export { currentStatement } from './sql-statements'
import ExportMenu from './ExportMenu'
import Icon from './Icon'
import './sql-editor.css'

const sqlHighlighting = HighlightStyle.define([
  { tag: tags.keyword, color: 'var(--sql-keyword)', fontWeight: '600' },
  { tag: [tags.typeName, tags.standard(tags.name)], color: 'var(--sql-type)' },
  { tag: [tags.function(tags.variableName), tags.special(tags.name)], color: 'var(--sql-function)' },
  { tag: [tags.string, tags.special(tags.string)], color: 'var(--sql-string)' },
  { tag: [tags.number, tags.bool, tags.null], color: 'var(--sql-number)' },
  { tag: tags.comment, color: 'var(--sql-comment)', fontStyle: 'italic' },
  { tag: tags.operator, color: 'var(--sql-operator)' },
])

type ErrorMark = { from: number; to: number; pointFrom: number; pointTo: number } | null
const setErrorMark = StateEffect.define<ErrorMark>()
// The failing statement stays marked until the script changes or another run starts.
const errorMarkField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(marks, transaction) {
    if (transaction.docChanged) marks = Decoration.none
    for (const effect of transaction.effects) {
      if (!effect.is(setErrorMark)) continue
      const mark = effect.value
      if (!mark) { marks = Decoration.none; continue }
      const ranges: Range<Decoration>[] = []
      if (mark.to > mark.from) ranges.push(Decoration.mark({ class: 'cm-sql-error-statement' }).range(mark.from, mark.to))
      if (mark.pointTo > mark.pointFrom) ranges.push(Decoration.mark({ class: 'cm-sql-error-point', attributes: { title: 'PostgreSQL reported the error here' } }).range(mark.pointFrom, mark.pointTo))
      marks = Decoration.set(ranges, true)
    }
    return marks
  },
  provide: (field) => EditorView.decorations.from(field),
})

const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad|iPod/.test(navigator.platform || navigator.userAgent)
const modLabel = isMac ? 'Cmd' : 'Ctrl'
const modAria = isMac ? 'Meta' : 'Control'
const shortcuts = {
  statement: { label: `${modLabel}+Enter`, aria: `${modAria}+Enter` },
  script: { label: `${modLabel}+Shift+Enter`, aria: `${modAria}+Shift+Enter` },
}

type Result = { columns: string[]; rows: (string | null)[][]; command: string; truncated: boolean; durationMs?: number }
// Fields beyond results/error/rolledBack are optional so older backends and test mocks still work.
type Execution = { results: Result[]; error: string; rolledBack: boolean; cancelled?: boolean; statementCount?: number; failedStatement?: number; errorPosition?: number; rolledBackFrom?: number }
type RunContext = { text: string; from: number; doc: string }
type CancellableService = { CancelSQLScript?: (executionID: string) => Promise<boolean> | boolean }
/** How often an early Cancel is retried while the backend has not registered the run yet. */
const CANCEL_RETRY_MS = 150

const numericValue = /^[-+]?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?$/i
function isNumericColumn(rows: (string | null)[][], column: number) {
  let seen = false
  for (const row of rows) {
    const value = row[column]
    if (value === null || value === undefined) continue
    if (!numericValue.test(value)) return false
    seen = true
  }
  return seen
}

function formatDuration(ms: number) {
  if (ms < 1) return '<1 ms'
  if (ms < 1000) return `${Math.round(ms)} ms`
  return `${(ms / 1000).toFixed(ms < 10000 ? 2 : 1)} s`
}

function plural(count: number, word: string) { return `${count} ${count === 1 ? word : `${word}s`}` }

function statementList(from: number, to: number) {
  return from === to ? `Statement ${from} was` : `Statements ${from}–${to} were`
}

/** Describe what a failed or cancelled run did to the rest of the script. */
function failureSummary(execution: Execution) {
  const count = Math.max(execution.statementCount ?? 0, execution.failedStatement ?? 0)
  const failed = execution.failedStatement ?? 0
  const title = execution.cancelled
    ? 'Query cancelled'
    : failed && count > 1 ? `Statement ${failed} of ${count} failed` : 'Query failed'
  const notes: string[] = []
  if (failed) {
    if (execution.cancelled && count > 1) notes.push(`Stopped during statement ${failed} of ${count}.`)
    // PostgreSQL parses the whole script before running it, so syntax errors stop everything.
    if (failed > 1 && execution.results.length < failed - 1) notes.push('No statements were run.')
    else if (execution.rolledBackFrom && execution.rolledBackFrom < failed) notes.push(execution.rolledBackFrom === failed - 1 ? `Changes from statement ${failed - 1} were rolled back.` : `Changes from statements ${execution.rolledBackFrom}–${failed - 1} were rolled back.`)
    if (failed < count) notes.push(`${statementList(failed + 1, count)} not run.`)
  }
  if (execution.rolledBack) notes.push('The open transaction was rolled back.')
  return { title, notes }
}

type SqlEditorProps = {
  onRunningChange: (running: boolean) => void
  active: boolean
  databaseId: string
  databaseName: string
  script: string
  onScriptChange: (script: string) => void
  onExecuted: () => void
  onHistory?: (entry: { sql: string; databaseId: string; executedAt: number; durationMs: number; error: string }) => void
  // Owner file controls (Save, Rename, saved state) shown in the editor toolbar row.
  fileActions?: ReactNode
  // Focus the editor when it mounts, e.g. for a new script.
  autoFocus?: boolean
  // Incrementing this cancels the running query, even when the tab is not active.
  cancelRequest?: number
}

export default function SqlEditor({ onRunningChange, active, databaseId, databaseName, script, onScriptChange, onExecuted, onHistory, fileActions, autoFocus = false, cancelRequest = 0 }: SqlEditorProps) {
  const [execution, setExecution] = useState<Execution | null>(null)
  const [error, setError] = useState('')
  const [running, setRunning] = useState(false)
  const [cancelling, setCancelling] = useState(false)
  const [startedAt, setStartedAt] = useState(0)
  const [now, setNow] = useState(0)
  const [elapsedMs, setElapsedMs] = useState<number | null>(null)
  const [selection, setSelection] = useState({ start: 0, end: 0 })
  const [copyMessage, setCopyMessage] = useState('')
  const resultsId = useId()
  const resultsToggleRef = useRef<HTMLButtonElement>(null)
  const sourceRef = useRef<HTMLDivElement>(null)
  const editorRef = useRef<HTMLDivElement>(null)
  const viewRef = useRef<EditorView | null>(null)
  const errorRef = useRef<HTMLDivElement>(null)
  const onScriptChangeRef = useRef(onScriptChange)
  onScriptChangeRef.current = onScriptChange
  const runningRef = useRef(false)
  const executionIdRef = useRef('')
  // The editor is created once, so its key bindings call the latest handlers through refs.
  const shortcutRef = useRef<(scope: 'statement' | 'script') => void>(() => {})
  const cancelRef = useRef<() => boolean>(() => false)
  const cancellingIdRef = useRef('')
  const cancelRetryRef = useRef<number | undefined>(undefined)
  const stopCancelRetry = () => {
    window.clearTimeout(cancelRetryRef.current)
    cancelRetryRef.current = undefined
    cancellingIdRef.current = ''
  }
  useEffect(() => stopCancelRetry, [])
  const language = useRef(new Compartment())
  const [formatError, setFormatError] = useState('')
  const [resultsFocused, setResultsFocused] = useState(false)
  const [expandedBounds, setExpandedBounds] = useState<CSSProperties>({})
  const wasExpanded = useRef(false)
  const canCancel = typeof (PostgresService as unknown as CancellableService).CancelSQLScript === 'function'
  useEffect(() => {
    if (!editorRef.current) return
    const view = new EditorView({ parent: editorRef.current, state: EditorState.create({ doc: script, extensions: [
      Prec.highest(keymap.of([
        { key: 'Mod-Enter', preventDefault: true, run: () => { shortcutRef.current('statement'); return true } },
        { key: 'Shift-Mod-Enter', preventDefault: true, run: () => { shortcutRef.current('script'); return true } },
        // Let Escape close the completion popup first.
        { key: 'Escape', run: (target) => completionStatus(target.state) === null && cancelRef.current() },
      ])),
      lineNumbers(), history(), keymap.of([...completionKeymap, ...defaultKeymap, ...historyKeymap]), syntaxHighlighting(sqlHighlighting), highlightActiveLine(), highlightActiveLineGutter(), autocompletion({ icons: false }),
      errorMarkField,
      language.current.of(sql({ dialect: PostgreSQL })),
      EditorView.contentAttributes.of({ 'aria-label': 'SQL script', spellcheck: 'false' }),
      EditorView.updateListener.of((update) => {
        if (update.docChanged) onScriptChangeRef.current(update.state.doc.toString())
        if (update.selectionSet || update.docChanged) {
          const range = update.state.selection.main
          setSelection({ start: range.from, end: range.to })
        }
      }),
    ] }) })
    viewRef.current = view
    if (autoFocus) view.focus()
    return () => { view.destroy(); viewRef.current = null }
  }, [])
  useLayoutEffect(() => {
    if (active && !resultsFocused) viewRef.current?.requestMeasure()
  }, [active, resultsFocused])
  useEffect(() => {
    const view = viewRef.current
    if (view && view.state.doc.toString() !== script) view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: script } })
  }, [script])
  useEffect(() => {
    let cancelled = false
    // Bindings are regenerated when the backend metadata method is added.
    const service = PostgresService as typeof PostgresService & { GetSchemaCompletions: (id: string) => Promise<{ schema: string; table: string; columns: string[] }[] | null> }
    if (!databaseId || !service.GetSchemaCompletions) return
    void service.GetSchemaCompletions(databaseId).then((items) => {
      if (cancelled || !viewRef.current) return
      const schema: SQLNamespace = {}
      for (const item of items ?? []) {
        if (!schema[item.schema]) schema[item.schema] = {}
        ;(schema[item.schema] as SQLNamespace)[item.table] = item.columns
      }
      viewRef.current.dispatch({ effects: language.current.reconfigure(sql({ dialect: PostgreSQL, schema, defaultSchema: 'public' })) })
    }).catch(() => {})
    return () => { cancelled = true; viewRef.current?.dispatch({ effects: language.current.reconfigure(sql({ dialect: PostgreSQL })) }) }
  }, [databaseId])
  useEffect(() => {
    if (!running) return
    const timer = window.setInterval(() => setNow(performance.now()), 100)
    return () => window.clearInterval(timer)
  }, [running])
  const workspaceRef = useRef<HTMLElement>(null)
  const [editorHeight, setEditorHeight] = useState<number | null>(null)
  const resizeOrigin = useRef(0)
  function resizeEditor(clientY: number) {
    const editor = editorRef.current
    const workspace = workspaceRef.current
    if (!editor || !workspace) return
    const top = editor.getBoundingClientRect().top
    const max = Math.max(60, workspace.getBoundingClientRect().bottom - top - 100)
    setEditorHeight(Math.max(60, Math.min(max, clientY - top)))
  }
  useEffect(() => {
    const workspace = workspaceRef.current
    if (!workspace || !active || resultsFocused) return
    const observer = new ResizeObserver(() => {
      const editor = editorRef.current
      if (!editor) return
      const max = Math.max(60, workspace.getBoundingClientRect().bottom - editor.getBoundingClientRect().top - 100)
      setEditorHeight((height) => height === null ? null : Math.min(height, max))
    })
    observer.observe(workspace)
    return () => observer.disconnect()
  }, [active, resultsFocused])
  useLayoutEffect(() => {
    if (sourceRef.current) sourceRef.current.inert = resultsFocused
  }, [resultsFocused])
  useLayoutEffect(() => {
    if (!active && resultsFocused) { setResultsFocused(false); return }
    if (resultsFocused) {
      const place = () => {
        const rect = workspaceRef.current?.getBoundingClientRect()
        if (rect) setExpandedBounds({ top: rect.top + 8, left: rect.left + 8, width: Math.max(0, rect.width - 16), height: Math.max(0, rect.height - 16) })
      }
      place()
      const observer = new ResizeObserver(place)
      if (workspaceRef.current) observer.observe(workspaceRef.current)
      window.addEventListener('resize', place)
      window.addEventListener('scroll', place, true)
      resultsToggleRef.current?.focus()
      wasExpanded.current = true
      return () => { observer.disconnect(); window.removeEventListener('resize', place); window.removeEventListener('scroll', place, true) }
    }
    if (wasExpanded.current && active) resultsToggleRef.current?.focus()
    wasExpanded.current = false
  }, [resultsFocused, active])
  useEffect(() => {
    if (execution?.error) errorRef.current?.scrollIntoView?.({ block: 'nearest' })
  }, [execution])
  const selected = selection.start !== selection.end
  const sqlToRun = selected ? script.slice(selection.start, selection.end) : script

  /** Mark the failing statement, and the token PostgreSQL pointed at, in the editor. */
  function markError(result: Execution, context: RunContext) {
    const view = viewRef.current
    if (!view || !result.failedStatement || view.state.doc.toString() !== context.doc) return
    const statement = statementRanges(context.text)[result.failedStatement - 1]
    if (!statement) return
    const from = context.from + statement.from, to = context.from + statement.to
    let pointFrom = 0, pointTo = 0
    if (result.errorPosition && !result.cancelled) {
      pointFrom = Math.min(context.from + characterOffset(context.text, result.errorPosition), to)
      pointTo = pointFrom
      const text = view.state.doc.toString()
      while (pointTo < to && /[\w$."]/.test(text[pointTo])) pointTo++
      if (pointTo === pointFrom) {
        // Errors such as "at end of input" point past the last token.
        if (pointFrom >= to) pointFrom = Math.max(from, to - 1)
        pointTo = Math.min(to, pointFrom + 1)
      }
    }
    view.dispatch({ effects: [setErrorMark.of({ from, to, pointFrom, pointTo }), EditorView.scrollIntoView(pointTo > pointFrom ? pointFrom : from, { y: 'nearest' })] })
  }

  async function run(sqlText = sqlToRun, from = selected ? selection.start : 0) {
    if (!databaseId || !sqlText.trim() || runningRef.current) return
    runningRef.current = true
    const context: RunContext = { text: sqlText, from, doc: viewRef.current?.state.doc.toString() ?? script }
    const executionId = typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`
    executionIdRef.current = executionId
    const executedAt = Date.now()
    let executionError = ''
    const started = performance.now()
    setStartedAt(started)
    setNow(started)
    setRunning(true)
    setCancelling(false)
    onRunningChange(true)
    setElapsedMs(null)
    setError('')
    setCopyMessage('')
    setExecution(null)
    viewRef.current?.dispatch({ effects: setErrorMark.of(null) })
    try {
      const result = await PostgresService.ExecuteSQLScript(databaseId, sqlText, executionId) as Execution
      setExecution(result)
      executionError = result.error || ''
      if (result.error) markError(result, context)
    } catch (cause) {
      executionError = cause instanceof Error ? cause.message : String(cause)
      setError(executionError)
    } finally {
      const durationMs = Math.round(performance.now() - started)
      executionIdRef.current = ''
      runningRef.current = false
      stopCancelRetry()
      setElapsedMs(durationMs)
      onHistory?.({ sql: sqlText, databaseId, executedAt, durationMs, error: executionError })
      setRunning(false)
      setCancelling(false)
      onRunningChange(false)
      onExecuted()
    }
  }

  function cancel() {
    const id = executionIdRef.current
    const service = PostgresService as unknown as CancellableService
    if (!runningRef.current || !id || typeof service.CancelSQLScript !== 'function') return false
    setCancelling(true)
    // A retry loop is already chasing this run.
    if (cancellingIdRef.current === id) return true
    cancellingIdRef.current = id
    const stillPending = () => runningRef.current && executionIdRef.current === id
    const attempt = () => {
      cancelRetryRef.current = undefined
      // The backend registers a run shortly after ExecuteSQLScript starts, so a
      // very early cancel reports false. Retry until it lands or the run ends.
      Promise.resolve().then(() => service.CancelSQLScript!(id)).then((accepted) => {
        if (cancellingIdRef.current !== id) return
        if (accepted === false && stillPending()) { cancelRetryRef.current = window.setTimeout(attempt, CANCEL_RETRY_MS); return }
        cancellingIdRef.current = ''
      }, () => {
        if (cancellingIdRef.current !== id) return
        cancellingIdRef.current = ''
        if (stillPending()) setCancelling(false)
      })
    }
    attempt()
    return true
  }

  function runFromShortcut(scope: 'statement' | 'script') {
    const view = viewRef.current
    if (!view || !active) return
    const text = view.state.doc.toString()
    if (scope === 'script') { void run(text, 0); return }
    const range = view.state.selection.main
    if (!range.empty) { void run(text.slice(range.from, range.to), range.from); return }
    const statement = currentStatementRange(text, range.head)
    void run(text.slice(statement.from, statement.to), statement.from)
  }
  shortcutRef.current = runFromShortcut
  cancelRef.current = cancel
  const lastCancelRequest = useRef(cancelRequest)
  useEffect(() => {
    if (cancelRequest === lastCancelRequest.current) return
    lastCancelRequest.current = cancelRequest
    cancel()
  }, [cancelRequest])

  useEffect(() => {
    if (!active) return
    const onRun = () => { void run() }
    const onCancel = () => { cancel() }
    window.addEventListener('hyperpg-run-script', onRun)
    window.addEventListener('hyperpg-cancel-script', onCancel)
    return () => { window.removeEventListener('hyperpg-run-script', onRun); window.removeEventListener('hyperpg-cancel-script', onCancel) }
  })

  async function copyResult(result: Result) {
    const csvCell = (value: string | null) => {
      const text = value ?? ''
      return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
    }
    const csv = [result.columns, ...result.rows].map((row) => row.map(csvCell).join(',')).join('\r\n')
    try { await navigator.clipboard.writeText(csv); setCopyMessage('Copied CSV') }
    catch { setCopyMessage('Could not copy CSV') }
  }

  const failure = execution?.error ? failureSummary(execution) : null
  const totalRows = execution?.results.reduce((sum, result) => sum + result.rows.length, 0) ?? 0
  const summary = running ? 'Running query…'
    : error ? 'Query failed'
    : failure ? failure.title
    : execution ? [plural(execution.results.length, 'statement') + ' succeeded', execution.results.some((result) => result.columns.length) ? plural(totalRows, 'row') : '', elapsedMs !== null ? formatDuration(elapsedMs) : ''].filter(Boolean).join(' · ')
    : ''
  const runningLabel = `${cancelling ? 'Cancelling' : 'Running'}… ${((now - startedAt) / 1000).toFixed(1)} s`
  const errorBanner = (text: string) => <div className="sql-error" ref={errorRef}>
    <div className="sql-error-heading"><svg className="ui-icon" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" aria-hidden="true"><circle cx="10" cy="10" r="7" /><path d="M10 6.5v4M10 13.5v.01" /></svg><strong>{failure?.title ?? 'Query failed'}</strong></div>
    {failure?.notes.length ? <p className="sql-error-notes">{failure.notes.join(' ')}</p> : null}
    {execution?.cancelled && text === 'Query cancelled' ? null : <pre className="sql-error-text">{text}</pre>}
  </div>

  return <section className="sql-workspace" ref={workspaceRef} onKeyDown={(event) => {
    // Escape anywhere in the workspace stops a running query.
    if (event.key === 'Escape' && !event.defaultPrevented && runningRef.current && cancel()) event.preventDefault()
  }}>
    <div className="sql-source" ref={sourceRef} aria-hidden={resultsFocused || undefined}>
    <div className={`sql-heading${fileActions ? ' has-file-actions' : ''}`}>{fileActions
      ? <div className="sql-heading-start"><h1 className="visually-hidden">SQL editor</h1>{fileActions}<span className="sql-database" title={databaseName}><Icon name="database" />{databaseName}</span></div>
      : <div><h1>SQL editor</h1><span title={databaseName}>{databaseName}</span></div>}<div className="sql-actions">
      <ActionGroup label="Editor actions">
      <Button type="button" disabled={running || !script} onClick={() => { onScriptChange(''); setSelection({ start: 0, end: 0 }); viewRef.current?.focus() }}>Clear</Button>
      <Button type="button" disabled={running || !script.trim()} onClick={() => { void import('sql-formatter').then(({ format }) => { if (viewRef.current?.state.doc.toString() !== script) return; onScriptChange(format(script, { language: 'postgresql', keywordCase: 'upper' })); setFormatError('') }).catch((cause: unknown) => setFormatError(cause instanceof Error ? cause.message : String(cause))) }}>Format</Button>
      <Button type="button" title={`Run the statement at the cursor (${shortcuts.statement.label})`} aria-keyshortcuts={selected ? undefined : shortcuts.statement.aria} disabled={!databaseId || running || !script.trim()} onClick={() => { const range = currentStatementRange(script, viewRef.current?.state.selection.main.head ?? 0); void run(script.slice(range.from, range.to), range.from) }}>Run statement</Button>
      </ActionGroup>
      {running ? <span className="sql-run-timer" aria-hidden="true">{runningLabel}</span> : null}
      {running && canCancel
        ? <Button key="cancel" className="compact-toolbar-action sql-cancel-button" type="button" title="Cancel query (Esc)" aria-keyshortcuts="Escape" disabled={cancelling} onClick={cancel}>{cancelling ? <span className="button-spinner" /> : <svg className="ui-icon" viewBox="0 0 20 20" aria-hidden="true"><rect x="5.5" y="5.5" width="9" height="9" rx="1.5" fill="currentColor" /></svg>}{cancelling ? 'Cancelling…' : 'Cancel'}</Button>
        : <Button key="run" className="compact-toolbar-action" variant="primary" type="button" title={running ? undefined : selected ? `Run selection (${shortcuts.statement.label})` : `Run script (${shortcuts.script.label})`} aria-keyshortcuts={running ? undefined : selected ? shortcuts.statement.aria : shortcuts.script.aria} onClick={() => void run()} disabled={!databaseId || running || !sqlToRun.trim()}>{running ? <span className="button-spinner" /> : <Icon name="play" />}{running ? 'Running…' : selected ? 'Run selection' : 'Run script'}</Button>}
    </div></div>
    <div ref={editorRef} className="sql-editor" style={{ height: editorHeight ?? undefined }} />
    {formatError ? <div className="notice notice-error" role="alert">Could not format SQL: {formatError}</div> : null}
    <div className="sql-divider" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.min(100, Math.round(100 * (editorHeight ?? editorRef.current?.clientHeight ?? 0) / Math.max(1, workspaceRef.current?.clientHeight ?? 1)))} role="separator" aria-label="Resize script and results" aria-orientation="horizontal" tabIndex={0} onPointerDown={(event) => { if (event.button !== 0) return; event.currentTarget.setPointerCapture(event.pointerId); resizeOrigin.current = event.clientY - (editorRef.current?.getBoundingClientRect().bottom ?? event.clientY) }} onPointerMove={(event) => { if (event.currentTarget.hasPointerCapture(event.pointerId)) resizeEditor(event.clientY - resizeOrigin.current) }} onKeyDown={(event) => { if (event.key === 'ArrowUp' || event.key === 'ArrowDown') { event.preventDefault(); const editor = editorRef.current; if (editor) resizeEditor(editor.getBoundingClientRect().bottom + (event.key === 'ArrowUp' ? -20 : 20)) } }} />
    </div>
    {(() => { const results = <div id={resultsId} style={resultsFocused ? expandedBounds : undefined} className={`sql-results${resultsFocused ? ' is-expanded' : ''}`} role="region" aria-label="Query results" aria-busy={running || undefined} onKeyDown={(event) => { if (event.key === 'Escape' && resultsFocused) { event.preventDefault(); event.stopPropagation(); setResultsFocused(false) } }}>
      <div className="sql-results-heading">Results <div className="sql-result-actions"><span className={`sql-results-summary${failure || error ? ' is-error' : ''}`} role="status">{summary}</span><Button ref={resultsToggleRef} iconOnly type="button" aria-expanded={resultsFocused} aria-controls={resultsId} aria-label={resultsFocused ? 'Restore editor' : 'Expand results'} title={resultsFocused ? 'Restore editor' : 'Expand results'} onClick={() => setResultsFocused((value) => !value)}><Icon name={resultsFocused ? 'collapse' : 'expand'} /></Button></div></div>
      {copyMessage ? <div className="sql-message" role="status">{copyMessage}</div> : null}
      {error ? errorBanner(error) : null}
      {execution?.rolledBack && !execution.error ? <div className="sql-message">An open transaction was rolled back. Include COMMIT to save it.</div> : null}
      {!execution && !error ? <div className="sql-results-empty"><Icon name="table" /><strong>{running ? runningLabel : 'Your results will appear here'}</strong><span>{running ? canCancel ? 'Waiting for the database to respond. Press Esc to cancel.' : 'Waiting for the database to respond.' : `Run a script (${shortcuts.script.label}) or the statement at the cursor (${shortcuts.statement.label}).`}</span></div> : null}
      {execution?.results.map((result, index) => {
        const meta = [result.columns.length ? `${result.rows.length}${result.truncated ? '+' : ''} ${result.rows.length === 1 && !result.truncated ? 'row' : 'rows'}${result.truncated ? ' (first 500 shown)' : ''}` : '', typeof result.durationMs === 'number' ? formatDuration(result.durationMs) : ''].filter(Boolean).join(' · ')
        if (!result.columns.length) return <div className="sql-result-command" key={index}><strong>{result.command || `Result ${index + 1}`}</strong>{meta ? <span>{meta}</span> : null}</div>
        const numeric = result.columns.map((_, column) => isNumericColumn(result.rows, column))
        return <div className="sql-result" key={index}>
          <div className="sql-result-meta"><strong>{result.command || `Result ${index + 1}`}</strong><div className="sql-result-actions">{meta ? <span>{meta}</span> : null}<Button type="button" onClick={() => void copyResult(result)}><Icon name="copy" />Copy CSV</Button><ExportMenu columns={result.columns} rows={result.rows} fileName="query-results" /></div></div>
          <div className="sql-table-wrap"><table className="sql-grid"><thead><tr><th className="sql-grid-index" scope="col">#</th>{result.columns.map((column, i) => <th key={i} scope="col" className={numeric[i] ? 'is-numeric' : undefined}>{column}</th>)}</tr></thead><tbody>{result.rows.map((row, i) => <tr key={i}><th className="sql-grid-index" scope="row">{i + 1}</th>{row.map((value, j) => <td key={j} className={numeric[j] ? 'is-numeric' : undefined} title={value !== null && value.length > 40 ? value : undefined}>{value === null ? <span className="null-value">NULL</span> : value}</td>)}</tr>)}</tbody></table></div>
        </div>
      })}
      {execution?.error ? errorBanner(execution.error) : null}
    </div>
    return resultsFocused ? createPortal(results, document.body) : results })()}
  </section>
}
