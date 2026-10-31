import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import { PostgresService } from './services'
import { EditorState, Compartment } from '@codemirror/state'
import { EditorView, lineNumbers, highlightActiveLine, highlightActiveLineGutter, keymap } from '@codemirror/view'
import { sql, PostgreSQL, type SQLNamespace } from '@codemirror/lang-sql'
import { autocompletion, completionKeymap } from '@codemirror/autocomplete'
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands'
import { syntaxHighlighting, HighlightStyle } from '@codemirror/language'
import { tags } from '@lezer/highlight'
import { currentStatement } from './sql-statements'
export { currentStatement } from './sql-statements'
import ExportMenu from './ExportMenu'
import './sql-editor.css'

const sqlHighlighting = HighlightStyle.define([
  { tag: tags.keyword, color: 'var(--sql-keyword)', fontWeight: '600' },
  { tag: tags.string, color: 'var(--sql-string)' },
  { tag: [tags.number, tags.bool, tags.null], color: 'var(--sql-number)' },
  { tag: tags.comment, color: 'var(--muted)', fontStyle: 'italic' },
  { tag: tags.operator, color: 'var(--sql-keyword)' },
])

type Result = { columns: string[]; rows: (string | null)[][]; command: string; truncated: boolean }
type Execution = { results: Result[]; error: string; rolledBack: boolean }

export default function SqlEditor({ onRunningChange, active, databaseId, databaseName, script, onScriptChange, onExecuted, onHistory }: { onRunningChange: (running: boolean) => void; active: boolean; databaseId: string; databaseName: string; script: string; onScriptChange: (script: string) => void; onExecuted: () => void; onHistory?: (entry: { sql: string; databaseId: string; executedAt: number; durationMs: number; error: string }) => void }) {
  const [execution, setExecution] = useState<Execution | null>(null)
  const [error, setError] = useState('')
  const [running, setRunning] = useState(false)
  const [elapsedMs, setElapsedMs] = useState<number | null>(null)
  const [selection, setSelection] = useState({ start: 0, end: 0 })
  const [copyMessage, setCopyMessage] = useState('')
  const resultsId = useId()
  const sourceRef = useRef<HTMLDivElement>(null)
  const editorRef = useRef<HTMLDivElement>(null)
  const viewRef = useRef<EditorView | null>(null)
  const onScriptChangeRef = useRef(onScriptChange)
  onScriptChangeRef.current = onScriptChange
  const language = useRef(new Compartment())
  const [formatError, setFormatError] = useState('')
  const [resultsFocused, setResultsFocused] = useState(false)
  useEffect(() => {
    if (!editorRef.current) return
    const view = new EditorView({ parent: editorRef.current, state: EditorState.create({ doc: script, extensions: [
      lineNumbers(), history(), keymap.of([...completionKeymap, ...defaultKeymap, ...historyKeymap]), syntaxHighlighting(sqlHighlighting), highlightActiveLine(), highlightActiveLineGutter(), autocompletion(),
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
  const selected = selection.start !== selection.end
  const sqlToRun = selected ? script.slice(selection.start, selection.end) : script

  async function run(sqlText = sqlToRun) {
    if (!databaseId || !sqlText.trim() || running) return
    const executedAt = Date.now()
    let executionError = ''
    const started = performance.now()
    setRunning(true)
    onRunningChange(true)
    setElapsedMs(null)
    setError('')
    setCopyMessage('')
    setExecution(null)
    try {
      const result = await PostgresService.ExecuteSQLScript(databaseId, sqlText) as Execution
      setExecution(result)
      executionError = result.error || ''
    } catch (cause) {
      executionError = cause instanceof Error ? cause.message : String(cause)
      setError(executionError)
    } finally {
      const durationMs = Math.round(performance.now() - started)
      setElapsedMs(durationMs)
      onHistory?.({ sql: sqlText, databaseId, executedAt, durationMs, error: executionError })
      setRunning(false)
      onRunningChange(false)
      onExecuted()
    }
  }

  useEffect(() => {
    if (!active) return
    const onRun = () => { void run() }
    window.addEventListener('hyperpg-run-script', onRun)
    return () => window.removeEventListener('hyperpg-run-script', onRun)
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

  return <section className="sql-workspace" ref={workspaceRef}>
    <div className="sql-source" ref={sourceRef} aria-hidden={resultsFocused || undefined}>
    <div className="sql-heading"><div><h1>SQL editor</h1><span>{databaseName}</span></div><div className="sql-actions">
      <button className="sql-button" type="button" disabled={running || !script} onClick={() => { onScriptChange(''); setSelection({ start: 0, end: 0 }); viewRef.current?.focus() }}>Clear</button>
      <button className="sql-button" type="button" disabled={running || !script.trim()} onClick={() => { void import('sql-formatter').then(({ format }) => { if (viewRef.current?.state.doc.toString() !== script) return; onScriptChange(format(script, { language: 'postgresql', keywordCase: 'upper' })); setFormatError('') }).catch((cause: unknown) => setFormatError(cause instanceof Error ? cause.message : String(cause))) }}>Format</button>
      <button className="sql-button" type="button" disabled={!databaseId || running || !script.trim()} onClick={() => void run(currentStatement(script, viewRef.current?.state.selection.main.head ?? 0))}>Run statement</button>
      <button className="sql-button sql-run" type="button" onClick={() => void run()} disabled={!databaseId || running || !sqlToRun.trim()}>{running ? 'Running…' : selected ? 'Run selection' : 'Run script'}</button>
    </div></div>
    <div ref={editorRef} className="sql-editor" style={{ height: editorHeight ?? undefined }} />
    {formatError ? <div className="notice notice-error" role="alert">Could not format SQL: {formatError}</div> : null}
    <div className="sql-divider" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.min(100, Math.round(100 * (editorHeight ?? editorRef.current?.clientHeight ?? 0) / Math.max(1, workspaceRef.current?.clientHeight ?? 1)))} role="separator" aria-label="Resize script and results" aria-orientation="horizontal" tabIndex={0} onPointerDown={(event) => { if (event.button !== 0) return; event.currentTarget.setPointerCapture(event.pointerId); resizeOrigin.current = event.clientY - (editorRef.current?.getBoundingClientRect().bottom ?? event.clientY) }} onPointerMove={(event) => { if (event.currentTarget.hasPointerCapture(event.pointerId)) resizeEditor(event.clientY - resizeOrigin.current) }} onKeyDown={(event) => { if (event.key === 'ArrowUp' || event.key === 'ArrowDown') { event.preventDefault(); const editor = editorRef.current; if (editor) resizeEditor(editor.getBoundingClientRect().bottom + (event.key === 'ArrowUp' ? -20 : 20)) } }} />
    </div>
    <div id={resultsId} className={`sql-results${resultsFocused ? ' is-expanded' : ''}`} role="region" aria-label="Query results" aria-live="polite" onKeyDown={(event) => { if (event.key === 'Escape' && resultsFocused) { event.preventDefault(); event.stopPropagation(); setResultsFocused(false) } }}>
      <div className="sql-results-heading">Results <div className="sql-result-actions"><span>{elapsedMs !== null ? `${elapsedMs} ms` : ''}</span><button className="sql-focus-button" type="button" aria-expanded={resultsFocused} aria-controls={resultsId} aria-label={resultsFocused ? 'Restore editor' : 'Expand results'} title={resultsFocused ? 'Restore editor' : 'Expand results'} onClick={() => setResultsFocused((value) => !value)}>{resultsFocused ? '↙' : '↗'}</button></div></div>
      {copyMessage ? <div className="sql-message" role="status">{copyMessage}</div> : null}
      {error || execution?.error ? <div className="notice notice-error" role="alert">{error || execution?.error}</div> : null}
      {execution?.rolledBack ? <div className="sql-message">An open transaction was rolled back. Include COMMIT to save it.</div> : null}
      {execution?.results.map((result, index) => <div className="sql-result" key={index}>
        <div className="sql-result-meta"><strong>{result.command || `Result ${index + 1}`}</strong>{result.columns.length ? <div className="sql-result-actions"><span>{result.rows.length}{result.truncated ? '+' : ''} rows{result.truncated ? ' (first 500 shown)' : ''}</span><button className="sql-button" type="button" onClick={() => void copyResult(result)}>Copy CSV</button><ExportMenu columns={result.columns} rows={result.rows} fileName="query-results" /></div> : null}</div>
        {result.columns.length ? <div className="sql-table-wrap"><table><thead><tr>{result.columns.map((column, i) => <th key={i}>{column}</th>)}</tr></thead><tbody>{result.rows.map((row, i) => <tr key={i}>{row.map((value, j) => <td key={j}>{value === null ? <em>NULL</em> : value}</td>)}</tr>)}</tbody></table></div> : null}
      </div>)}
    </div>
  </section>
}
