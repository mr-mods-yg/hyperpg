import { useEffect, useMemo, useState, type CSSProperties, type FormEvent, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent } from 'react'
import { PostgresService } from '../bindings/changeme'

type ConnectionInfo = {
  id: string
  name: string
  host: string
  database: string
  username: string
}

type TableInfo = { schema: string; name: string }
type ColumnInfo = { name: string; dataType: string }
type TableData = { columns: ColumnInfo[]; rows: unknown[][]; rowCount: number }
type View = 'data' | 'structure'
type Theme = 'light' | 'dark'

const SIDEBAR_MIN_WIDTH = 190
const SIDEBAR_MAX_WIDTH = 420
const DEFAULT_SIDEBAR_WIDTH = 246

function App() {
  const [connections, setConnections] = useState<ConnectionInfo[]>([])
  const [selectedConnectionId, setSelectedConnectionId] = useState('')
  const [tables, setTables] = useState<TableInfo[]>([])
  const [selectedTable, setSelectedTable] = useState<TableInfo | null>(null)
  const [tableData, setTableData] = useState<TableData | null>(null)
  const [tablesLoading, setTablesLoading] = useState(false)
  const [tableLoading, setTableLoading] = useState(false)
  const [tablesError, setTablesError] = useState('')
  const [tableError, setTableError] = useState('')
  const [savedConnectionsError, setSavedConnectionsError] = useState('')
  const [openingConnectionId, setOpeningConnectionId] = useState('')
  const [refreshKey, setRefreshKey] = useState(0)
  const [pageSize, setPageSize] = useState(100)
  const [pageOffset, setPageOffset] = useState(0)
  const [connectionError, setConnectionError] = useState('')
  const [showConnectionDialog, setShowConnectionDialog] = useState(false)
  const [connectionUrl, setConnectionUrl] = useState('')
  const [connectionName, setConnectionName] = useState('')
  const [showUrl, setShowUrl] = useState(false)
  const [connecting, setConnecting] = useState(false)
  const [view, setView] = useState<View>('data')
  const [tableSearch, setTableSearch] = useState('')
  const [rowSearch, setRowSearch] = useState('')
  const [mobileNavOpen, setMobileNavOpen] = useState(false)
  const [sidebarWidth, setSidebarWidth] = useState(() => {
    try {
      const savedWidth = Number(localStorage.getItem('hyperpg-sidebar-width'))
      return savedWidth >= SIDEBAR_MIN_WIDTH && savedWidth <= SIDEBAR_MAX_WIDTH ? savedWidth : DEFAULT_SIDEBAR_WIDTH
    } catch {
      return DEFAULT_SIDEBAR_WIDTH
    }
  })
  const [resizingSidebar, setResizingSidebar] = useState(false)
  const [showSettingsDialog, setShowSettingsDialog] = useState(false)
  const [theme, setTheme] = useState<Theme>(() => {
    try {
      return localStorage.getItem('hyperpg-theme') === 'dark' ? 'dark' : 'light'
    } catch {
      return 'light'
    }
  })
  const [collapsedSchemas, setCollapsedSchemas] = useState<Record<string, boolean>>({})
  const [expandedTableKey, setExpandedTableKey] = useState('')

  const activeConnection = connections.find((connection) => connection.id === selectedConnectionId) ?? null

  useEffect(() => {
    let cancelled = false
    const restoreSavedConnections = async () => {
      try {
        const saved = await PostgresService.ListSavedConnections()
        if (cancelled) return
        const items = saved ?? []
        setConnections(items)
        if (items.length === 0) return

        setOpeningConnectionId(items[0].id)
        await PostgresService.OpenSavedConnection(items[0].id)
        if (!cancelled) setSelectedConnectionId(items[0].id)
      } catch (error) {
        if (!cancelled) setSavedConnectionsError(errorMessage(error, 'Could not open the saved connection.'))
      } finally {
        if (!cancelled) setOpeningConnectionId('')
      }
    }
    void restoreSavedConnections()
    return () => { cancelled = true }
  }, [])

  useEffect(() => {
    document.documentElement.dataset.theme = theme
    try {
      localStorage.setItem('hyperpg-theme', theme)
    } catch {
      // Theme remains active for this session if local storage is unavailable.
    }
  }, [theme])

  useEffect(() => {
    try {
      localStorage.setItem('hyperpg-sidebar-width', String(sidebarWidth))
    } catch {
      // The current width remains active if local storage is unavailable.
    }
  }, [sidebarWidth])

  const handleSidebarPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return
    event.preventDefault()
    event.currentTarget.setPointerCapture(event.pointerId)
    setResizingSidebar(true)
  }

  const handleSidebarPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!resizingSidebar) return
    setSidebarWidth(Math.min(SIDEBAR_MAX_WIDTH, Math.max(SIDEBAR_MIN_WIDTH, event.clientX)))
  }

  const handleSidebarPointerUp = () => setResizingSidebar(false)

  const handleSidebarResizeKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
      event.preventDefault()
      const direction = event.key === 'ArrowLeft' ? -1 : 1
      setSidebarWidth((width) => Math.min(SIDEBAR_MAX_WIDTH, Math.max(SIDEBAR_MIN_WIDTH, width + direction * 16)))
    } else if (event.key === 'Home' || event.key === 'End') {
      event.preventDefault()
      setSidebarWidth(event.key === 'Home' ? SIDEBAR_MIN_WIDTH : SIDEBAR_MAX_WIDTH)
    }
  }

  useEffect(() => {
    if (!showConnectionDialog && !showSettingsDialog) return
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      if (showSettingsDialog) setShowSettingsDialog(false)
      else if (!connecting) setShowConnectionDialog(false)
    }
    window.addEventListener('keydown', closeOnEscape)
    return () => window.removeEventListener('keydown', closeOnEscape)
  }, [showConnectionDialog, showSettingsDialog, connecting])

  const filteredTables = useMemo(() => {
    const query = tableSearch.trim().toLowerCase()
    if (!query) return tables
    return tables.filter((table) => `${table.schema}.${table.name}`.toLowerCase().includes(query))
  }, [tables, tableSearch])

  const filteredRows = useMemo(() => {
    if (!tableData) return []
    const query = rowSearch.trim().toLowerCase()
    return tableData.rows
      .map((row, index) => ({ row, index }))
      .filter(({ row }) => !query || row.some((value) => formatValue(value).toLowerCase().includes(query)))
  }, [tableData, rowSearch])

  const pageStart = tableData?.rows.length ? pageOffset + 1 : 0
  const pageEnd = tableData ? Math.min(pageOffset + tableData.rows.length, tableData.rowCount) : 0

  useEffect(() => {
    if (!selectedConnectionId) {
      setTables([])
      setSelectedTable(null)
      setTableData(null)
      return
    }

    let cancelled = false
    setTablesLoading(true)
    setTables([])
    setTablesError('')
    PostgresService.ListTables(selectedConnectionId)
      .then((result) => {
        if (!cancelled) setTables(result ?? [])
      })
      .catch((error: unknown) => {
        if (!cancelled) setTablesError(errorMessage(error, 'Could not load tables.'))
      })
      .finally(() => {
        if (!cancelled) setTablesLoading(false)
      })

    return () => { cancelled = true }
  }, [selectedConnectionId, refreshKey])

  useEffect(() => {
    if (!selectedConnectionId || !selectedTable) {
      setTableData(null)
      setTableLoading(false)
      return
    }

    let cancelled = false
    setTableLoading(true)
    setTableData(null)
    setTableError('')
    PostgresService.GetTableData(selectedConnectionId, selectedTable.schema, selectedTable.name, pageSize, pageOffset)
      .then((result) => {
        if (!cancelled) {
          setTableData({
            columns: result.columns ?? [],
            rows: (result.rows ?? []).map((row) => row ?? []),
            rowCount: result.rowCount ?? 0,
          })
        }
      })
      .catch((error: unknown) => {
        if (!cancelled) setTableError(errorMessage(error, 'Could not load this table.'))
      })
      .finally(() => {
        if (!cancelled) setTableLoading(false)
      })

    return () => { cancelled = true }
  }, [selectedConnectionId, selectedTable?.schema, selectedTable?.name, pageSize, pageOffset, refreshKey])

  const openConnectionDialog = () => {
    setConnectionError('')
    setConnectionUrl('')
    setConnectionName('')
    setShowUrl(false)
    setShowConnectionDialog(true)
  }

  const handleConnect = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    setConnecting(true)
    setConnectionError('')
    try {
      const connection = await PostgresService.Connect(connectionUrl.trim(), connectionName.trim()) as ConnectionInfo
      setConnections((current) => [connection, ...current])
      setSelectedConnectionId(connection.id)
      setSelectedTable(null)
      setPageOffset(0)
      setRowSearch('')
      setView('data')
      setShowConnectionDialog(false)
      setMobileNavOpen(false)
      setConnectionUrl('')
      setSavedConnectionsError('')
    } catch (error) {
      setConnectionError(errorMessage(error, 'Could not connect. Check the URL and try again.'))
    } finally {
      setConnecting(false)
    }
  }

  const selectConnection = async (connectionId: string) => {
    setOpeningConnectionId(connectionId)
    setSavedConnectionsError('')
    try {
      await PostgresService.OpenSavedConnection(connectionId)
      setSelectedConnectionId(connectionId)
      setSelectedTable(null)
      setTableData(null)
      setPageOffset(0)
      setCollapsedSchemas({})
      setExpandedTableKey('')
      setView('data')
      setMobileNavOpen(false)
    } catch (error) {
      setSavedConnectionsError(errorMessage(error, 'Could not open this connection.'))
    } finally {
      setOpeningConnectionId('')
    }
  }

  const removeConnection = async (connection: ConnectionInfo) => {
    try {
      await PostgresService.DeleteSavedConnection(connection.id)
    } catch (error) {
      setSavedConnectionsError(errorMessage(error, 'Could not remove this connection.'))
      return
    }
    const remaining = connections.filter((item) => item.id !== connection.id)
    setConnections(remaining)
    if (selectedConnectionId === connection.id) {
      setSelectedConnectionId('')
      setSelectedTable(null)
      setPageOffset(0)
      setRowSearch('')
      setCollapsedSchemas({})
      setExpandedTableKey('')
      if (remaining[0]) void selectConnection(remaining[0].id)
    }
  }

  const selectTable = (table: TableInfo) => {
    setSelectedTable(table)
    setPageOffset(0)
    setRowSearch('')
    setExpandedTableKey(`${table.schema}.${table.name}`)
    setCollapsedSchemas((current) => current[table.schema] ? { ...current, [table.schema]: false } : current)
    setView('data')
    setMobileNavOpen(false)
  }

  const toggleSchema = (schema: string) => {
    setCollapsedSchemas((current) => ({ ...current, [schema]: !current[schema] }))
  }

  const toggleTable = (table: TableInfo) => {
    const key = `${table.schema}.${table.name}`
    if (expandedTableKey === key) {
      setExpandedTableKey('')
      return
    }
    if (selectedTable?.schema !== table.schema || selectedTable.name !== table.name) {
      selectTable(table)
    } else {
      setExpandedTableKey(key)
    }
  }

  const groupedTables = useMemo(() => {
    return filteredTables.reduce<Record<string, TableInfo[]>>((groups, table) => {
      ;(groups[table.schema] ??= []).push(table)
      return groups
    }, {})
  }, [filteredTables])

  return (
    <div className={`app-shell ${resizingSidebar ? 'is-resizing-sidebar' : ''}`} style={{ '--sidebar-width': `${sidebarWidth}px` } as CSSProperties}>
      <aside className={`sidebar ${mobileNavOpen ? 'is-mobile-open' : ''}`} id="database-sidebar">
        <div className="brand-row">
          <div className="brand-mark" aria-hidden="true">
            <svg viewBox="0 0 24 24" fill="none"><path d="M5 5.5h14v4H5zM5 14.5h6v4H5zM14 14.5h5v4h-5z" fill="currentColor" /></svg>
          </div>
          <span className="brand-name">hyperpg</span>
        </div>

        <div className="sidebar-section-heading">
          <span>Connections</span>
          <button className="icon-button add-connection" type="button" onClick={openConnectionDialog} aria-label="Add a database connection" title="Add connection">
            <svg viewBox="0 0 20 20" fill="none" aria-hidden="true"><path d="M10 4v12M4 10h12" /></svg>
          </button>
        </div>

        {connections.length === 0 ? (
          <button className="sidebar-empty" type="button" onClick={openConnectionDialog}>
            <span className="empty-symbol">＋</span>
            <span>Add a database</span>
          </button>
        ) : (
          <div className="connection-list">
            {connections.map((connection) => (
              <div className={`connection-wrap ${selectedConnectionId === connection.id ? 'is-active' : ''}`} key={connection.id}>
                <button className="connection-item" type="button" aria-label={`Select ${connection.name}`} aria-busy={openingConnectionId === connection.id} onClick={() => void selectConnection(connection.id)}>
                  <span className="database-glyph" aria-hidden="true">{openingConnectionId === connection.id ? <span className="tiny-spinner" /> : <DatabaseIcon />}</span>
                  <span className="connection-copy"><strong>{connection.name}</strong><small>{connection.host}</small></span>
                </button>
                <button className="connection-close" type="button" aria-label={`Remove ${connection.name}`} title="Remove connection" onClick={() => void removeConnection(connection)}>
                  <svg viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="m4 4 8 8M12 4l-8 8" /></svg>
                </button>
              </div>
            ))}
          </div>
        )}

        {activeConnection && (
          <div className="tables-nav">
            <div className="sidebar-section-heading table-heading">
              <span>Tables</span>
              <span className="table-count">{tablesLoading ? '…' : tables.length}</span>
            </div>
            <label className="sidebar-search">
              <svg viewBox="0 0 18 18" fill="none" aria-hidden="true"><circle cx="8" cy="8" r="5.4" /><path d="m12 12 3.2 3.2" /></svg>
              <input value={tableSearch} onChange={(event) => setTableSearch(event.target.value)} placeholder="Find a table" aria-label="Find a table" />
            </label>
            <div className="schema-list">
              {tablesLoading ? <div className="sidebar-loading"><span className="tiny-spinner" />Loading tables</div> : null}
              {!tablesLoading && tablesError ? <div className="sidebar-error">{tablesError}</div> : null}
              {!tablesLoading && !tablesError && tables.length === 0 ? <div className="sidebar-empty-tables">No tables found</div> : null}
              {!tablesLoading && Object.entries(groupedTables).map(([schema, schemaTables]) => (
                <div className="schema-group" key={schema}>
                  <button className="schema-label" type="button" aria-expanded={!collapsedSchemas[schema]} onClick={() => toggleSchema(schema)}>
                    <svg className={`tree-chevron ${collapsedSchemas[schema] ? '' : 'is-open'}`} viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="m5.5 3.5 5 4.5-5 4.5" /></svg>
                    <svg className="schema-icon" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="m3 6 5-3 5 3v6l-5 3-5-3zM3 6l5 3 5-3M8 9v6" /></svg>{schema}
                  </button>
                  {!collapsedSchemas[schema] ? schemaTables.map((table) => {
                    const tableKey = `${table.schema}.${table.name}`
                    const isSelected = selectedTable?.schema === table.schema && selectedTable.name === table.name
                    const isExpanded = expandedTableKey === tableKey
                    return <div className={`table-nav-entry ${isSelected ? 'is-current' : ''}`} key={tableKey}>
                      <div className="table-nav-row">
                        <button className="table-nav-item" type="button" aria-current={isSelected ? 'page' : undefined} aria-label={isSelected ? `${isExpanded ? 'Collapse' : 'Expand'} columns for ${table.name}` : `Open ${table.name} table`} onClick={() => isSelected ? setExpandedTableKey((current) => current === tableKey ? '' : tableKey) : selectTable(table)}>
                          <span className="table-grid-icon" aria-hidden="true"><svg viewBox="0 0 16 16" fill="none"><rect x="2.5" y="3" width="11" height="10" rx="1.5" /><path d="M2.5 6.5h11M6.2 6.5V13" /></svg></span>
                          <span>{table.name}</span>
                        </button>
                        <button className={`table-disclosure ${isExpanded ? 'is-open' : ''}`} type="button" aria-label={`${isExpanded ? 'Collapse' : 'Expand'} ${table.name}`} aria-expanded={isExpanded} onClick={() => toggleTable(table)}>
                          <svg viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="m5.5 3.5 5 4.5-5 4.5" /></svg>
                        </button>
                      </div>
                      {isExpanded ? <div className="table-columns">
                        {isSelected && tableData ? tableData.columns.map((column) => <div className="table-column-item" key={column.name} title={`${column.name} · ${column.dataType}`}><span>{column.name}</span><small>{column.dataType}</small></div>) : isSelected && tableLoading ? <div className="table-column-placeholder"><span className="tiny-spinner" />Loading columns</div> : <div className="table-column-placeholder">Select to load columns</div>}
                      </div> : null}
                    </div>
                  }) : null}
                </div>
              ))}
            </div>
          </div>
        )}

        <div className="sidebar-bottom">
          <button className="settings-button" type="button" onClick={() => setShowSettingsDialog(true)}>
            <svg viewBox="0 0 18 18" fill="none" aria-hidden="true"><circle cx="9" cy="9" r="2.5" /><path d="m7.5 2.4.5-1h2l.5 1.6a6.6 6.6 0 0 1 1.4.8l1.6-.4 1 1.8-1.1 1.3c.2.6.3 1.2.3 1.8l1.1 1.3-1 1.8-1.6-.4c-.4.3-.9.6-1.4.8l-.5 1.6H8l-.5-1.6a6.6 6.6 0 0 1-1.4-.8l-1.6.4-1-1.8 1.1-1.3a5.5 5.5 0 0 1 0-1.8L3.5 5.2l1-1.8 1.6.4c.4-.3.9-.6 1.4-.8L8 1.4" transform="translate(0 1)" /></svg>
            <span>Settings</span>
          </button>
        </div>
      </aside>
      <div
        className="sidebar-resize-handle"
        role="separator"
        aria-label="Resize sidebar"
        aria-controls="database-sidebar"
        aria-orientation="vertical"
        aria-valuemin={SIDEBAR_MIN_WIDTH}
        aria-valuemax={SIDEBAR_MAX_WIDTH}
        aria-valuenow={sidebarWidth}
        aria-valuetext={`${sidebarWidth} pixels`}
        tabIndex={0}
        onPointerDown={handleSidebarPointerDown}
        onPointerMove={handleSidebarPointerMove}
        onPointerUp={handleSidebarPointerUp}
        onPointerCancel={handleSidebarPointerUp}
        onKeyDown={handleSidebarResizeKeyDown}
      />
      {mobileNavOpen ? <button className="mobile-sidebar-scrim" type="button" aria-label="Close navigation" onClick={() => setMobileNavOpen(false)} /> : null}

      <main className="main-panel">
        <header className={`topbar ${activeConnection ? '' : 'is-empty'}`}>
          <div className="breadcrumbs">
            <button className="mobile-nav-button" type="button" onClick={() => setMobileNavOpen((open) => !open)} aria-label="Open navigation" aria-expanded={mobileNavOpen}>
              <svg viewBox="0 0 18 18" fill="none" aria-hidden="true"><path d="M3 5h12M3 9h12M3 13h12" /></svg>
            </button>
            {selectedTable ? <><span className="crumb-muted">{activeConnection?.name}</span><svg viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="m6 3 5 5-5 5" /></svg><span className="crumb-current">{selectedTable.name}</span></> : <span className="crumb-current">{activeConnection?.name ?? 'hyperpg'}</span>}
          </div>
          <div className="topbar-right">
            {activeConnection ? <span className="status-pill" title="Connected" aria-label="Connected"><span className="status-dot" /></span> : null}
            <button className="topbar-add" type="button" onClick={openConnectionDialog}><span>＋</span> Add connection</button>
          </div>
        </header>

        {activeConnection ? (
          <div className="content-area">
            <section className="database-header">
              <div>
                <h1>{activeConnection.name}</h1>
                <div className="database-meta">{activeConnection.host}<span className="meta-divider" />{tables.length} tables</div>
              </div>
              <button className="quiet-action" type="button" aria-label="Refresh" title="Refresh" onClick={() => setRefreshKey((value) => value + 1)}>
                <svg viewBox="0 0 18 18" fill="none" aria-hidden="true"><path d="M14.8 5.1A6.5 6.5 0 1 0 15.5 9M14.8 5.1V1.8M14.8 5.1h-3.3" /></svg>
              </button>
            </section>

            {savedConnectionsError ? <div className="notice notice-error compact-notice" role="alert">{savedConnectionsError}</div> : null}

            <section className="workspace-section">
              <div className="workspace-tabs" role="tablist" aria-label="Database views">
                {selectedTable ? <div className="view-switcher" role="tablist" aria-label="Table view">
                  <button type="button" role="tab" aria-selected={view === 'data'} className={view === 'data' ? 'is-selected' : ''} onClick={() => setView('data')}>Data</button>
                  <button type="button" role="tab" aria-selected={view === 'structure'} className={view === 'structure' ? 'is-selected' : ''} onClick={() => setView('structure')}>Structure</button>
                </div> : null}
              </div>

              {!selectedTable ? (
                <div className="overview-content">
                  <div className="overview-intro">
                    <div>
                      <h2>Select a table</h2>
                    </div>
                    <div className="overview-stat"><span className="stat-icon"><DatabaseIcon /></span><span><strong>{tables.length}</strong><small>tables available</small></span></div>
                  </div>
                  {tables.length > 0 ? <div className="table-catalog">
                    <div className="catalog-heading"><span>Tables in this database</span><span>{tables.length}</span></div>
                    <div className="catalog-grid">
                      {tables.map((table) => <button className="catalog-table" key={`${table.schema}.${table.name}`} type="button" onClick={() => selectTable(table)}>
                        <span className="catalog-icon"><svg viewBox="0 0 18 18" fill="none"><rect x="2.5" y="3" width="13" height="12" rx="2" /><path d="M2.5 7h13M7 7v8" /></svg></span>
                        <span><strong>{table.name}</strong><small>{table.schema} schema</small></span>
                        <svg className="catalog-arrow" viewBox="0 0 16 16" fill="none"><path d="m6 3 5 5-5 5" /></svg>
                      </button>)}
                    </div>
                  </div> : tablesError ? <div className="notice notice-error">{tablesError}</div> : tablesLoading ? <div className="overview-loading"><span className="spinner" />Reading database schema…</div> : <div className="empty-database"><span className="empty-database-icon"><DatabaseIcon /></span><strong>No tables</strong><span>Tables will appear here as soon as they’re available.</span></div>}
                </div>
              ) : (
                <div className="table-workspace">
                  <div className="table-title-row">
                    <div>
                      <div className="table-breadcrumb"><span>{selectedTable.schema}</span><svg viewBox="0 0 16 16" fill="none"><path d="m6 3 5 5-5 5" /></svg><span>table</span></div>
                      <h2>{selectedTable.name}</h2>
                    </div>
                    {tableData ? <div className="row-count"><strong>{tableData.rowCount.toLocaleString()}</strong><span>{tableData.rowCount === 1 ? 'row' : 'rows'}</span></div> : null}
                  </div>

                  {view === 'data' ? <>
                    <div className="table-toolbar">
                      <div className="toolbar-description"><span className="green-square" />{tableData ? `${pageStart.toLocaleString()}–${pageEnd.toLocaleString()} of ${tableData.rowCount.toLocaleString()} rows` : 'Table data'}</div>
                      <label className="row-search"><svg viewBox="0 0 18 18" fill="none"><circle cx="8" cy="8" r="5.4" /><path d="m12 12 3.2 3.2" /></svg><input value={rowSearch} onChange={(event) => setRowSearch(event.target.value)} placeholder="Search this page" aria-label="Search this page" /></label>
                    </div>
                    {tableError ? <div className="notice notice-error">{tableError}</div> : null}
                    {tableLoading ? <div className="table-loading"><span className="spinner" />Loading rows…</div> : tableData ? <div className="data-grid-wrap">
                      {tableData.columns.length === 0 ? <div className="empty-table">This table has no columns.</div> : filteredRows.length === 0 ? <div className="empty-table">{rowSearch ? 'No rows match your search.' : 'This table has no rows yet.'}</div> : <div className="data-grid-scroll"><table className="data-grid">
                        <thead><tr><th className="row-index-heading">#</th>{tableData.columns.map((column) => <th key={column.name}><span>{column.name}</span><small>{column.dataType}</small></th>)}</tr></thead>
                        <tbody>{filteredRows.map(({ row, index }) => <tr key={index}><td className="row-index">{pageOffset + index + 1}</td>{row.map((value, columnIndex) => <td key={`${index}-${columnIndex}`}><CellValue value={value} /></td>)}</tr>)}</tbody>
                      </table></div>}
                    </div> : null}
                    {tableData ? <div className="grid-pagination">
                      <label className="page-size-control"><span>Rows per page</span><select aria-label="Rows per page" value={pageSize} onChange={(event) => { setPageSize(Number(event.target.value)); setPageOffset(0) }}>
                        {[25, 50, 100, 250, 500].map((size) => <option key={size} value={size}>{size}</option>)}
                      </select></label>
                      <span className="pagination-range">{pageStart.toLocaleString()}–{pageEnd.toLocaleString()} of {tableData.rowCount.toLocaleString()}</span>
                      <div className="pagination-actions">
                        <button className="pagination-button" type="button" aria-label="Previous page" disabled={tableLoading || pageOffset === 0} onClick={() => setPageOffset((offset) => Math.max(0, offset - pageSize))}>Previous</button>
                        <button className="pagination-button" type="button" aria-label="Next page" disabled={tableLoading || pageOffset + pageSize >= tableData.rowCount} onClick={() => setPageOffset((offset) => offset + pageSize)}>Next</button>
                      </div>
                    </div> : null}
                  </> : <>
                    <div className="structure-intro"><h3>Columns</h3><span>{tableData?.columns.length ?? 0} total</span></div>
                    {tableLoading ? <div className="table-loading"><span className="spinner" />Loading structure…</div> : tableData ? <div className="structure-table-wrap"><table className="structure-table"><thead><tr><th>Column</th><th>Type</th><th>Nullable</th></tr></thead><tbody>{tableData.columns.map((column, index) => <tr key={column.name}><td><span className="column-order">{String(index + 1).padStart(2, '0')}</span><strong>{column.name}</strong></td><td><code>{column.dataType}</code></td><td><span className="nullable-value">Yes</span></td></tr>)}</tbody></table></div> : null}
                  </>}
                </div>
              )}
            </section>
            <footer className="main-footer"><span><span className="footer-led" />Connected to {activeConnection.database}</span><span>Read-only table browser</span></footer>
          </div>
        ) : (
          <div className="welcome-area">
            <div className="welcome-content">
              {savedConnectionsError ? <div className="notice notice-error compact-notice" role="alert">{savedConnectionsError}</div> : null}
              <div className="welcome-art" aria-hidden="true">
                <div className="art-orbit art-orbit-one" /><div className="art-orbit art-orbit-two" />
                <div className="art-db"><DatabaseIcon /></div>
                <div className="art-row art-row-one"><span /><i /><i /><i /></div>
                <div className="art-row art-row-two"><span /><i /><i /><i /></div>
                <div className="art-row art-row-three"><span /><i /><i /><i /></div>
                <span className="art-spark art-spark-one">✳</span><span className="art-spark art-spark-two">✦</span>
              </div>
              <span className="welcome-kicker">PostgreSQL workspace</span>
              <h1>Connect a database</h1>
              <p>Paste a PostgreSQL connection URL to browse its schemas, tables, and rows.</p>
              <button className="welcome-cta" type="button" onClick={openConnectionDialog}><span>＋</span> Add a connection</button>
            </div>
            <div className="welcome-bottom"><span>Built for the shape of your data</span><span>hyperpg <i /> PostgreSQL explorer</span></div>
          </div>
        )}
      </main>

      {showConnectionDialog ? <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget && !connecting) setShowConnectionDialog(false) }}>
        <section className="connection-dialog" role="dialog" aria-modal="true" aria-labelledby="dialog-title">
          <button className="dialog-close" type="button" aria-label="Close" onClick={() => setShowConnectionDialog(false)} disabled={connecting}><svg viewBox="0 0 18 18" fill="none"><path d="m4 4 10 10M14 4 4 14" /></svg></button>
          <div className="dialog-icon"><DatabaseIcon /></div>
          <div className="dialog-heading"><h2 id="dialog-title">New connection</h2><p>Paste a PostgreSQL connection URL to get started.</p></div>
          <form onSubmit={handleConnect}>
            <label className="field-label" htmlFor="connection-name">Connection name <span>Optional</span></label>
            <input id="connection-name" className="dialog-input" value={connectionName} onChange={(event) => setConnectionName(event.target.value)} placeholder="e.g. Production" autoComplete="off" />
            <label className="field-label connection-url-label" htmlFor="connection-url">Database URL</label>
            <div className="url-input-wrap"><input id="connection-url" className="dialog-input url-input" value={connectionUrl} onChange={(event) => setConnectionUrl(event.target.value)} placeholder="postgresql://user:password@host:5432/dbname" type={showUrl ? 'text' : 'password'} autoComplete="off" autoFocus required /><button className="reveal-url" type="button" onClick={() => setShowUrl((visible) => !visible)} aria-label={showUrl ? 'Hide URL' : 'Show URL'}>{showUrl ? <svg viewBox="0 0 20 20" fill="none"><path d="M3 3 17 17M8.6 8.7a2 2 0 0 0 2.7 2.7M7.1 5.3A9.8 9.8 0 0 1 10 4.8c4.6 0 7.5 4.1 8 5.2-.2.5-1 1.8-2.4 2.9M5.2 6.7C3.5 7.8 2.4 9.5 2 10c.5 1.1 3.4 5.2 8 5.2 1 0 1.9-.2 2.7-.6" /></svg> : <svg viewBox="0 0 20 20" fill="none"><path d="M2 10s2.8-5.2 8-5.2 8 5.2 8 5.2-2.8 5.2-8 5.2S2 10 2 10Z" /><circle cx="10" cy="10" r="2.2" /></svg>}</button></div>
            {connectionError ? <div className="form-error" role="alert"><svg viewBox="0 0 18 18" fill="none"><circle cx="9" cy="9" r="6.7" /><path d="M9 5.5v4M9 12.1v.1" /></svg>{connectionError}</div> : null}
            <div className="dialog-note"><svg viewBox="0 0 18 18" fill="none"><path d="M9 2.2 3.2 4.5v4.1c0 3.3 2.5 5.9 5.8 7.2 3.3-1.3 5.8-3.9 5.8-7.2V4.5L9 2.2Z" /><path d="m6.4 8.8 1.7 1.7 3.6-3.7" /></svg><span>Saved securely on this device.</span></div>
            <div className="dialog-actions"><button className="cancel-button" type="button" onClick={() => setShowConnectionDialog(false)} disabled={connecting}>Cancel</button><button className="connect-button" type="submit" disabled={connecting || !connectionUrl.trim()}>{connecting ? <><span className="button-spinner" />Connecting</> : 'Connect database'}</button></div>
          </form>
        </section>
      </div> : null}

      {showSettingsDialog ? <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setShowSettingsDialog(false) }}>
        <section className="connection-dialog settings-dialog" role="dialog" aria-modal="true" aria-labelledby="settings-title">
          <button className="dialog-close" type="button" aria-label="Close settings" onClick={() => setShowSettingsDialog(false)}><svg viewBox="0 0 18 18" fill="none"><path d="m4 4 10 10M14 4 4 14" /></svg></button>
          <div className="dialog-icon settings-icon"><svg viewBox="0 0 20 20" fill="none" aria-hidden="true"><path d="M10 2.4v1.4M10 16.2v1.4M17.6 10h-1.4M3.8 10H2.4m13-5.4-1 1m-8.8 8.8-1 1m10.8 0-1-1m-8.8-8.8-1-1" /><circle cx="10" cy="10" r="4.2" /></svg></div>
          <div className="dialog-heading"><h2 id="settings-title">Settings</h2><p>Choose how hyperpg looks on this device.</p></div>
          <div className="settings-section">
            <span className="field-label">Appearance</span>
            <div className="theme-options" role="radiogroup" aria-label="Color theme">
              <button className={`theme-option ${theme === 'light' ? 'is-selected' : ''}`} type="button" role="radio" aria-checked={theme === 'light'} onClick={() => setTheme('light')}>
                <span className="theme-preview theme-preview-light"><i /><i /><i /><b /></span>
                <span className="theme-option-copy"><strong>Light</strong><small>Soft, bright workspace</small></span>
                <span className="theme-radio" />
              </button>
              <button className={`theme-option ${theme === 'dark' ? 'is-selected' : ''}`} type="button" role="radio" aria-checked={theme === 'dark'} onClick={() => setTheme('dark')}>
                <span className="theme-preview theme-preview-dark"><i /><i /><i /><b /></span>
                <span className="theme-option-copy"><strong>Dark</strong><small>Low-light workspace</small></span>
                <span className="theme-radio" />
              </button>
            </div>
          </div>
          <div className="dialog-note settings-note"><svg viewBox="0 0 18 18" fill="none"><path d="M9 2.2 3.2 4.5v4.1c0 3.3 2.5 5.9 5.8 7.2 3.3-1.3 5.8-3.9 5.8-7.2V4.5L9 2.2Z" /><path d="m6.4 8.8 1.7 1.7 3.6-3.7" /></svg><span>Your appearance choice is saved automatically on this device.</span></div>
          <div className="dialog-actions"><button className="connect-button settings-done" type="button" onClick={() => setShowSettingsDialog(false)}>Done</button></div>
        </section>
      </div> : null}
    </div>
  )
}

function DatabaseIcon() {
  return <svg viewBox="0 0 20 20" fill="none" aria-hidden="true"><ellipse cx="10" cy="4.5" rx="6.5" ry="2.5" /><path d="M3.5 4.5v5c0 1.4 2.9 2.5 6.5 2.5s6.5-1.1 6.5-2.5v-5M3.5 9.5v5c0 1.4 2.9 2.5 6.5 2.5s6.5-1.1 6.5-2.5v-5" /><path d="M3.5 9.5C3.5 10.9 6.4 12 10 12s6.5-1.1 6.5-2.5" /></svg>
}

function CellValue({ value }: { value: unknown }) {
  if (value === null || value === undefined) return <span className="null-value">NULL</span>
  if (typeof value === 'boolean') return <span className={`boolean-value ${value ? 'is-true' : 'is-false'}`}>{String(value)}</span>
  if (typeof value === 'object') return <span className="json-value">{JSON.stringify(value)}</span>
  return <span className="cell-text" title={String(value)}>{String(value)}</span>
}

function formatValue(value: unknown) {
  if (value === null || value === undefined) return 'null'
  return typeof value === 'object' ? JSON.stringify(value) : String(value)
}

function errorMessage(error: unknown, fallback: string) {
  if (typeof error === 'string' && error.trim()) return error
  if (error instanceof Error && error.message) return error.message
  return fallback
}

export default App
