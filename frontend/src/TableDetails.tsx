import { useEffect, useRef, useState } from 'react'
import { PostgresService } from './services'
import './feature-panels.css'

type Metadata = { constraints: { name: string; type: string; definition: string }[]; indexes: { name: string; definition: string }[]; ddl: string }

export default function TableDetails({ databaseId, schema, table, onScript }: { databaseId: string; schema: string; table: string; onScript: (sql: string, title: string) => void }) {
  const [metadata, setMetadata] = useState<Metadata | null>(null)
  const [error, setError] = useState('')
  const [generating, setGenerating] = useState(false)
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
  async function generate(kind: string) {
    setGenerating(true); setError('')
    try { const sql = await PostgresService.GenerateTableSQL(databaseId, schema, table, kind); if (mounted.current) onScriptRef.current(sql, `${table} · ${kind}`) }
    catch (cause) { if (mounted.current) setError(String(cause)) }
    finally { if (mounted.current) setGenerating(false) }
  }
  return <section className="table-details" aria-label="Table metadata">
    <div className="generated-sql-actions">{['SELECT', 'INSERT', 'UPDATE', 'DDL'].map((kind) => <button className="pagination-button" type="button" key={kind} disabled={generating} onClick={() => void generate(kind)}>Generate {kind}</button>)}</div>
    {error ? <div role="alert" className="notice notice-error">{error}</div> : null}
    {metadata ? <><h3>Constraints</h3>{metadata.constraints.length ? <table className="structure-table"><thead><tr><th>Name</th><th>Type</th><th>Definition</th></tr></thead><tbody>{metadata.constraints.map((item) => <tr key={item.name}><td>{item.name}</td><td>{item.type}</td><td><code>{item.definition}</code></td></tr>)}</tbody></table> : <span className="structure-empty">—</span>}
      <h3>Indexes</h3>{metadata.indexes.length ? <table className="structure-table"><tbody>{metadata.indexes.map((item) => <tr key={item.name}><td>{item.name}</td><td><code>{item.definition}</code></td></tr>)}</tbody></table> : <span className="structure-empty">—</span>}
      <details className="table-ddl"><summary>DDL</summary><pre>{metadata.ddl}</pre></details></> : !error ? <span role="status">Loading…</span> : null}
  </section>
}
