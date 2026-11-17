import Button from './ui/Button'
import Icon from './Icon'
import { useEffect, useRef, useState } from 'react'
import { PostgresService } from './services'
import './feature-panels.css'

type Metadata = { constraints: { name: string; type: string; definition: string }[]; indexes: { name: string; definition: string }[]; ddl: string }

async function writeClipboard(text: string) {
  try { await navigator.clipboard.writeText(text); return true } catch {
    // Desktop webviews may not expose the async Clipboard API.
    const field = document.createElement('textarea')
    field.value = text; field.style.cssText = 'position:fixed;opacity:0;pointer-events:none'
    document.body.append(field); field.select()
    const copied = document.execCommand('copy'); field.remove()
    return copied
  }
}

export default function TableDetails({ databaseId, schema, table, onScript }: { databaseId: string; schema: string; table: string; onScript: (sql: string, title: string) => void }) {
  const [metadata, setMetadata] = useState<Metadata | null>(null)
  const [error, setError] = useState('')
  const [generating, setGenerating] = useState(false)
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'failed'>('idle')
  const mounted = useRef(true)
  const onScriptRef = useRef(onScript)
  onScriptRef.current = onScript
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  useEffect(() => {
    let cancelled = false
    setMetadata(null); setError('')
    Promise.resolve().then(() => PostgresService.GetTableMetadata(databaseId, schema, table)).then((result) => { if (!cancelled) setMetadata({ ...result, constraints: result.constraints ?? [], indexes: result.indexes ?? [] }) }).catch((cause) => { if (!cancelled) setError(String(cause)) })
    return () => { cancelled = true }
  }, [databaseId, schema, table])
  useEffect(() => {
    if (copyState === 'idle') return
    const timer = window.setTimeout(() => setCopyState('idle'), 2500)
    return () => window.clearTimeout(timer)
  }, [copyState])
  async function generate(kind: string) {
    setGenerating(true); setError('')
    try { const sql = await PostgresService.GenerateTableSQL(databaseId, schema, table, kind); if (mounted.current) onScriptRef.current(sql, `${table} · ${kind}`) }
    catch (cause) { if (mounted.current) setError(String(cause)) }
    finally { if (mounted.current) setGenerating(false) }
  }
  async function copyDDL() {
    if (!metadata) return
    const copied = await writeClipboard(metadata.ddl)
    if (mounted.current) setCopyState(copied ? 'copied' : 'failed')
  }
  return <section className="table-details" aria-label="Table metadata">
    <div className="generated-sql-actions">{['SELECT', 'INSERT', 'UPDATE', 'DDL'].map((kind) => <Button type="button" key={kind} disabled={generating} title={`Open a ${kind} statement for ${schema}.${table} in a new script tab`} onClick={() => void generate(kind)}>Generate {kind}</Button>)}</div>
    {error ? <div role="alert" className="notice notice-error">{error}</div> : null}
    {metadata ? <>
      <div className="table-details-heading"><h3>Constraints</h3><span>{metadata.constraints.length}</span></div>
      {metadata.constraints.length ? <div className="structure-table-wrap"><table className="structure-table" aria-label="Constraints"><thead><tr><th scope="col">Name</th><th scope="col">Type</th><th scope="col">Definition</th></tr></thead><tbody>{metadata.constraints.map((item) => <tr key={item.name}><td>{item.name}</td><td>{item.type}</td><td><code>{item.definition}</code></td></tr>)}</tbody></table></div> : <span className="structure-empty">No constraints</span>}
      <div className="table-details-heading"><h3>Indexes</h3><span>{metadata.indexes.length}</span></div>
      {metadata.indexes.length ? <div className="structure-table-wrap"><table className="structure-table" aria-label="Indexes"><thead><tr><th scope="col">Name</th><th scope="col">Definition</th></tr></thead><tbody>{metadata.indexes.map((item) => <tr key={item.name}><td>{item.name}</td><td><code>{item.definition}</code></td></tr>)}</tbody></table></div> : <span className="structure-empty">No indexes</span>}
      <details className="table-ddl"><summary><Icon name="chevron-right" />DDL</summary>
        <div className="table-ddl-body">
          <pre aria-label={`DDL for ${schema}.${table}`}>{metadata.ddl}</pre>
          <Button size="sm" type="button" className={`table-ddl-copy${copyState === 'copied' ? ' is-copied' : ''}`} onClick={() => void copyDDL()} title="Copy DDL to the clipboard"><Icon name={copyState === 'copied' ? 'check' : 'copy'} />{copyState === 'copied' ? 'Copied' : 'Copy'}</Button>
          <span className="visually-hidden" role="status" aria-live="polite">{copyState === 'copied' ? 'DDL copied to the clipboard.' : copyState === 'failed' ? 'Could not copy the DDL. Select the text and copy it manually.' : ''}</span>
        </div>
      </details></> : !error ? <span role="status">Loading…</span> : null}
  </section>
}
