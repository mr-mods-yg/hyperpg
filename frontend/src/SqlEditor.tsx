import { useEffect, useRef, useState } from 'react'
import { PostgresService } from '../bindings/changeme'
import './sql-editor.css'

type Result = { columns: string[]; rows: (string | null)[][]; command: string; truncated: boolean }
type Execution = { results: Result[]; error: string; rolledBack: boolean }

export default function SqlEditor({ onRunningChange, active, databaseId, databaseName, script, onScriptChange, onExecuted }: { onRunningChange: (running: boolean) => void; active: boolean; databaseId: string; databaseName: string; script: string; onScriptChange: (script: string) => void; onExecuted: () => void }) {
  const [execution, setExecution] = useState<Execution | null>(null)
  const [error, setError] = useState('')
  const [running, setRunning] = useState(false)
  const [elapsedMs, setElapsedMs] = useState<number | null>(null)
  const [selection, setSelection] = useState({ start: 0, end: 0 })
  const [copyMessage, setCopyMessage] = useState('')
  const editorRef = useRef<HTMLTextAreaElement>(null)
  const workspaceRef = useRef<HTMLElement>(null)
  const [editorHeight, setEditorHeight] = useState<number | null>(null)
  const [resultsFocused, setResultsFocused] = useState(false)
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
  const selected = selection.start !== selection.end
  const sqlToRun = selected ? script.slice(selection.start, selection.end) : script

  async function run() {
    if (!sqlToRun.trim() || running) return
    const started = performance.now()
    setRunning(true)
    onRunningChange(true)
    setElapsedMs(null)
    setError('')
    setCopyMessage('')
    setExecution(null)
    try {
      const result = await PostgresService.ExecuteSQLScript(databaseId, sqlToRun) as Execution
      setExecution(result)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setElapsedMs(Math.round(performance.now() - started))
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
    <div className="sql-heading" hidden={resultsFocused}><div><h1>SQL editor</h1><span>{databaseName}</span></div><div className="sql-actions">
      <button className="sql-button" type="button" disabled={running || !script} onClick={() => { onScriptChange(''); setSelection({ start: 0, end: 0 }); editorRef.current?.focus() }}>Clear</button>
      <button className="sql-button sql-run" type="button" onClick={() => void run()} disabled={running || !sqlToRun.trim()}>{running ? 'Running…' : selected ? 'Run selection' : 'Run script'}</button>
    </div></div>
    <textarea ref={editorRef} className="sql-editor" style={{ height: editorHeight ?? undefined, display: resultsFocused ? 'none' : undefined }} aria-label="SQL script" spellCheck={false} value={script} onChange={(event) => { onScriptChange(event.target.value); setSelection({ start: event.target.selectionStart, end: event.target.selectionEnd }) }} onSelect={(event) => setSelection({ start: event.currentTarget.selectionStart, end: event.currentTarget.selectionEnd })} placeholder="SELECT * FROM …" />
    <div className="sql-divider" hidden={resultsFocused} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.min(100, Math.round(100 * (editorHeight ?? editorRef.current?.clientHeight ?? 0) / Math.max(1, workspaceRef.current?.clientHeight ?? 1)))} role="separator" aria-label="Resize script and results" aria-orientation="horizontal" tabIndex={0} onPointerDown={(event) => { if (event.button !== 0) return; event.currentTarget.setPointerCapture(event.pointerId); resizeOrigin.current = event.clientY - (editorRef.current?.getBoundingClientRect().bottom ?? event.clientY) }} onPointerMove={(event) => { if (event.currentTarget.hasPointerCapture(event.pointerId)) resizeEditor(event.clientY - resizeOrigin.current) }} onKeyDown={(event) => { if (event.key === 'ArrowUp' || event.key === 'ArrowDown') { event.preventDefault(); const editor = editorRef.current; if (editor) resizeEditor(editor.getBoundingClientRect().bottom + (event.key === 'ArrowUp' ? -20 : 20)) } }} />
    <div className="sql-results" aria-live="polite">
      <div className="sql-results-heading">Results <div className="sql-result-actions"><span>{elapsedMs !== null ? `${elapsedMs} ms` : ''}</span><button className="sql-focus-button" type="button" aria-label={resultsFocused ? 'Restore editor' : 'Expand results'} title={resultsFocused ? 'Restore editor' : 'Expand results'} onClick={() => setResultsFocused((value) => !value)}>{resultsFocused ? '↙' : '↗'}</button></div></div>
      {copyMessage ? <div className="sql-message" role="status">{copyMessage}</div> : null}
      {error || execution?.error ? <div className="notice notice-error" role="alert">{error || execution?.error}</div> : null}
      {execution?.rolledBack ? <div className="sql-message">An open transaction was rolled back. Include COMMIT to save it.</div> : null}
      {execution?.results.map((result, index) => <div className="sql-result" key={index}>
        <div className="sql-result-meta"><strong>{result.command || `Result ${index + 1}`}</strong>{result.columns.length ? <div className="sql-result-actions"><span>{result.rows.length}{result.truncated ? '+' : ''} rows{result.truncated ? ' (first 500 shown)' : ''}</span><button className="sql-button" type="button" onClick={() => void copyResult(result)}>Copy CSV</button></div> : null}</div>
        {result.columns.length ? <div className="sql-table-wrap"><table><thead><tr>{result.columns.map((column, i) => <th key={i}>{column}</th>)}</tr></thead><tbody>{result.rows.map((row, i) => <tr key={i}>{row.map((value, j) => <td key={j}>{value === null ? <em>NULL</em> : value}</td>)}</tr>)}</tbody></table></div> : null}
      </div>)}
    </div>
  </section>
}
