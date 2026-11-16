import { useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent, type MouseEvent } from 'react'
import { PostgresService } from './services'
import Button from './ui/Button'
import Icon from './Icon'
import './ConnectionTree.css'
import { createTtlCache } from './cache'
import ExportDatabaseDialog, { canExportToExcel } from './ExportDatabaseDialog'

// The tree re-renders whenever a branch expands or collapses; cache the
// listings so browsing does not hit the database again on every toggle.
const databasesCache = createTtlCache<string[]>()
const tablesCache = createTtlCache<TableInfo[]>()

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
  // Called after the user confirms deletion in the tree's own dialog.
  onDelete: (connection: ConnectionInfo) => void
  // Optional: number of open workspace tabs per connection id, shown in the delete confirmation.
  openTabCounts?: Record<string, number>
}

const TREEITEM = '[role="treeitem"]'

// Lets the owner move focus to a connection, e.g. right after connecting.
export function focusConnectionItem(id: string) {
  const item = document.querySelector<HTMLElement>(`.connection-tree [data-connection-id="${CSS.escape(id)}"]`)
  item?.focus()
  return !!item
}

export default function ConnectionTree(props: Props) {
  const [search, setSearch] = useState('')
  // `database` is set when the menu belongs to a database node rather than a connection.
  const [menu, setMenu] = useState<{ connection: ConnectionInfo; database?: string; x: number; y: number; open: () => void } | null>(null)
  const [exporting, setExporting] = useState<{ connection: ConnectionInfo; database: string } | null>(null)
  const [confirming, setConfirming] = useState<ConnectionInfo | null>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const menuOpener = useRef<HTMLElement | null>(null)
  const treeRef = useRef<HTMLDivElement>(null)
  const searchRef = useRef<HTMLInputElement>(null)
  const tabStop = useRef<HTMLElement | null>(null)
  const typeahead = useRef({ text: '', time: 0 })
  const deletedFocus = useRef<{ id: string; index: number } | null>(null)

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

  // Roving tabindex: exactly one tree item is in the Tab order. React renders
  // every item with tabIndex -1; the tab stop is maintained on the DOM here.
  const setTabStop = (item: HTMLElement | null) => {
    if (tabStop.current && tabStop.current !== item) tabStop.current.tabIndex = -1
    tabStop.current = item
    if (item) item.tabIndex = 0
  }
  const repairTabStop = () => {
    const tree = treeRef.current
    if (!tree) return
    if (tabStop.current && tree.contains(tabStop.current)) { tabStop.current.tabIndex = 0; return }
    setTabStop(tree.querySelector<HTMLElement>(`${TREEITEM}[aria-selected="true"]`)
      ?? tree.querySelector<HTMLElement>(`.connection-wrap.is-active > ${TREEITEM}`)
      ?? tree.querySelector<HTMLElement>(TREEITEM))
  }
  useLayoutEffect(repairTabStop)
  useEffect(() => {
    const tree = treeRef.current
    if (!tree) return
    const observer = new MutationObserver(repairTabStop)
    observer.observe(tree, { childList: true, subtree: true })
    return () => observer.disconnect()
  }, [])

  // After a confirmed delete, move focus to the next connection once it is gone.
  useEffect(() => {
    const pending = deletedFocus.current
    if (!pending || props.connections.some((connection) => connection.id === pending.id)) return
    deletedFocus.current = null
    const items = [...(treeRef.current?.querySelectorAll<HTMLElement>(`[aria-level="1"]${TREEITEM}`) ?? [])]
    const next = items[Math.min(pending.index, items.length - 1)]
    if (next) { setTabStop(next); next.focus() } else searchRef.current?.focus()
  }, [props.connections])

  const visibleItems = () => [...(treeRef.current?.querySelectorAll<HTMLElement>(TREEITEM) ?? [])]
  const focusItem = (item: HTMLElement | null | undefined) => {
    if (!item) return
    setTabStop(item)
    item.focus()
    item.scrollIntoView?.({ block: 'nearest' })
  }

  const treeKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const item = (event.target as HTMLElement).closest<HTMLElement>(TREEITEM)
    if (!item || event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey) return
    const items = visibleItems()
    const index = items.indexOf(item)
    const expanded = item.getAttribute('aria-expanded')
    const group = () => { const id = item.getAttribute('aria-owns'); return id ? document.getElementById(id) : null }
    const parent = () => {
      const owner = item.parentElement?.closest<HTMLElement>('[role="group"]')
      return owner ? treeRef.current?.querySelector<HTMLElement>(`[aria-owns="${CSS.escape(owner.id)}"]`) : null
    }
    if (event.key === 'ArrowDown') { event.preventDefault(); focusItem(items[index + 1]) }
    else if (event.key === 'ArrowUp') { event.preventDefault(); focusItem(items[index - 1]) }
    else if (event.key === 'Home') { event.preventDefault(); focusItem(items[0]) }
    else if (event.key === 'End') { event.preventDefault(); focusItem(items[items.length - 1]) }
    else if (event.key === 'ArrowRight') { event.preventDefault(); if (expanded === 'true') focusItem(group()?.querySelector<HTMLElement>(TREEITEM)) }
    else if (event.key === 'ArrowLeft') { event.preventDefault(); if (expanded !== 'true') focusItem(parent()) }
    else if (event.key.length === 1 && event.key !== ' ') {
      // Typeahead: jump to the next item whose name starts with the typed text.
      const now = Date.now()
      const text = (now - typeahead.current.time < 700 ? typeahead.current.text : '') + event.key.toLowerCase()
      typeahead.current = { text, time: now }
      const ordered = [...items.slice(index + (text.length === 1 ? 1 : 0)), ...items.slice(0, index + (text.length === 1 ? 1 : 0))]
      const match = ordered.find((candidate) => (candidate.dataset.label ?? '').toLowerCase().startsWith(text))
      if (match) { event.preventDefault(); focusItem(match) }
    }
  }

  const openMenu: BranchProps['onContextMenu'] = (connection, event, open, database) => {
    event.preventDefault()
    const item = (event.currentTarget as HTMLElement).matches(TREEITEM) ? event.currentTarget as HTMLElement : (event.currentTarget as HTMLElement).querySelector<HTMLElement>(TREEITEM)
    menuOpener.current = item
    const rect = item?.getBoundingClientRect()
    setMenu({ connection, database, open, x: 'clientX' in event ? event.clientX : rect?.left ?? 8, y: 'clientY' in event ? event.clientY : rect?.bottom ?? 8 })
  }

  const menuAction = (action: (connection: ConnectionInfo) => void) => {
    if (!menu) return
    setMenu(null)
    menuOpener.current?.focus()
    action(menu.connection)
  }

  const requestDelete = (connection: ConnectionInfo) => { setMenu(null); setConfirming(connection) }
  const confirmDelete = () => {
    const connection = confirming
    setConfirming(null)
    if (!connection) return
    deletedFocus.current = { id: connection.id, index: props.connections.findIndex((item) => item.id === connection.id) }
    props.onDelete(connection)
  }

  return <>
    <label className="sidebar-search">
      <Icon name="search" />
      <input ref={searchRef} value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Find a table" aria-label="Find a table" />
      {search ? <button type="button" className="sidebar-search-clear" aria-label="Clear table search" title="Clear search" onClick={() => { setSearch(''); searchRef.current?.focus() }}><Icon name="close" /></button> : null}
    </label>
    <nav className="connection-list" aria-label="Connections">
      <div className="connection-tree" role="tree" aria-label="Connections" ref={treeRef} onKeyDown={treeKeyDown} onFocus={(event) => {
        const item = (event.target as HTMLElement).closest<HTMLElement>(TREEITEM)
        if (item && treeRef.current?.contains(item)) setTabStop(item)
      }}>
        {props.connections.map((connection, index) => <ConnectionBranch
          key={`${connection.id}:${props.revisions[connection.id] ?? 0}`}
          {...props} connection={connection} position={index + 1} search={search.trim().toLowerCase()} onContextMenu={openMenu} onRequestDelete={requestDelete}
        />)}
      </div>
    </nav>
    {menu ? <div className="grid-context-menu connection-context-menu" role="menu" aria-label={`Actions for ${menu.database ?? menu.connection.name}`} ref={menuRef} style={{ left: menu.x, top: menu.y }} onKeyDown={(event) => {
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
      {menu.database !== undefined ? <>
        <div className="grid-menu-details" role="presentation">
          <div className="grid-menu-cell-heading"><strong title={menu.database}>{menu.database}</strong></div>
          <div className="grid-menu-cell-meta"><span title={menu.connection.name}>{menu.connection.name}</span>{menu.connection.host ? <span>{menu.connection.host}</span> : null}</div>
        </div>
        <button type="button" role="menuitem" onClick={() => menuAction(menu.open)}><Icon name="database" /><span>Open database</span></button>
        {canExportToExcel() ? <button type="button" role="menuitem" onClick={() => {
          const target = { connection: menu.connection, database: menu.database! }
          setMenu(null)
          setExporting(target)
        }}><Icon name="download" /><span>Export to Excel…</span></button> : null}
      </> : <>
      <div className="grid-menu-details" role="presentation">
        <div className="grid-menu-cell-heading"><strong title={menu.connection.name}>{menu.connection.name}</strong></div>
        <div className="grid-menu-cell-meta"><span title={menu.connection.host}>{menu.connection.host}</span>{menu.connection.username ? <span>{menu.connection.username}</span> : null}</div>
      </div>
      <button type="button" role="menuitem" onClick={() => menuAction(menu.open)}><Icon name="database" /><span>Open connection</span></button>
      <button type="button" role="menuitem" onClick={() => menuAction(props.onEdit)} aria-keyshortcuts="F2"><Icon name="edit" /><span>Edit connection</span></button>
      <hr />
      <button type="button" role="menuitem" className="danger-action" onClick={() => { const connection = menu.connection; setMenu(null); requestDelete(connection) }} aria-keyshortcuts="Delete"><Icon name="trash" /><span>Delete connection…</span></button>
      </>}
    </div> : null}
    {exporting ? <ExportDatabaseDialog connectionId={exporting.connection.id} connectionName={exporting.connection.name} database={exporting.database}
      returnFocus={menuOpener} onClose={() => setExporting(null)} /> : null}
    {confirming ? <DeleteConnectionDialog connection={confirming} openTabs={props.openTabCounts?.[confirming.id] ?? 0} returnFocus={menuOpener}
      onCancel={() => setConfirming(null)} onConfirm={confirmDelete} /> : null}
  </>
}

function DeleteConnectionDialog({ connection, openTabs, returnFocus, onCancel, onConfirm }: { connection: ConnectionInfo; openTabs: number; returnFocus: { current: HTMLElement | null }; onCancel: () => void; onConfirm: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null)
  const cancel = useRef<HTMLButtonElement>(null)
  const titleId = useId()
  const descriptionId = useId()
  useEffect(() => {
    const element = dialog.current
    if (!element) return
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null
    // A native modal dialog makes the rest of the app inert and traps focus.
    if (!element.open) element.showModal?.()
    cancel.current?.focus()
    return () => {
      if (element.open) element.close()
      const target = [opener, returnFocus.current].find((candidate) => candidate?.isConnected)
      target?.focus()
    }
  }, [returnFocus])
  return <dialog ref={dialog} className="connection-dialog confirm-dialog" role="alertdialog" aria-modal="true" aria-labelledby={titleId} aria-describedby={descriptionId}
    onCancel={(event) => { event.preventDefault(); onCancel() }}
    onClick={(event) => {
      // Clicks on the backdrop land on the dialog element outside its box.
      const box = event.currentTarget.getBoundingClientRect()
      if (event.target === event.currentTarget && (event.clientX < box.left || event.clientX > box.right || event.clientY < box.top || event.clientY > box.bottom)) onCancel()
    }}>
    <div className="dialog-heading"><h2 id={titleId}>Delete “{connection.name}”?</h2></div>
    <p id={descriptionId}>
      The saved connection to <strong>{connection.host || connection.database}</strong> is removed from this computer. The database itself is not changed.
      {openTabs ? ` ${openTabs} open ${openTabs === 1 ? 'tab uses' : 'tabs use'} this connection and will become unavailable.` : ''}
    </p>
    <div className="dialog-actions">
      <Button ref={cancel} type="button" size="lg" onClick={onCancel}>Cancel</Button>
      <Button type="button" size="lg" className="danger-button" onClick={onConfirm}><Icon name="trash" />Delete connection</Button>
    </div>
  </dialog>
}

type BranchProps = Props & {
  connection: ConnectionInfo
  position: number
  search: string
  onContextMenu: (connection: ConnectionInfo, event: MouseEvent<HTMLElement> | KeyboardEvent<HTMLElement>, open: () => void, database?: string) => void
  onRequestDelete: (connection: ConnectionInfo) => void
}

// Enter/Space activate; Right expands a closed node; Left collapses an open node.
// Moving between nodes is handled by the tree.
function nodeKeys(event: KeyboardEvent<HTMLElement>, { expanded, activate, toggle }: { expanded?: boolean; activate: () => void; toggle?: (open: boolean) => void }) {
  if (event.target !== event.currentTarget || event.altKey || event.ctrlKey || event.metaKey) return
  if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); activate() }
  else if (event.key === 'ArrowRight' && toggle && expanded === false) { event.preventDefault(); toggle(true) }
  else if (event.key === 'ArrowLeft' && toggle && expanded) { event.preventDefault(); toggle(false) }
}

function ConnectionBranch(props: BranchProps) {
  const { connection, selectedConnectionId, openingConnectionId, refreshKey } = props
  const active = selectedConnectionId === connection.id
  const [expanded, setExpanded] = useState(active)
  const [databases, setDatabases] = useState<string[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const groupId = useId()
  const labelId = useId()
  const hostId = useId()
  const open = () => { setExpanded(true); props.onSelectConnection(connection.id) }
  const activate = () => {
    setExpanded((value) => !value)
    if (!active) props.onSelectConnection(connection.id)
  }

  useEffect(() => { if (active) setExpanded(true) }, [active])
  useEffect(() => {
    if (!expanded) return
    let cancelled = false
    const cacheKey = `${connection.id}:${connection.showAllDatabases ? 1 : 0}:${refreshKey}`
    const cached = databasesCache.get(cacheKey)
    if (cached) {
      setDatabases(cached)
      setLoading(false)
      setError('')
      return
    }

    setLoading(true)
    setError('')
    PostgresService.ListDatabases(connection.id)
      .then((result) => {
        if (cancelled) return
        const items = result ?? []
        databasesCache.set(cacheKey, items)
        setDatabases(items)
      })
      .catch((reason: unknown) => { if (!cancelled) setError(message(reason, 'Could not load databases.')) })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [expanded, connection.id, connection.showAllDatabases, refreshKey])

  return <div className="connection-branch">
    <div className={`connection-wrap ${active ? 'is-active' : ''}`} onContextMenu={(event) => props.onContextMenu(connection, event, open)}>
      <div className="connection-item tree-node" role="treeitem" tabIndex={-1} data-connection-id={connection.id} data-label={connection.name}
        aria-level={1} aria-posinset={props.position} aria-setsize={props.connections.length} aria-expanded={expanded} aria-owns={expanded ? groupId : undefined}
        aria-labelledby={labelId} aria-describedby={hostId} aria-current={active ? 'true' : undefined} aria-busy={openingConnectionId === connection.id}
        onClick={activate} onKeyDown={(event) => {
          if (event.target !== event.currentTarget) return
          if (event.key === 'ContextMenu' || (event.key === 'F10' && event.shiftKey)) { props.onContextMenu(connection, event, open); return }
          if (event.key === 'Delete') { event.preventDefault(); props.onRequestDelete(connection); return }
          if (event.key === 'F2') { event.preventDefault(); props.onEdit(connection); return }
          nodeKeys(event, { expanded, activate, toggle: (next) => next ? open() : setExpanded(false) })
        }}>
        <Icon name="chevron-right" className={`tree-chevron ${expanded ? 'is-open' : ''}`} />
        <span className="connection-copy"><strong id={labelId} title={connection.name}>{connection.name}</strong><small id={hostId} title={connection.host}>{connection.host}</small></span>
        {openingConnectionId === connection.id ? <span className="tiny-spinner" /> : null}
      </div>
      <button className="connection-close connection-edit" type="button" tabIndex={-1} aria-label={`Edit ${connection.name}`} title="Edit connection (F2)" onClick={() => props.onEdit(connection)}>
        <Icon name="edit" />
      </button>
      <button className="connection-close" type="button" tabIndex={-1} aria-label={`Delete ${connection.name}`} title="Delete connection (Delete)" onClick={() => props.onRequestDelete(connection)}>
        <Icon name="trash" />
      </button>
    </div>
    {expanded ? <div className="connection-databases" id={groupId} role="group" aria-label={`Databases in ${connection.name}`}>
      {loading && databases.length === 0 ? <div className="sidebar-loading" role="status"><span className="tiny-spinner" />Loading databases</div> : null}
      {error ? <div className="sidebar-error" role="alert">{error}</div> : databases.map((database, index) => <DatabaseBranch key={database} {...props} database={database} position={index + 1} siblings={databases.length} />)}
      {!loading && !error && databases.length === 0 ? <div className="sidebar-empty-tables">No databases found</div> : null}
    </div> : null}
  </div>
}

function DatabaseBranch(props: BranchProps & { database: string; siblings: number }) {
  const { connection, database, selectedConnectionId, selectedDatabase, selectedTable, refreshKey, search } = props
  const active = selectedConnectionId === connection.id && selectedDatabase === database
  const [expanded, setExpanded] = useState(active)
  const [tables, setTables] = useState<TableInfo[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const groupId = useId()
  const labelId = useId()
  const activate = () => {
    setExpanded((value) => !value)
    if (!active) props.onSelectDatabase(connection, database)
  }
  const open = () => {
    setExpanded(true)
    if (!active) props.onSelectDatabase(connection, database)
  }

  useEffect(() => { if (active) setExpanded(true) }, [active])
  useEffect(() => {
    if (!expanded) return
    let cancelled = false
    const cacheKey = `${connection.id}:${database}:${refreshKey}`
    const cached = tablesCache.get(cacheKey)
    if (cached) {
      setTables(cached)
      setLoading(false)
      setError('')
      return
    }

    setLoading(true)
    setError('')
    PostgresService.OpenDatabase(connection.id, database)
      .then((handle) => cancelled ? null : PostgresService.ListTables(handle))
      .then((result) => {
        if (cancelled || result === null) return
        const items = result ?? []
        tablesCache.set(cacheKey, items)
        setTables(items)
      })
      .catch((reason: unknown) => { if (!cancelled) setError(message(reason, 'Could not load tables.')) })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [expanded, connection.id, database, refreshKey])

  const filtered = tables.filter((table) => !search || `${table.schema}.${table.name}`.toLowerCase().includes(search))
  const schemas = new Map<string, TableInfo[]>()
  for (const table of filtered) {
    const schemaTables = schemas.get(table.schema) ?? []
    schemaTables.push(table)
    schemas.set(table.schema, schemaTables)
  }
  const sortedSchemas = [...schemas].sort(([a], [b]) => a.localeCompare(b))
  return <div className="database-branch">
    <div className={`database-nav-item tree-node ${active ? 'is-active' : ''}`} role="treeitem" tabIndex={-1} data-label={database} title={database}
      aria-level={2} aria-posinset={props.position} aria-setsize={props.siblings} aria-expanded={expanded} aria-owns={expanded ? groupId : undefined}
      aria-labelledby={labelId} aria-current={active ? 'true' : undefined}
      onClick={activate} onContextMenu={(event) => props.onContextMenu(connection, event, open, database)} onKeyDown={(event) => {
        if (event.target === event.currentTarget && (event.key === 'ContextMenu' || (event.key === 'F10' && event.shiftKey))) { props.onContextMenu(connection, event, open, database); return }
        nodeKeys(event, { expanded, activate, toggle: setExpanded })
      }}>
      <Icon name="chevron-right" className={`tree-chevron ${expanded ? 'is-open' : ''}`} />
      <Icon name="database" className="tree-database-icon" />
      <span id={labelId} className="tree-label">{database}</span>
      {tables.length && expanded ? <small title={search ? `${filtered.length} of ${tables.length} tables match` : `${tables.length} tables`}>{search ? `${filtered.length}/${tables.length}` : tables.length}</small> : null}
    </div>
    {expanded ? <div className="database-schemas" id={groupId} role="group" aria-label={`Schemas in ${database}`}>
      {loading ? <div className="sidebar-loading" role="status"><span className="tiny-spinner" />Loading tables</div> : error ? <div className="sidebar-error" role="alert">{error}</div> : sortedSchemas.map(([schema, schemaTables], index) => <SchemaBranch
        key={schema} connection={connection} database={database} schema={schema} tables={schemaTables} position={index + 1} siblings={sortedSchemas.length}
        active={active} selectedTable={selectedTable} search={search} onSelectDatabase={props.onSelectDatabase}
      />)}
      {!loading && !error && !filtered.length ? <div className="sidebar-empty-tables">{search ? 'No matching tables' : 'No tables found'}</div> : null}
    </div> : null}
  </div>
}

function SchemaBranch({ connection, database, schema, tables, active, selectedTable, search, position, siblings, onSelectDatabase }: Pick<Props, 'selectedTable' | 'onSelectDatabase'> & {
  connection: ConnectionInfo; database: string; schema: string; tables: TableInfo[]; active: boolean; search: string; position: number; siblings: number
}) {
  const [expanded, setExpanded] = useState(true)
  const groupId = useId()
  const labelId = useId()
  const selectedSchema = active && selectedTable?.schema === schema
  const visible = expanded || !!search

  useEffect(() => { if (selectedSchema) setExpanded(true) }, [selectedSchema, selectedTable?.name])

  return <div className="schema-branch">
    <div className={`database-nav-item schema-nav-item tree-node ${selectedSchema ? 'is-active' : ''}`} role="treeitem" tabIndex={-1} data-label={schema} title={schema}
      aria-level={3} aria-posinset={position} aria-setsize={siblings} aria-expanded={visible} aria-owns={visible ? groupId : undefined} aria-labelledby={labelId}
      onClick={() => setExpanded(!visible)} onKeyDown={(event) => nodeKeys(event, { expanded: visible, activate: () => setExpanded(!visible), toggle: setExpanded })}>
      <Icon name="chevron-right" className={`tree-chevron ${visible ? 'is-open' : ''}`} />
      <Icon name="schema" className="schema-icon" />
      <span id={labelId} className="tree-label">{schema}</span><small>{tables.length}</small>
    </div>
    {visible ? <div className="schema-tables" id={groupId} role="group" aria-label={`Tables in ${schema} schema`}>
      {tables.map((table, index) => {
        const selected = selectedSchema && selectedTable?.name === table.name
        const open = () => { if (!selected) onSelectDatabase(connection, database, table) }
        return <div className={`table-nav-entry ${selected ? 'is-current is-selected' : ''}`} key={table.name}>
          <div className="table-nav-row">
            <div className="table-nav-item tree-node" role="treeitem" tabIndex={-1} data-label={table.name} aria-level={4} aria-posinset={index + 1} aria-setsize={tables.length}
              aria-selected={selected} aria-current={selected ? 'page' : undefined} title={`${schema}.${table.name}`}
              onClick={open} onKeyDown={(event) => nodeKeys(event, { activate: open })}>
              <span className="table-grid-icon" aria-hidden="true"><Icon name="table" /></span>
              <span className="tree-label">{table.name}</span>
            </div>
          </div>
        </div>
      })}
    </div> : null}
  </div>
}

function message(error: unknown, fallback: string) {
  return typeof error === 'string' ? error : error instanceof Error ? error.message : fallback
}
