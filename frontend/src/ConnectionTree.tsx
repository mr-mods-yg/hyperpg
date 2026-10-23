import { useEffect, useId, useRef, useState, type KeyboardEvent, type MouseEvent } from 'react'
import { PostgresService } from '../bindings/changeme'

export type ConnectionInfo = {
  id: string
  name: string
  host: string
  database: string
  username: string
  showAllDatabases: boolean
}
export type TableInfo = { schema: string; name: string }

type Props = {
  connections: ConnectionInfo[]
  selectedConnectionId: string
  selectedDatabase: string
  selectedTable: TableInfo | null
  openingConnectionId: string
  refreshKey: number
  revisions: Record<string, number>
  onSelectConnection: (id: string) => void
  onSelectDatabase: (connection: ConnectionInfo, database: string, table?: TableInfo) => void
  onEdit: (connection: ConnectionInfo) => void
  onDelete: (connection: ConnectionInfo) => void
}

export default function ConnectionTree(props: Props) {
  const [search, setSearch] = useState('')
  const [menu, setMenu] = useState<{ connection: ConnectionInfo; x: number; y: number; open: () => void } | null>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const menuOpener = useRef<HTMLButtonElement | null>(null)

  useEffect(() => {
    if (!menu || !menuRef.current) return
    const element = menuRef.current
    const rect = element.getBoundingClientRect()
    element.style.left = `${Math.max(8, Math.min(menu.x, window.innerWidth - rect.width - 8))}px`
    element.style.top = `${Math.max(8, Math.min(menu.y, window.innerHeight - rect.height - 8))}px`
    element.querySelector<HTMLButtonElement>('button')?.focus()
    const close = (event: Event) => {
      if (!element.contains(event.target as Node)) setMenu(null)
    }
    window.addEventListener('pointerdown', close)
    window.addEventListener('resize', close)
    window.addEventListener('scroll', close, true)
    return () => {
      window.removeEventListener('pointerdown', close)
      window.removeEventListener('resize', close)
      window.removeEventListener('scroll', close, true)
    }
  }, [menu])

  const openMenu: BranchProps['onContextMenu'] = (connection, event, open) => {
    event.preventDefault()
    const button = event.currentTarget instanceof HTMLButtonElement ? event.currentTarget : event.currentTarget.querySelector<HTMLButtonElement>('.connection-item')
    menuOpener.current = button
    const rect = button?.getBoundingClientRect()
    setMenu({ connection, open, x: 'clientX' in event ? event.clientX : rect?.left ?? 8, y: 'clientY' in event ? event.clientY : rect?.bottom ?? 8 })
  }

  const menuAction = (action: (connection: ConnectionInfo) => void) => {
    if (!menu) return
    setMenu(null)
    menuOpener.current?.focus()
    action(menu.connection)
  }

  return <>
    <label className="sidebar-search">
      <svg viewBox="0 0 18 18" fill="none" aria-hidden="true"><circle cx="8" cy="8" r="5.4" /><path d="m12 12 3.2 3.2" /></svg>
      <input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Find a table" aria-label="Find a table" />
    </label>
    <nav className="connection-list" aria-label="Connections">
      {props.connections.map((connection) => <ConnectionBranch
        key={`${connection.id}:${props.revisions[connection.id] ?? 0}`}
        {...props} connection={connection} search={search.trim().toLowerCase()} onContextMenu={openMenu}
      />)}
    </nav>
    {menu ? <div className="grid-context-menu connection-context-menu" role="menu" aria-label={`Actions for ${menu.connection.name}`} ref={menuRef} style={{ left: menu.x, top: menu.y }} onKeyDown={(event) => {
      if (event.key === 'Escape') { event.preventDefault(); setMenu(null); menuOpener.current?.focus() }
      else if (event.key === 'Tab') { setMenu(null); menuOpener.current?.focus() }
      else if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
        event.preventDefault()
        const buttons = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('button')]
        const index = buttons.indexOf(document.activeElement as HTMLButtonElement)
        const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : (index + (event.key === 'ArrowDown' ? 1 : buttons.length - 1)) % buttons.length
        buttons[next]?.focus()
      }
    }}>
      <button type="button" role="menuitem" onClick={() => menuAction(menu.open)}>Open connection</button>
      <button type="button" role="menuitem" onClick={() => menuAction(props.onEdit)}>Edit connection</button>
      <hr />
      <button type="button" role="menuitem" className="danger-action" onClick={() => menuAction(props.onDelete)}>Delete connection</button>
    </div> : null}
  </>
}

type BranchProps = Props & {
  connection: ConnectionInfo
  search: string
  onContextMenu: (connection: ConnectionInfo, event: MouseEvent<HTMLElement> | KeyboardEvent<HTMLButtonElement>, open: () => void) => void
}

function ConnectionBranch(props: BranchProps) {
  const { connection, selectedConnectionId, openingConnectionId, refreshKey } = props
  const active = selectedConnectionId === connection.id
  const [expanded, setExpanded] = useState(active)
  const [databases, setDatabases] = useState<string[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const groupId = useId()
  const open = () => { setExpanded(true); props.onSelectConnection(connection.id) }

  useEffect(() => { if (active) setExpanded(true) }, [active])
  useEffect(() => {
    if (!expanded) return
    let cancelled = false
    setLoading(true)
    setError('')
    PostgresService.ListDatabases(connection.id)
      .then((result) => { if (!cancelled) setDatabases(result ?? []) })
      .catch((reason: unknown) => { if (!cancelled) setError(message(reason, 'Could not load databases.')) })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [expanded, connection.id, connection.showAllDatabases, refreshKey])

  return <div className="connection-branch">
    <div className={`connection-wrap ${active ? 'is-active' : ''}`} onContextMenu={(event) => props.onContextMenu(connection, event, open)}>
      <button className="connection-item" type="button" aria-label={`Select ${connection.name}`} aria-expanded={expanded} aria-controls={groupId} aria-busy={openingConnectionId === connection.id} onClick={() => {
        setExpanded((value) => !value)
        if (!active) props.onSelectConnection(connection.id)
      }} onKeyDown={(event) => {
        if (event.key === 'ContextMenu' || event.key === 'F10' && event.shiftKey) props.onContextMenu(connection, event, open)
      }}>
        <Chevron expanded={expanded} />
        <span className="connection-copy"><strong>{connection.name}</strong><small>{connection.host}</small></span>
        {openingConnectionId === connection.id ? <span className="tiny-spinner" /> : null}
      </button>
      <button className="connection-close connection-edit" type="button" aria-label={`Edit ${connection.name}`} title="Edit connection" onClick={() => props.onEdit(connection)}>
        <svg viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="m10.5 2.5 3 3M3 10l7.8-7.8a1.4 1.4 0 0 1 2 2L5 12l-3 1z" /></svg>
      </button>
      <button className="connection-close" type="button" aria-label={`Remove ${connection.name}`} title="Delete connection" onClick={() => props.onDelete(connection)}>
        <svg viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M3 4h10M6 4V2h4v2M4 4l.6 9h6.8l.6-9M6.5 6.5v4M9.5 6.5v4" /></svg>
      </button>
    </div>
    {expanded ? <div className="connection-databases" id={groupId} role="group" aria-label={`Databases in ${connection.name}`}>
      {loading && databases.length === 0 ? <div className="sidebar-loading"><span className="tiny-spinner" />Loading databases</div> : null}
      {error ? <div className="sidebar-error" role="alert">{error}</div> : databases.map((database) => <DatabaseBranch key={database} {...props} database={database} />)}
      {!loading && !error && databases.length === 0 ? <div className="sidebar-empty-tables">No databases found</div> : null}
    </div> : null}
  </div>
}

function DatabaseBranch(props: BranchProps & { database: string }) {
  const { connection, database, selectedConnectionId, selectedDatabase, selectedTable, refreshKey, search } = props
  const active = selectedConnectionId === connection.id && selectedDatabase === database
  const [expanded, setExpanded] = useState(active)
  const [tables, setTables] = useState<TableInfo[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const groupId = useId()

  useEffect(() => { if (active) setExpanded(true) }, [active])
  useEffect(() => {
    if (!expanded) return
    let cancelled = false
    setLoading(true)
    setError('')
    PostgresService.OpenDatabase(connection.id, database)
      .then((handle) => cancelled ? null : PostgresService.ListTables(handle))
      .then((result) => { if (!cancelled) setTables(result ?? []) })
      .catch((reason: unknown) => { if (!cancelled) setError(message(reason, 'Could not load tables.')) })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [expanded, connection.id, database, refreshKey])

  const filtered = tables.filter((table) => !search || `${table.schema}.${table.name}`.toLowerCase().includes(search))
  return <div className="database-branch">
    <button className={`database-nav-item ${active ? 'is-active' : ''}`} type="button" aria-label={`Open ${database} database`} aria-expanded={expanded} aria-controls={groupId} onClick={() => {
      setExpanded((value) => !value)
      if (!active) props.onSelectDatabase(connection, database)
    }}>
      <Chevron expanded={expanded} />
      <svg className="tree-database-icon" viewBox="0 0 18 18" fill="none" aria-hidden="true"><ellipse cx="9" cy="4" rx="5.5" ry="2.5" /><path d="M3.5 4v9c0 1.4 2.5 2.5 5.5 2.5s5.5-1.1 5.5-2.5V4M3.5 8.5C3.5 9.9 6 11 9 11s5.5-1.1 5.5-2.5" /></svg>
      <span>{database}</span>
      {tables.length && expanded ? <small>{tables.length}</small> : null}
    </button>
    {expanded ? <div className="database-tables" id={groupId} role="group" aria-label={`Tables in ${database}`}>
      {loading ? <div className="sidebar-loading"><span className="tiny-spinner" />Loading tables</div> : error ? <div className="sidebar-error" role="alert">{error}</div> : filtered.map((table) => {
        const selected = active && selectedTable?.schema === table.schema && selectedTable.name === table.name
        return <div className={`table-nav-entry ${selected ? 'is-current' : ''}`} key={`${table.schema}.${table.name}`}>
          <div className="table-nav-row">
            <button className="table-nav-item" type="button" aria-current={selected ? 'page' : undefined} aria-label={`Open ${table.name} table`} title={`${table.schema}.${table.name}`} onClick={() => { if (!selected) props.onSelectDatabase(connection, database, table) }}>
              <span className="table-grid-icon" aria-hidden="true"><svg viewBox="0 0 16 16" fill="none"><rect x="2.5" y="3" width="11" height="10" rx="1.5" /><path d="M2.5 6.5h11M6.2 6.5V13" /></svg></span>
              <span>{table.name}</span><small className="table-schema">{table.schema}</small>
            </button>
          </div>
        </div>
      })}
      {!loading && !error && !filtered.length ? <div className="sidebar-empty-tables">{search ? 'No matching tables' : 'No tables found'}</div> : null}
    </div> : null}
  </div>
}

function Chevron({ expanded }: { expanded: boolean }) {
  return <svg className={`tree-chevron ${expanded ? 'is-open' : ''}`} viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="m5.5 3.5 5 4.5-5 4.5" /></svg>
}

function message(error: unknown, fallback: string) {
  return typeof error === 'string' ? error : error instanceof Error ? error.message : fallback
}
