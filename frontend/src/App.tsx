import { lazy, Suspense, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type FormEvent, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent } from 'react'
import { PostgresService, UpdateService } from './services'
import DataGrid, { type DataGridHandle } from './DataGrid'
import type { TableData } from './grid'
import ConnectionTree, { type ConnectionInfo, type TableInfo } from './ConnectionTree'
import Icon from './Icon'
const SqlEditor = lazy(() => import('./SqlEditor'))
import TableQueryControls from './TableQueryControls'
import TableDetails from './TableDetails'
import { emptyTableQuery, type TableQueryOptions } from './table-query'
import { readWorkspace, writeWorkspace, readHistory, writeHistory, type HistoryEntry } from './workspace'
import './workspace.css'

type View = 'data' | 'structure'
type Theme = 'light' | 'dark' | 'cream' | 'discord'
type WorkspaceTab = { id: string; kind: 'table' | 'script'; connectionId: string; database: { id: string; name: string }; table?: TableInfo; title: string; path?: string; savedContent?: string }
type UpdateChannel = 'stable' | 'nightly'
type ShortcutAction = 'refresh' | 'closeTab' | 'newScript' | 'runScript' | 'saveChanges' | 'settings'
const shortcutLabels: Record<ShortcutAction, string> = { refresh: 'Refresh', closeTab: 'Close tab', newScript: 'New SQL script', runScript: 'Run script', saveChanges: 'Save table changes', settings: 'Open settings' }
const defaultShortcuts: Record<ShortcutAction, string> = { refresh: 'F5', closeTab: 'Ctrl+W', newScript: '', runScript: '', saveChanges: '', settings: '' }
function shortcutFromEvent(event: { key: string; ctrlKey: boolean; altKey: boolean; shiftKey: boolean; metaKey: boolean }): string {
  if (['Control', 'Shift', 'Alt', 'Meta'].includes(event.key)) return ''
  const key = event.key.length === 1 ? event.key.toUpperCase() : event.key
  return [event.ctrlKey && 'Ctrl', event.altKey && 'Alt', event.shiftKey && 'Shift', event.metaKey && 'Meta', key].filter(Boolean).join('+')
}

type UpdateInfo = { available: boolean; version: string; releaseUrl: string; installError?: string }
type CachedTablePage = {
  queryKey: string
  databaseId: string
  schema: string
  table: string
  offset: number
  refreshKey: number
  data: TableData
  limit: number
  appliedSize: number
}

const SIDEBAR_MIN_WIDTH = 190
const SIDEBAR_MAX_WIDTH = 420
const DEFAULT_SIDEBAR_WIDTH = 246
const BASE_FONT_SIZE_PX = 12
const MIN_FONT_SIZE_PX = 10
const MAX_FONT_SIZE_PX = 18

function handleRadioGroupKeyDown<T extends string>(
  event: ReactKeyboardEvent<HTMLButtonElement>,
  values: readonly T[],
  selected: T,
  onSelect: (value: T) => void,
) {
  const currentIndex = values.indexOf(selected)
  let nextIndex = currentIndex
  if (event.key === 'ArrowRight' || event.key === 'ArrowDown') nextIndex = (currentIndex + 1) % values.length
  else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') nextIndex = (currentIndex - 1 + values.length) % values.length
  else if (event.key === 'Home') nextIndex = 0
  else if (event.key === 'End') nextIndex = values.length - 1
  else return

  event.preventDefault()
  event.currentTarget.closest('[role="radiogroup"]')?.querySelectorAll<HTMLButtonElement>('[role="radio"]')[nextIndex]?.focus()
  onSelect(values[nextIndex])
}

function App() {
  const [connections, setConnections] = useState<ConnectionInfo[]>([])
  const [selectedConnectionId, setSelectedConnectionId] = useState('')
  const [selectedDatabase, setSelectedDatabase] = useState({ name: '', id: '' })
  const connectionSelection = useRef(0)
  const [connectionRevisions, setConnectionRevisions] = useState<Record<string, number>>({})
  const [tables, setTables] = useState<TableInfo[]>([])
  const [selectedTable, setSelectedTable] = useState<TableInfo | null>(null)
  const [loadedTableData, setTableData] = useState<TableData | null>(null)
  const tablePage = useRef<CachedTablePage | null>(null)
  const gridRef = useRef<DataGridHandle>(null)
  const [hasPendingChanges, setHasPendingChanges] = useState(false)
  const handleDirtyChange = useCallback((dirty: boolean) => {
    if (dirty) { connectionSelection.current++; setOpeningConnectionId('') }
    setHasPendingChanges(dirty)
  }, [])
  const [savingChanges, setSavingChanges] = useState(false)
  const [pendingNavigation, setPendingNavigation] = useState<(() => void) | null>(null)
  const [tablesLoading, setTablesLoading] = useState(false)
  const [tableLoading, setTableLoading] = useState(false)
  const [tableSelectionVersion, setTableSelectionVersion] = useState(0)
  const [tablesError, setTablesError] = useState('')
  const [tableError, setTableError] = useState('')
  const [savedConnectionsError, setSavedConnectionsError] = useState('')
  const [openingConnectionId, setOpeningConnectionId] = useState('')
  const [refreshKey, setRefreshKey] = useState(0)
  const [scriptRefreshPending, setScriptRefreshPending] = useState(false)
  const [pageSize, setPageSize] = useState(100)
  const [pageOffset, setPageOffset] = useState(0)
  const [connectionError, setConnectionError] = useState('')
  const [showConnectionDialog, setShowConnectionDialog] = useState(false)
  const connectionDialogOpener = useRef<HTMLElement | null>(null)
  const [connectionUrl, setConnectionUrl] = useState('')
  const [connectionName, setConnectionName] = useState('')
  const [editingConnectionId, setEditingConnectionId] = useState('')
  const [showAllDatabases, setShowAllDatabases] = useState(false)
  const [showUrl, setShowUrl] = useState(false)
  const [connecting, setConnecting] = useState(false)
  const [view, setView] = useState<View>('data')
  const [showSql, setShowSql] = useState(false)
  const [initialWorkspace] = useState(() => ({ current: readWorkspace() }))
  const [tabs, setTabs] = useState<WorkspaceTab[]>(() => initialWorkspace.current.tabs.map((tab) => ({ ...tab, database: { id: '', name: tab.databaseName } })))
  const tabsRef = useRef(tabs)
  tabsRef.current = tabs
  const [activeTabId, setActiveTabId] = useState(() => initialWorkspace.current.activeTabId)
  const [history, setHistory] = useState<HistoryEntry[]>(readHistory)
  const [showHistory, setShowHistory] = useState(false)
  const [renamingScript, setRenamingScript] = useState<WorkspaceTab | null>(null)
  const [scriptName, setScriptName] = useState('')
  const [historySearch, setHistorySearch] = useState('')
  const [workspaceError, setWorkspaceError] = useState('')
  const fileInput = useRef<HTMLInputElement>(null)
  const [scriptToClose, setScriptToClose] = useState<WorkspaceTab | null>(null)
  const [runningScripts, setRunningScripts] = useState<Set<string>>(new Set())
  const nextScriptId = useRef(Math.max(0, ...initialWorkspace.current.tabs.map((tab) => Number(/^Script (\d+)$/.exec(tab.title)?.[1] ?? 0))))
  const tableTabState = useRef<Record<string, { offset: number; size: number; search: string; view: View; query: TableQueryOptions }>>({})
  const [sqlDrafts, setSqlDrafts] = useState<Record<string, string>>(() => initialWorkspace.current.drafts)
  const [rowSearch, setRowSearch] = useState('')
  const [tableQuery, setTableQuery] = useState<TableQueryOptions>(emptyTableQuery)
  const queryKey = JSON.stringify(tableQuery)
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
  const [settingsCategory, setSettingsCategory] = useState<'appearance' | 'shortcuts' | 'updates'>('appearance')
  const [recordingShortcut, setRecordingShortcut] = useState<ShortcutAction | null>(null)
  const [shortcutError, setShortcutError] = useState('')
  const [shortcuts, setShortcuts] = useState<Record<ShortcutAction, string>>(() => {
    try {
      const saved = JSON.parse(localStorage.getItem('hyperpg-shortcuts') || '{}')
      return Object.fromEntries(Object.keys(defaultShortcuts).map((key) => [key, typeof saved[key] === 'string' ? saved[key] : defaultShortcuts[key as ShortcutAction]])) as Record<ShortcutAction, string>
    } catch { return { ...defaultShortcuts } }
  })
  const settingsDialogOpener = useRef<HTMLElement | null>(null)
  const [updateChannel, setUpdateChannel] = useState<UpdateChannel>(() => {
    try {
      return localStorage.getItem('hyperpg-update-channel') === 'nightly' ? 'nightly' : 'stable'
    } catch {
      return 'stable'
    }
  })
  const [updateInfo, setUpdateInfo] = useState<UpdateInfo | null>(null)
  const [updateCheckError, setUpdateCheckError] = useState('')
  const [updateCheckMessage, setUpdateCheckMessage] = useState('')
  const [checkingUpdates, setCheckingUpdates] = useState(false)
  const [installingUpdate, setInstallingUpdate] = useState(false)
  const [updateRestarting, setUpdateRestarting] = useState(false)
  const [updateInstallError, setUpdateInstallError] = useState('')
  const [dismissedUpdate, setDismissedUpdate] = useState('')
  const [updateRefreshKey, setUpdateRefreshKey] = useState(0)
  const [theme, setTheme] = useState<Theme>(() => {
    try {
      const savedTheme = localStorage.getItem('hyperpg-theme')
      return savedTheme === 'dark' || savedTheme === 'cream' || savedTheme === 'discord' ? savedTheme : 'light'
    } catch {
      return 'light'
    }
  })
  const [fontSizePx, setFontSizePx] = useState(() => {
    try {
      const savedFontSizePx = Number(localStorage.getItem('hyperpg-font-size-px'))
      if (Number.isInteger(savedFontSizePx) && savedFontSizePx >= MIN_FONT_SIZE_PX && savedFontSizePx <= MAX_FONT_SIZE_PX) return savedFontSizePx

      const previousFontSize = localStorage.getItem('hyperpg-font-size')
      if (previousFontSize === 'small') return 11
      if (previousFontSize === 'large') return 14
      return BASE_FONT_SIZE_PX
    } catch {
      return BASE_FONT_SIZE_PX
    }
  })

  const activeConnection = connections.find((connection) => connection.id === selectedConnectionId) ?? null
  const cachedPage = tablePage.current
  const sameTablePage = cachedPage && cachedPage.databaseId === selectedDatabase.id && cachedPage.schema === selectedTable?.schema &&
    cachedPage.table === selectedTable?.name && cachedPage.offset === pageOffset && cachedPage.queryKey === queryKey
  const tableData = sameTablePage ? loadedTableData : null
  const tableStale = !!sameTablePage && cachedPage.refreshKey !== refreshKey
  const tableBusy = tableLoading || (tableStale && !tableError)
  const loadedBytes = useMemo(() => tableData?.rows.length ? new TextEncoder().encode(JSON.stringify(tableData.rows)).byteLength : 0, [tableData])
  const tableActivity = savingChanges ? 'Saving changes' : tableBusy ? tableStale ? 'Refreshing rows' : 'Loading rows' : ''
  const sidebarMaxWidth = Math.max(SIDEBAR_MIN_WIDTH, Math.min(SIDEBAR_MAX_WIDTH, window.innerWidth - 320))
  const themeValues: Theme[] = ['light', 'cream', 'dark', 'discord']
  const updateChannelValues: UpdateChannel[] = ['stable', 'nightly']

  useEffect(() => {
    if (!showConnectionDialog) {
      setConnectionUrl('')
      setShowUrl(false)
    }
  }, [showConnectionDialog])

  useEffect(() => {
    let cancelled = false
    const restoreSavedConnections = async () => {
      const request = ++connectionSelection.current
      try {
        const saved = await PostgresService.ListSavedConnections()
        if (cancelled || request !== connectionSelection.current) return
        const items = saved ?? []
        setConnections(items)
        const restored = initialWorkspace.current.tabs.find((tab) => tab.id === initialWorkspace.current.activeTabId) ?? initialWorkspace.current.tabs[0]
        if (restored) {
          if (!items.some((item) => item.id === restored.connectionId)) { setWorkspaceError('The saved connection for this workspace is unavailable. Your drafts are preserved.'); return }
          setOpeningConnectionId(restored.connectionId)
          const handle = await PostgresService.OpenDatabase(restored.connectionId, restored.databaseName)
          if (cancelled || request !== connectionSelection.current) return
          setTabs((current) => current.map((tab) => tab.id === restored.id ? { ...tab, database: { name: restored.databaseName, id: handle } } : tab))
          setSelectedConnectionId(restored.connectionId); setSelectedDatabase({ name: restored.databaseName, id: handle })
          setActiveTabId(restored.id); setShowSql(restored.kind === 'script'); setSelectedTable(restored.table ?? null)
          return
        }
        if (items.length === 0) return

        setOpeningConnectionId(items[0].id)
        const info = await PostgresService.OpenSavedConnection(items[0].id)
        if (!cancelled && request === connectionSelection.current) {
          setSelectedConnectionId(info.id)
          setSelectedDatabase({ name: info.database, id: info.id })
        }
      } catch (error) {
        if (!cancelled && request === connectionSelection.current) setSavedConnectionsError(errorMessage(error, 'Could not open the saved connection.'))
      } finally {
        if (!cancelled && request === connectionSelection.current) setOpeningConnectionId('')
      }
    }
    void restoreSavedConnections()
    return () => { cancelled = true }
  }, [])

  useEffect(() => {
    writeWorkspace({ tabs: tabs.map(({ id, kind, connectionId, database, table, title, path, savedContent }) => ({ id, kind, connectionId, databaseName: database.name, table, title, path, savedContent })), activeTabId, drafts: sqlDrafts })
  }, [tabs, activeTabId, sqlDrafts])
  useEffect(() => { writeHistory(history) }, [history])

  useLayoutEffect(() => {
    const root = document.documentElement
    root.classList.add('theme-switching')
    root.dataset.theme = theme
    // Flush the new colors before restoring normal hover transitions.
    void root.offsetHeight
    root.classList.remove('theme-switching')
    try {
      localStorage.setItem('hyperpg-theme', theme)
    } catch {
      // Theme remains active for this session if local storage is unavailable.
    }
  }, [theme])

  useEffect(() => {
    document.documentElement.style.setProperty('--font-scale', String(fontSizePx / BASE_FONT_SIZE_PX))
    try {
      localStorage.setItem('hyperpg-font-size-px', String(fontSizePx))
      localStorage.removeItem('hyperpg-font-size')
    } catch {
      // Font size remains active for this session if local storage is unavailable.
    }
  }, [fontSizePx])

  useEffect(() => {
    try {
      localStorage.setItem('hyperpg-sidebar-width', String(sidebarWidth))
    } catch {
      // The current width remains active if local storage is unavailable.
    }
  }, [sidebarWidth])

  useEffect(() => {
    const keepSidebarWithinViewport = () => {
      if (window.innerWidth <= 560) return
      const maxWidth = Math.max(SIDEBAR_MIN_WIDTH, Math.min(SIDEBAR_MAX_WIDTH, window.innerWidth - 320))
      setSidebarWidth((width) => Math.min(width, maxWidth))
    }
    window.addEventListener('resize', keepSidebarWithinViewport)
    return () => window.removeEventListener('resize', keepSidebarWithinViewport)
  }, [])

  useEffect(() => {
    try {
      localStorage.setItem('hyperpg-update-channel', updateChannel)
    } catch {
      // The selected channel remains active for this session if storage is unavailable.
    }
  }, [updateChannel])

  useEffect(() => {
    let cancelled = false
    setCheckingUpdates(true)
    setUpdateCheckError('')
    setUpdateCheckMessage('')
    setUpdateInstallError('')
    setUpdateInfo(null)
    setDismissedUpdate('')
    UpdateService.CheckForUpdates(updateChannel)
      .then((result) => {
        if (cancelled) return
        setUpdateInfo(result?.available || result?.installError ? result : null)
        setUpdateInstallError(result?.installError ?? '')
        setUpdateCheckError(result?.installError ?? '')
        setUpdateCheckMessage(result?.installError ? 'The previous update did not finish.' : result?.available ? `Version ${result.version} is ready.` : 'You’re up to date.')
      })
      .catch((error: unknown) => {
        if (!cancelled) setUpdateCheckError(errorMessage(error, 'Could not check for updates.'))
      })
      .finally(() => {
        if (!cancelled) setCheckingUpdates(false)
      })
    return () => { cancelled = true }
  }, [updateChannel, updateRefreshKey])

  const handleSidebarPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return
    event.preventDefault()
    event.currentTarget.setPointerCapture(event.pointerId)
    setResizingSidebar(true)
  }

  const handleSidebarPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!resizingSidebar) return
    setSidebarWidth(Math.min(sidebarMaxWidth, Math.max(SIDEBAR_MIN_WIDTH, event.clientX)))
  }

  const handleSidebarPointerUp = () => setResizingSidebar(false)

  const handleSidebarResizeKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
      event.preventDefault()
      const direction = event.key === 'ArrowLeft' ? -1 : 1
      setSidebarWidth((width) => Math.min(sidebarMaxWidth, Math.max(SIDEBAR_MIN_WIDTH, width + direction * 16)))
    } else if (event.key === 'Home' || event.key === 'End') {
      event.preventDefault()
      setSidebarWidth(event.key === 'Home' ? SIDEBAR_MIN_WIDTH : sidebarMaxWidth)
    }
  }

  useEffect(() => {
    if (!showConnectionDialog && !showSettingsDialog && !scriptToClose && !showHistory && !renamingScript) return
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || recordingShortcut) return
      if (renamingScript) setRenamingScript(null)
      else if (showHistory) setShowHistory(false)
      else if (scriptToClose) setScriptToClose(null)
      else if (showSettingsDialog) setShowSettingsDialog(false)
      else if (!connecting) setShowConnectionDialog(false)
    }
    window.addEventListener('keydown', closeOnEscape)
    return () => window.removeEventListener('keydown', closeOnEscape)
  }, [showConnectionDialog, showSettingsDialog, connecting, recordingShortcut, scriptToClose, showHistory, renamingScript])

  useEffect(() => {
    if (!showConnectionDialog && !showSettingsDialog && !scriptToClose && !showHistory && !renamingScript) return
    const dialog = document.querySelector<HTMLElement>('.modal-backdrop [role="dialog"]')
    const backdrop = dialog?.closest<HTMLElement>('.modal-backdrop')
    if (!dialog || !backdrop) return

    const previouslyFocused = document.activeElement instanceof HTMLElement ? document.activeElement : null
    const siblings = [...(backdrop.parentElement?.children ?? [])].filter((element) => element !== backdrop) as HTMLElement[]
    const priorInertStates = siblings.map((element) => element.inert)
    siblings.forEach((element) => { element.inert = true })

    const focusableElements = () => [...dialog.querySelectorAll<HTMLElement>(
      'a[href], button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])',
    )].filter((element) => element.tabIndex >= 0 && element.getClientRects().length > 0)
    const initialFocus = dialog.querySelector<HTMLElement>('#connection-url, input[autofocus], [role="radio"][aria-checked="true"]')
      ?? focusableElements()[0]
    initialFocus?.focus()

    const keepFocusInDialog = (event: KeyboardEvent) => {
      if (event.key !== 'Tab') return
      const focusable = focusableElements()
      if (focusable.length === 0) { event.preventDefault(); dialog.focus(); return }
      const first = focusable[0]
      const last = focusable[focusable.length - 1]
      if (event.shiftKey && (document.activeElement === first || !dialog.contains(document.activeElement))) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && (document.activeElement === last || !dialog.contains(document.activeElement))) {
        event.preventDefault()
        first.focus()
      }
    }
    document.addEventListener('keydown', keepFocusInDialog)

    return () => {
      document.removeEventListener('keydown', keepFocusInDialog)
      siblings.forEach((element, index) => { element.inert = priorInertStates[index] })
      const opener = showSettingsDialog ? settingsDialogOpener.current : showConnectionDialog ? connectionDialogOpener.current : previouslyFocused
      if (opener?.isConnected) opener.focus()
      else previouslyFocused?.focus()
    }
  }, [showConnectionDialog, showSettingsDialog, scriptToClose, showHistory, renamingScript])

  const pageStart = tableData?.rows.length ? pageOffset + 1 : 0
  const pageEnd = tableData ? Math.min(pageOffset + tableData.rows.length, tableData.rowCount) : 0
  // A size change keeps the first visible row, so subsequent pages are based
  // on that position rather than forcing the user back to a page boundary.
  const lastPageOffset = tableData && tableData.rowCount > 0
    ? pageOffset + Math.max(0, Math.floor((tableData.rowCount - 1 - pageOffset) / pageSize)) * pageSize
    : 0

  useEffect(() => {
    if (!selectedDatabase.id) {
      setTables([])
      setSelectedTable(null)
      setTableData(null)
      return
    }

    let cancelled = false
    setTablesLoading(true)
    setTables([])
    setTablesError('')
    PostgresService.ListTables(selectedDatabase.id)
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
  }, [selectedDatabase.id, refreshKey])

  useEffect(() => {
    if (!selectedDatabase.id || !selectedTable) {
      tablePage.current = null
      setTableData(null)
      setTableLoading(false)
      return
    }

    let cancelled = false
    const readPage = (limit: number, offset: number) => tableQuery.filters.length || tableQuery.sort.length
      ? PostgresService.GetFilteredTableData(selectedDatabase.id, selectedTable.schema, selectedTable.name, limit, offset, tableQuery)
      : PostgresService.GetTableData(selectedDatabase.id, selectedTable.schema, selectedTable.name, limit, offset)
    const current = tablePage.current
    const sameLocation = current && current.databaseId === selectedDatabase.id && current.schema === selectedTable.schema &&
      current.table === selectedTable.name && current.offset === pageOffset && current.queryKey === queryKey
    const samePage = sameLocation && current.refreshKey === refreshKey

    if (samePage && pageSize <= current.limit) {
      current.appliedSize = pageSize
      setTableData(sliceTablePage(current.data, pageSize))
      setTableLoading(false)
    } else if (samePage) {
      // Read the last cached row again to detect a shift in the ordered page
      // before appending. A concurrent change falls back to a fresh page read.
      const overlap = current.data.rows.length > 0 ? 1 : 0
      const extraOffset = pageOffset + current.data.rows.length - overlap
      const extraLimit = pageSize - current.data.rows.length + overlap
      setTableData(sliceTablePage(current.data, pageSize))
      setTableLoading(true)
      const loadMore = async () => {
        try {
          const extra = normalizeTableData(await readPage(extraLimit, extraOffset))
          if (cancelled) return
          const previousBoundary = current.data.identities[current.data.rows.length - 1]
          const nextBoundary = extra.identities[0]
          const boundaryMatches = !overlap || (
            previousBoundary && nextBoundary &&
            previousBoundary.tableOID === nextBoundary.tableOID && previousBoundary.ctid === nextBoundary.ctid && previousBoundary.version === nextBoundary.version &&
            extra.rows.length > 0
          )
          const canAppend = boundaryMatches && JSON.stringify(current.data.columns) === JSON.stringify(extra.columns)
          const data = canAppend
            ? { ...extra, rows: [...current.data.rows, ...extra.rows.slice(overlap)], identities: [...current.data.identities, ...extra.identities.slice(overlap)] }
            : normalizeTableData(await readPage(pageSize, pageOffset))
          if (cancelled) return
          if (!canAppend) setTableSelectionVersion((version) => version + 1)
          current.data = data
          current.limit = pageSize
          current.appliedSize = pageSize
          setTableData(sliceTablePage(data, pageSize))
        } catch (error: unknown) {
          if (!cancelled) {
            setTableError(errorMessage(error, 'Could not load more rows.'))
            setPageSize(current.appliedSize)
          }
        } finally {
          if (!cancelled) setTableLoading(false)
        }
      }
      void loadMore()
    } else {
      if (!sameLocation) {
        tablePage.current = null
        setTableData(null)
      }
      setTableLoading(true)
      setTableError('')
      readPage(pageSize, pageOffset)
        .then((result) => {
          if (!cancelled) {
            const data = normalizeTableData(result)
            tablePage.current = { queryKey, databaseId: selectedDatabase.id, schema: selectedTable.schema, table: selectedTable.name, offset: pageOffset, refreshKey, data, limit: pageSize, appliedSize: pageSize }
            setTableData(data)
          }
        })
        .catch((error: unknown) => {
          if (!cancelled) setTableError(errorMessage(error, 'Could not load this table.'))
        })
        .finally(() => {
          if (!cancelled) setTableLoading(false)
        })
    }

    return () => { cancelled = true }
  }, [selectedDatabase.id, selectedTable?.schema, selectedTable?.name, pageSize, pageOffset, refreshKey, queryKey])

  const guardNavigation = (action: () => void) => {
    if (savingChanges) return
    if (hasPendingChanges) setPendingNavigation(() => action)
    else action()
  }

  const resolveNavigation = async (save: boolean) => {
    if (save && !(await gridRef.current?.save())) { setPendingNavigation(null); return }
    if (!save) gridRef.current?.discard()
    const action = pendingNavigation
    setPendingNavigation(null)
    action?.()
  }

  const openConnectionDialog = () => {
    connectionDialogOpener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
    guardNavigation(() => {
      setConnectionError('')
      setConnectionUrl('')
      setConnectionName('')
      setEditingConnectionId('')
      setShowAllDatabases(false)
      setShowUrl(false)
      setShowConnectionDialog(true)
    })
  }

  const editConnection = (connection: ConnectionInfo) => {
    connectionDialogOpener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
    guardNavigation(() => {
      setConnectionError('')
      setEditingConnectionId(connection.id)
      setConnectionName(connection.name)
      setShowAllDatabases(connection.showAllDatabases)
      setConnectionUrl('')
      setShowUrl(false)
      setShowConnectionDialog(true)
    })
  }

  const openSettingsDialog = () => {
    settingsDialogOpener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
    setSettingsCategory('appearance')
    setShowSettingsDialog(true)
  }

  const handleTableViewKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const tabs = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="tab"]')]
    const activeIndex = tabs.indexOf(document.activeElement as HTMLButtonElement)
    if (activeIndex < 0) return
    let nextIndex = activeIndex
    if (event.key === 'ArrowRight' || event.key === 'ArrowDown') nextIndex = (activeIndex + 1) % tabs.length
    else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') nextIndex = (activeIndex - 1 + tabs.length) % tabs.length
    else if (event.key === 'Home') nextIndex = 0
    else if (event.key === 'End') nextIndex = tabs.length - 1
    else return
    event.preventDefault()
    tabs[nextIndex].focus()
    tabs[nextIndex].click()
  }

  const handleInstallUpdate = async () => {
    setInstallingUpdate(true)
    setUpdateRestarting(false)
    setUpdateCheckError('')
    setUpdateInstallError('')
    try {
      await UpdateService.InstallUpdate(updateChannel)
      setUpdateRestarting(true)
    } catch (error) {
      const message = errorMessage(error, 'Could not install this update.')
      setUpdateCheckError(message)
      setUpdateInstallError(message)
      setInstallingUpdate(false)
      setUpdateRestarting(false)
    }
  }

  const handleConnect = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    setConnecting(true)
    setConnectionError('')
    try {
      const connection = editingConnectionId
        ? await PostgresService.UpdateSavedConnection(editingConnectionId, connectionUrl.trim(), connectionName.trim(), showAllDatabases)
        : await PostgresService.Connect(connectionUrl.trim(), connectionName.trim(), showAllDatabases)
      connectionSelection.current++
      setConnections((current) => editingConnectionId ? current.map((item) => item.id === connection.id ? connection : item) : [connection, ...current])
      setConnectionRevisions((current) => ({ ...current, [connection.id]: (current[connection.id] ?? 0) + 1 }))
      if (editingConnectionId) setTabs((current) => current.map((tab) => tab.connectionId === editingConnectionId ? { ...tab, database: { ...tab.database, id: '' } } : tab))
      setActiveTabId('')
      setShowSql(false)
      setSelectedConnectionId(connection.id)
      setSelectedDatabase({ name: connection.database, id: connection.id })
      setSelectedTable(null)
      setPageOffset(0)
      setRowSearch('')
      setView('data')
      setShowConnectionDialog(false)
      setMobileNavOpen(false)
      setConnectionUrl('')
      setSavedConnectionsError('')
      setRefreshKey((value) => value + 1)
    } catch (error) {
      setConnectionError(errorMessage(error, 'Could not connect. Check the URL and try again.'))
    } finally {
      setConnecting(false)
    }
  }

  const selectConnection = (connectionId: string) => guardNavigation(() => { void openConnection(connectionId) })

  const openConnection = async (connectionId: string) => {
    const request = ++connectionSelection.current
    setOpeningConnectionId(connectionId)
    setSavedConnectionsError('')
    try {
      const info = await PostgresService.OpenSavedConnection(connectionId)
      if (request !== connectionSelection.current) return
      setActiveTabId('')
      setShowSql(false)
      setSelectedConnectionId(connectionId)
      setSelectedDatabase({ name: info.database, id: connectionId })
      setSelectedTable(null)
      setTableData(null)
      setPageOffset(0)
      setRowSearch('')
      setView('data')
      setMobileNavOpen(false)
    } catch (error) {
      if (request === connectionSelection.current) setSavedConnectionsError(errorMessage(error, 'Could not open this connection.'))
    } finally {
      if (request === connectionSelection.current) setOpeningConnectionId('')
    }
  }

  const selectDatabase = (connection: ConnectionInfo, database: string, table?: TableInfo) => guardNavigation(() => {
    if (selectedConnectionId === connection.id && selectedDatabase.name === database) {
      if (table) showTable(table)
      return
    }
    void openDatabase(connection, database, table)
  })

  const openDatabase = async (connection: ConnectionInfo, database: string, table?: TableInfo) => {
    const request = ++connectionSelection.current
    setOpeningConnectionId(connection.id)
    setSavedConnectionsError('')
    try {
      const handle = await PostgresService.OpenDatabase(connection.id, database)
      if (request !== connectionSelection.current) return
      const db = { name: database, id: handle }
      setSelectedConnectionId(connection.id)
      setSelectedDatabase(db)
      setShowSql(false)
      if (table) openTableTab(connection.id, db, table)
      else setActiveTabId('')
      setSelectedTable(table ?? null)
      setTableData(null)
      if (!table) { setPageOffset(0); setRowSearch(''); setView('data') }
      setMobileNavOpen(false)
    } catch (error) {
      if (request === connectionSelection.current) setSavedConnectionsError(errorMessage(error, 'Could not open this database.'))
    } finally {
      if (request === connectionSelection.current) setOpeningConnectionId('')
    }
  }

  const removeConnection = (connection: ConnectionInfo) => guardNavigation(() => { void deleteConnection(connection) })

  const deleteConnection = async (connection: ConnectionInfo) => {
    try {
      await PostgresService.DeleteSavedConnection(connection.id)
    } catch (error) {
      setSavedConnectionsError(errorMessage(error, 'Could not remove this connection.'))
      return
    }
    connectionSelection.current++
    setOpeningConnectionId('')
    setSavedConnectionsError('')
    setTabs((current) => current.map((tab) => tab.connectionId === connection.id ? { ...tab, database: { ...tab.database, id: '' } } : tab))
    if (selectedConnectionId === connection.id) { setActiveTabId(''); setShowSql(false) }
    const remaining = connections.filter((item) => item.id !== connection.id)
    setConnections((current) => current.filter((item) => item.id !== connection.id))
    if (selectedConnectionId === connection.id) {
      setSelectedConnectionId('')
      setSelectedDatabase({ name: '', id: '' })
      setSelectedTable(null)
      setPageOffset(0)
      setRowSearch('')
      if (remaining[0]) void openConnection(remaining[0].id)
    }
  }

  useLayoutEffect(() => {
    if (activeTabId && !showSql && selectedTable) tableTabState.current[activeTabId] = { offset: pageOffset, size: pageSize, search: rowSearch, view, query: tableQuery }
  }, [activeTabId, showSql, selectedTable, pageOffset, pageSize, rowSearch, view, tableQuery])

  useEffect(() => {
    if (!scriptRefreshPending || hasPendingChanges || savingChanges || pendingNavigation) return
    setScriptRefreshPending(false)
    setRefreshKey((value) => value + 1)
  }, [scriptRefreshPending, hasPendingChanges, savingChanges, pendingNavigation])

  const activateTab = (tab: WorkspaceTab) => {
    connectionSelection.current++
    setOpeningConnectionId('')
    if (activeTabId === tab.id && tab.database.id) return
    if (!tab.database.id) {
      if (!connections.some((connection) => connection.id === tab.connectionId)) { setWorkspaceError('The saved connection for this workspace is unavailable. Your drafts are preserved.'); return }
      const request = ++connectionSelection.current
      setOpeningConnectionId(tab.connectionId)
      void PostgresService.OpenDatabase(tab.connectionId, tab.database.name).then((handle) => {
        if (request !== connectionSelection.current) return
        const currentTab = tabsRef.current.find((item) => item.id === tab.id)
        if (!currentTab) return
        const reopened = { ...currentTab, database: { ...currentTab.database, id: handle } }
        setTabs((current) => current.map((item) => item.id === tab.id ? reopened : item)); setWorkspaceError(''); setSavedConnectionsError(''); activateResolvedTab(reopened)
      }).catch((error: unknown) => { if (request === connectionSelection.current) setWorkspaceError(errorMessage(error, 'Could not reopen this database. Your draft is preserved.')) }).finally(() => { if (request === connectionSelection.current) setOpeningConnectionId('') })
      return
    }
    activateResolvedTab(tab)
  }

  const activateResolvedTab = (tab: WorkspaceTab) => {
    const saved = tableTabState.current[tab.id]
    setSelectedConnectionId(tab.connectionId)
    setSelectedDatabase(tab.database)
    setSelectedTable(tab.table ?? null)
    setShowSql(tab.kind === 'script')
    setActiveTabId(tab.id)
    setPageOffset(saved?.offset ?? 0)
    setPageSize(saved?.size ?? 100)
    setRowSearch(saved?.search ?? '')
    setView(saved?.view ?? 'data')
    setTableQuery(saved?.query ?? emptyTableQuery())
    setMobileNavOpen(false)
  }

  const openTableTab = (connectionId: string, database: { id: string; name: string }, table: TableInfo) => {
    const existing = tabs.find((tab) => tab.kind === 'table' && tab.connectionId === connectionId && tab.database.name === database.name && tab.table?.schema === table.schema && tab.table.name === table.name)
    const tab: WorkspaceTab = existing ?? { id: crypto.randomUUID(), kind: 'table', connectionId, database, table, title: table.name }
    if (!existing) setTabs((current) => [...current, tab])
    activateTab(tab)
  }

  const selectTable = (table: TableInfo) => guardNavigation(() => showTable(table))
  const showTable = (table: TableInfo) => openTableTab(selectedConnectionId, selectedDatabase, table)
  const newScript = () => guardNavigation(() => {
    const number = ++nextScriptId.current
    const tab: WorkspaceTab = { id: crypto.randomUUID(), kind: 'script', connectionId: selectedConnectionId, database: selectedDatabase, title: `Script ${number}` }
    setTabs((current) => [...current, tab])
    activateTab(tab)
  })
  const openScriptContent = (name: string, content: string, path = '', connectionId = selectedConnectionId, database = selectedDatabase) => {
    const tab: WorkspaceTab = { id: crypto.randomUUID(), kind: 'script', connectionId, database, title: name, path, savedContent: path ? content : undefined }
    setTabs((current) => [...current, tab]); setSqlDrafts((current) => ({ ...current, [tab.id]: content })); activateTab(tab)
  }
  const fileService = PostgresService as typeof PostgresService & { OpenSQLFile?: () => Promise<{ path: string; name: string; content: string }>; SaveSQLFile?: (path: string, name: string, content: string) => Promise<{ path: string; name: string; content: string }> }
  const openScript = async () => {
    if (!fileService.OpenSQLFile) { fileInput.current?.click(); return }
    try { const file = await fileService.OpenSQLFile(); if (file?.path) guardNavigation(() => openScriptContent(file.name, file.content, file.path)) }
    catch (error) { setWorkspaceError(errorMessage(error, 'Could not open the script.')) }
  }
  const saveScript = async (tab: WorkspaceTab) => {
    const content = sqlDrafts[tab.id] ?? ''
    try {
      if (fileService.SaveSQLFile) {
        const file = await fileService.SaveSQLFile(tab.path ?? '', tab.title, content)
        if (!file?.path) return
        setTabs((current) => current.map((item) => item.id === tab.id ? { ...item, path: file.path, title: tab.path ? item.title : file.name, savedContent: content } : item))
      } else {
        const url = URL.createObjectURL(new Blob([content], { type: 'application/sql' })); const link = document.createElement('a'); link.href = url; link.download = tab.title.endsWith('.sql') ? tab.title : `${tab.title}.sql`; link.click(); URL.revokeObjectURL(url)
        setTabs((current) => current.map((item) => item.id === tab.id ? { ...item, savedContent: content } : item))
      }
      setWorkspaceError('')
    } catch (error) { setWorkspaceError(errorMessage(error, 'Could not save the script.')) }
  }
  const renameScript = (tab: WorkspaceTab) => { setScriptName(tab.title); setRenamingScript(tab) }
  const openHistoryEntry = (entry: HistoryEntry) => guardNavigation(() => {
    setShowHistory(false)
    openScriptContent('History query', entry.sql, '', entry.connectionId, { name: entry.databaseName, id: '' })
  })
  const closeTab = (tab: WorkspaceTab, confirmed = false) => {
    if (runningScripts.has(tab.id)) return
    if (tab.kind === 'script' && (sqlDrafts[tab.id] ?? '') !== (tab.savedContent ?? '') && !confirmed) { setScriptToClose(tab); return }
    const close = () => {
      connectionSelection.current++
      setOpeningConnectionId('')
      const index = tabs.findIndex((item) => item.id === tab.id)
      const remaining = tabs.filter((item) => item.id !== tab.id)
      setTabs(remaining)
      delete tableTabState.current[tab.id]
      setSqlDrafts((drafts) => { const next = { ...drafts }; delete next[tab.id]; return next })
      if (activeTabId === tab.id) {
        const next = remaining[Math.min(index, remaining.length - 1)]
        if (next) activateTab(next)
        else { setActiveTabId(''); setShowSql(false); setSelectedTable(null) }
      }
    }
    if (activeTabId === tab.id) guardNavigation(close)
    else close()
  }

  useEffect(() => {
    document.getElementById(`workspace-tab-${activeTabId}`)?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
  }, [activeTabId])

  useEffect(() => {
    try { localStorage.setItem('hyperpg-shortcuts', JSON.stringify(shortcuts)) } catch { /* Settings remain available for this session. */ }
  }, [shortcuts])

  useEffect(() => {
    const onShortcut = (event: KeyboardEvent) => {
      if (event.isComposing) return
      const pressed = shortcutFromEvent(event)
      const action = (Object.keys(shortcutLabels) as ShortcutAction[]).find((key) => shortcuts[key] && shortcuts[key] === pressed)
      if (!action) return
      event.preventDefault()
      if (showSettingsDialog || showConnectionDialog || pendingNavigation || scriptToClose || showHistory || renamingScript || event.repeat) return
      if (action === 'refresh' && !activeConnection || action === 'closeTab' && !activeTabId || action === 'newScript' && !activeConnection || action === 'runScript' && !showSql || action === 'saveChanges' && (showSql || !selectedTable || !hasPendingChanges || savingChanges)) return
      if (action === 'refresh') guardNavigation(() => setRefreshKey((value) => value + 1))
      else if (action === 'closeTab') { const tab = tabs.find((item) => item.id === activeTabId); if (tab) closeTab(tab) }
      else if (action === 'newScript') newScript()
      else if (action === 'saveChanges') void gridRef.current?.save()
      else if (action === 'runScript') window.dispatchEvent(new Event('hyperpg-run-script'))
      else openSettingsDialog()
    }
    window.addEventListener('keydown', onShortcut, true)
    return () => window.removeEventListener('keydown', onShortcut, true)
  })

  const recordShortcut = (event: ReactKeyboardEvent<HTMLButtonElement>, action: ShortcutAction) => {
    event.preventDefault()
    event.stopPropagation()
    if (event.key === 'Escape') { setRecordingShortcut(null); setShortcutError(''); return }
    const value = shortcutFromEvent(event)
    if (!value) return
    if (!event.ctrlKey && !event.altKey && !event.metaKey && !/^F([1-9]|1[0-2])$/.test(event.key)) { setShortcutError('Use a modifier or a function key.'); return }
    if ((event.ctrlKey || event.metaKey) && ['a', 'c', 'v', 'x', 'z', 'y'].includes(event.key.toLowerCase())) { setShortcutError('Reserved for text editing.'); return }
    const conflict = (Object.keys(shortcutLabels) as ShortcutAction[]).find((key) => key !== action && shortcuts[key] === value)
    if (conflict) { setShortcutError(`${value} is assigned to ${shortcutLabels[conflict]}.`); return }
    setShortcuts((current) => ({ ...current, [action]: value }))
    setRecordingShortcut(null)
    setShortcutError('')
  }

  return (
    <div className={`app-shell ${resizingSidebar ? 'is-resizing-sidebar' : ''}`} style={{ '--sidebar-width': `${sidebarWidth}px` } as CSSProperties}>
      <aside className={`sidebar ${mobileNavOpen ? 'is-mobile-open' : ''}`} id="database-sidebar">
        <div className="app-brand">
          <img src="/hyperpg.svg" width="28" height="28" alt="" />
          <span>HyperPG</span>
        </div>
        <div className="sidebar-section-heading">
          <span>Connections</span>
          <button className="icon-button add-connection" type="button" onClick={openConnectionDialog} aria-label="Add a database connection" title="Add connection">
            <Icon name="plus" />
          </button>
        </div>

        {connections.length === 0 ? (
          <button className="sidebar-empty" type="button" onClick={openConnectionDialog}>
            <span className="empty-symbol">＋</span>
            <span>Add a database</span>
          </button>
        ) : (
          <ConnectionTree
            connections={connections} selectedConnectionId={selectedConnectionId}
            selectedDatabase={selectedDatabase.name} selectedTable={selectedTable}
            openingConnectionId={openingConnectionId} refreshKey={refreshKey} revisions={connectionRevisions}
            onSelectConnection={selectConnection} onSelectDatabase={selectDatabase}
            onEdit={editConnection} onDelete={removeConnection}
          />
        )}

        <div className="sidebar-bottom">
          <button className="settings-button" type="button" onClick={openSettingsDialog}>
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
        aria-valuemax={sidebarMaxWidth}
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
            {activeConnection ? <><span className="crumb-muted">{activeConnection.name}</span><svg viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="m6 3 5 5-5 5" /></svg><span className={selectedTable ? 'crumb-muted' : 'crumb-current'}>{selectedDatabase.name}</span>{selectedTable ? <><svg viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="m6 3 5 5-5 5" /></svg><span className="crumb-muted">{selectedTable.schema}</span><svg viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="m6 3 5 5-5 5" /></svg><span className="crumb-current">{selectedTable.name}</span></> : null}</> : null}
          </div>
          <div className="topbar-right">
            {activeConnection ? <><button className="topbar-add" type="button" onClick={newScript}>New SQL script</button><button className="topbar-add" type="button" onClick={() => void openScript()}>Open SQL</button></> : null}
            <button className="topbar-add" type="button" onClick={() => setShowHistory(true)}>Query history</button>
            <input ref={fileInput} type="file" accept=".sql,text/plain,application/sql" hidden onChange={(event) => { const file = event.currentTarget.files?.[0]; event.currentTarget.value = ''; if (file) void file.text().then((content) => guardNavigation(() => openScriptContent(file.name, content))).catch((error: unknown) => setWorkspaceError(errorMessage(error, 'Could not open the script.'))) }} />
            <button className="topbar-add" type="button" onClick={openConnectionDialog}><Icon name="plus" /> Add connection</button>
          </div>
        </header>

        {activeConnection || tabs.length ? (
          <div className="content-area">
            {savedConnectionsError || workspaceError ? <div className="notice notice-error compact-notice" role="alert">{savedConnectionsError || workspaceError}</div> : null}
            {tabs.length ? <div className="editor-tab-bar" role="tablist" aria-label="Open workspaces" onKeyDown={handleTableViewKeyDown}>{tabs.map((tab) => <div className={`editor-tab ${activeTabId === tab.id ? 'is-active' : ''}`} key={tab.id}>
              <button type="button" className="editor-tab-select" role="tab" id={`workspace-tab-${tab.id}`} aria-controls={`workspace-panel-${tab.id}`} aria-selected={activeTabId === tab.id} tabIndex={activeTabId === tab.id || (!activeTabId && tabs[0]?.id === tab.id) ? 0 : -1} aria-current={activeTabId === tab.id ? 'page' : undefined} title={`${tab.database.name}${tab.table ? ` · ${tab.table.schema}` : ''}`} onClick={() => { if (activeTabId !== tab.id || !tab.database.id) guardNavigation(() => activateTab(tab)) }}><Icon name={tab.kind === 'table' ? 'table' : 'edit'} /><span>{tab.title}</span></button>
              <button type="button" className="editor-tab-close" disabled={runningScripts.has(tab.id)} aria-label={`Close ${tab.title}`} onClick={() => closeTab(tab)}>×</button>
            </div>)}</div> : null}
            {tabs.filter((tab) => tab.kind === 'script').map((tab) => <div key={tab.id} className="script-tab-panel" id={`workspace-panel-${tab.id}`} role="tabpanel" aria-labelledby={`workspace-tab-${tab.id}`} hidden={activeTabId !== tab.id}><div className="script-file-actions"><button type="button" onClick={() => void saveScript(tab)}>Save SQL</button><button type="button" onClick={() => renameScript(tab)}>Rename</button><span>{(sqlDrafts[tab.id] ?? '') !== (tab.savedContent ?? '') ? 'Unsaved changes' : tab.path ? 'Saved' : ''}</span></div><Suspense fallback={<span role="status">Loading editor…</span>}><SqlEditor onRunningChange={(running) => setRunningScripts((current) => { const next = new Set(current); if (running) next.add(tab.id); else next.delete(tab.id); return next })} active={activeTabId === tab.id && !showSettingsDialog} databaseId={tab.database.id} databaseName={tab.database.name} script={sqlDrafts[tab.id] ?? ''} onScriptChange={(script) => setSqlDrafts((drafts) => ({ ...drafts, [tab.id]: script }))} onExecuted={() => setScriptRefreshPending(true)} onHistory={(entry) => setHistory((current) => [{ ...entry, id: crypto.randomUUID(), connectionId: tab.connectionId, databaseName: tab.database.name }, ...current].slice(0, 200))} /></Suspense></div>)}
            {!showSql && activeConnection ? <>
            {!selectedTable ? <section className="database-header">
              <div>
                <h1>{selectedDatabase.name}</h1>
                <div className="database-meta">{activeConnection.name}<span className="meta-divider" />{activeConnection.host}<span className="meta-divider" />{tables.length} tables</div>
              </div>
              <button className="quiet-action" type="button" aria-label="Refresh" title="Refresh" onClick={() => guardNavigation(() => setRefreshKey((value) => value + 1))}>
                <svg viewBox="0 0 18 18" fill="none" aria-hidden="true"><path d="M14.8 5.1A6.5 6.5 0 1 0 15.5 9M14.8 5.1V1.8M14.8 5.1h-3.3" /></svg>
              </button>
            </section> : null}



            <section id={activeTabId ? `workspace-panel-${activeTabId}` : undefined} role={activeTabId ? 'tabpanel' : undefined} aria-labelledby={activeTabId ? `workspace-tab-${activeTabId}` : undefined} className={`workspace-section ${selectedTable ? 'has-selected-table' : ''}`}>
              <div className="workspace-tabs">
                {selectedTable ? <div className="workspace-identity">
                  <span className="workspace-table-icon"><Icon name="table" /></span>
                  <div><h1 title={selectedTable.name}>{selectedTable.name}</h1><span>{selectedTable.schema} schema{tableData ? ` · ${tableData.columns.length} columns` : ''}</span></div>
                </div> : null}
                {selectedTable ? <div className="view-switcher" role="tablist" aria-label="Table view" onKeyDown={handleTableViewKeyDown}>
                  <button id="table-view-data-tab" type="button" role="tab" aria-controls="table-view-panel" aria-selected={view === 'data'} tabIndex={view === 'data' ? 0 : -1} className={view === 'data' ? 'is-selected' : ''} onClick={() => setView('data')}>Data</button>
                  <button id="table-view-structure-tab" type="button" role="tab" aria-controls="table-view-panel" aria-selected={view === 'structure'} tabIndex={view === 'structure' ? 0 : -1} className={view === 'structure' ? 'is-selected' : ''} onClick={() => guardNavigation(() => setView('structure'))}>Structure</button>
                </div> : null}
                {selectedTable ? <button className="quiet-action workspace-refresh" type="button" aria-label="Refresh" title="Refresh" disabled={tableBusy || savingChanges} onClick={() => guardNavigation(() => setRefreshKey((value) => value + 1))}>
                  <svg viewBox="0 0 18 18" fill="none" aria-hidden="true"><path d="M14.8 5.1A6.5 6.5 0 1 0 15.5 9M14.8 5.1V1.8M14.8 5.1h-3.3" /></svg>
                </button> : null}
              </div>

              {!selectedTable ? (
                <div className="overview-content">
                  <div className="overview-intro">
                    <div>
                      <h2>Explore your database</h2>
                      <p>Select a table to browse its data and structure.</p>
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
                <div className="table-workspace" id="table-view-panel" role="tabpanel" aria-labelledby={view === 'data' ? 'table-view-data-tab' : 'table-view-structure-tab'} tabIndex={0}>
                  {tableError ? <div className="notice notice-error" role="alert">{tableError}</div> : null}
                  {view === 'data' ? <>
                    <TableQueryControls key={activeTabId} columns={tableData?.columns.map((column) => column.name) ?? []} value={tableQuery} disabled={tableBusy || savingChanges} onApply={(query) => guardNavigation(() => { setTableQuery(query); setPageOffset(0); setRowSearch('') })} />
                    {tableData ? <DataGrid
                      key={`${selectedDatabase.id}:${selectedTable.schema}:${selectedTable.name}:${pageOffset}:${cachedPage!.refreshKey}:${queryKey}`}
                      ref={gridRef} data={tableData} connectionID={selectedDatabase.id} schema={selectedTable.schema} table={selectedTable.name}
                      queryOptions={tableQuery} onSort={(column) => guardNavigation(() => { const previous = tableQuery.sort[0]; const direction = previous?.column === column && previous.direction === 'ASC' ? 'DESC' : 'ASC'; setTableQuery({ ...tableQuery, sort: [{ column, direction }] }); setPageOffset(0) })}
                      pageOffset={pageOffset} loading={tableBusy} readOnly={tableStale} selectionVersion={tableSelectionVersion} search={rowSearch} onSearchChange={setRowSearch} onDirtyChange={handleDirtyChange} onSavingChange={setSavingChanges}
                      onSaved={(rowCountDelta) => {
                        const remainingCount = Math.max(0, tableData.rowCount + rowCountDelta)
                        setPageOffset((offset) => Math.min(offset, Math.max(0, Math.ceil(remainingCount / pageSize) - 1) * pageSize))
                        setRefreshKey((value) => value + 1)
                      }}
                    /> : tableBusy ? <div className="table-loading"><span className="spinner" />Loading rows…</div> : null}
                    {tableData ? <div className="grid-pagination">
                      <label className="page-size-control"><span>Rows per page</span><select aria-label="Rows per page" value={pageSize} disabled={savingChanges || tableStale} onChange={(event) => { const size = Number(event.target.value); guardNavigation(() => { setTableError(''); setPageSize(size) }) }}>
                        {[25, 50, 100, 250, 500].map((size) => <option key={size} value={size}>{size}</option>)}
                      </select></label>
                      <span className="pagination-range">{pageStart.toLocaleString()}–{pageEnd.toLocaleString()} of {tableData.rowCount.toLocaleString()} rows</span>
                      <div className="pagination-actions">
                        <button className="pagination-button" type="button" aria-label="Start page" disabled={tableBusy || tableStale || savingChanges || pageOffset === 0} onClick={() => guardNavigation(() => setPageOffset(0))}><Icon name="chevrons-left" />Start</button>
                        <button className="pagination-button" type="button" aria-label="Previous page" disabled={tableBusy || tableStale || savingChanges || pageOffset === 0} onClick={() => guardNavigation(() => setPageOffset((offset) => Math.max(0, offset - pageSize)))}><Icon name="chevron-left" />Previous</button>
                        <button className="pagination-button" type="button" aria-label="Next page" disabled={tableBusy || tableStale || savingChanges || pageOffset + pageSize >= tableData.rowCount} onClick={() => guardNavigation(() => setPageOffset((offset) => offset + pageSize))}>Next<Icon name="chevron-right" /></button>
                        <button className="pagination-button" type="button" aria-label="End page" disabled={tableBusy || tableStale || savingChanges || pageOffset >= lastPageOffset} onClick={() => guardNavigation(() => setPageOffset(lastPageOffset))}>End<Icon name="chevrons-right" /></button>
                      </div>
                    </div> : null}
                  </> : <>
                    <div className="structure-intro"><h3>Columns</h3><span>{tableData?.columns.length ?? 0} total</span></div>
                    {tableBusy && !tableData ? (
                      <div className="table-loading"><span className="spinner" />Loading structure…</div>
                    ) : tableData ? (
                      <div className="structure-table-wrap">
                        <table className="structure-table" aria-label="Column structure">
                          <thead><tr>
                            <th scope="col">Column</th><th scope="col">Type</th><th scope="col">Nullable</th>
                            <th scope="col">Default</th><th scope="col">Generated</th><th scope="col">Auto increment</th>
                          </tr></thead>
                          <tbody>{tableData.columns.map((column, index) => (
                            <tr key={column.name}>
                              <td><span className="column-order">{String(index + 1).padStart(2, '0')}</span><strong>{column.name}</strong></td>
                              <td><code>{column.dataType}</code></td>
                              <td><span className="structure-value">{column.nullable ? 'Yes' : 'No'}</span></td>
                              <td>
                                {column.defaultValue ? <code className="structure-expression" title={column.defaultValue}>{column.defaultValue}</code>
                                  : column.identityGeneration ? <span className="structure-value">Identity</span>
                                    : <span className="structure-empty">—</span>}
                              </td>
                              <td>
                                {column.generated && !column.identityGeneration
                                  ? column.generationExpression
                                    ? <code className="structure-expression" title={column.generationExpression}>{column.generationExpression}</code>
                                    : <span className="structure-value">Always</span>
                                  : <span className="structure-empty">—</span>}
                              </td>
                              <td>
                                {column.identityGeneration ? <span className="structure-value">Identity · {column.identityGeneration.toLowerCase()}</span>
                                  : column.autoIncrement ? <span className="structure-value">Sequence</span>
                                    : <span className="structure-empty">—</span>}
                              </td>
                            </tr>
                          ))}</tbody>
                        </table>
                      </div>
                    ) : null}
                    <TableDetails key={`${selectedDatabase.id}:${selectedTable.schema}:${selectedTable.name}`} databaseId={selectedDatabase.id} schema={selectedTable.schema} table={selectedTable.name} onScript={(sql, title) => guardNavigation(() => openScriptContent(title, sql))} />
                  </>}
                  <div className="table-statusbar">
                    <span className="table-status-metrics" title="Fetched rows on this page; size is the estimated UTF-8 JSON size of row values, excluding metadata and network overhead.">{tableData ? `${tableData.rows.length.toLocaleString()} ${tableData.rows.length === 1 ? 'row' : 'rows'} · ~${formatBytes(loadedBytes)}` : '—'}</span>
                    <span className="table-status-activity" role="status" aria-live="polite">{tableActivity ? `${tableActivity}…` : tableStale && tableError ? 'Refresh failed' : ''}</span>
                  </div>
                </div>
              )}
            </section>
            </> : null }
          </div>
        ) : (
          <div className="welcome-area">
            <div className="welcome-content">
              {savedConnectionsError || workspaceError ? <div className="notice notice-error compact-notice" role="alert">{savedConnectionsError || workspaceError}</div> : null}
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
              <button className="welcome-cta" type="button" onClick={openConnectionDialog}><Icon name="plus" /> Add a connection</button>
            </div>
          </div>
        )}
      </main>

      {updateInfo && (updateInfo.available || updateInstallError) && dismissedUpdate !== (updateInfo.version || 'update-error') && !showSettingsDialog && !showConnectionDialog ? <aside className={`update-alert ${updateInstallError ? 'has-error' : ''}`} role="alert">
        <span className="update-alert-mark" aria-hidden="true"><svg viewBox="0 0 18 18" fill="none"><path d="M9 2.2v8.2m0 3.4v.1M4.2 15.3h9.6" /><path d="m5.7 6.4 3.3-3.3 3.3 3.3" /></svg></span>
        <span className="update-alert-copy"><strong>{updateInstallError ? 'Update failed' : 'Update available'}</strong><small>{updateInstallError || `${updateInfo.version} · ${updateChannel === 'stable' ? 'Stable' : 'Nightly'}`}</small></span>
        <button className="update-now-button" type="button" onClick={() => guardNavigation(() => { void handleInstallUpdate() })} disabled={installingUpdate || !updateInfo.available}>{installingUpdate ? <><span className="button-spinner" />{updateRestarting ? 'Opening installer…' : 'Updating…'}</> : updateInfo.available ? 'Update now' : 'Update unavailable'}</button>
        <button className="update-dismiss" type="button" aria-label="Dismiss update notice" onClick={() => setDismissedUpdate(updateInfo.version || 'update-error')}><svg viewBox="0 0 18 18" fill="none"><path d="m4 4 10 10M14 4 4 14" /></svg></button>
      </aside> : null}

      {renamingScript ? <div className="modal-backdrop" role="presentation"><section className="connection-dialog" role="dialog" aria-modal="true" aria-labelledby="rename-title"><div className="dialog-heading"><h2 id="rename-title">Rename script</h2></div><form onSubmit={(event) => { event.preventDefault(); const title = scriptName.trim(); if (!title) return; setTabs((current) => current.map((tab) => tab.id === renamingScript.id ? { ...tab, title } : tab)); setRenamingScript(null) }}><label className="field-label" htmlFor="script-name">Script name</label><input id="script-name" className="dialog-input" autoFocus value={scriptName} onChange={(event) => setScriptName(event.target.value)} /><div className="dialog-actions"><button type="button" className="cancel-button" onClick={() => setRenamingScript(null)}>Cancel</button><button type="submit" className="connect-button" disabled={!scriptName.trim()}>Rename</button></div></form></section></div> : null}
      {showHistory ? <div className="modal-backdrop" role="presentation"><section className="connection-dialog history-dialog" role="dialog" aria-modal="true" aria-labelledby="history-title">
        <div className="dialog-heading"><h2 id="history-title">Query history</h2></div>
        <input className="dialog-input" aria-label="Search query history" autoFocus placeholder="Search SQL or database" value={historySearch} onChange={(event) => setHistorySearch(event.target.value)} />
        <div className="history-list">{history.filter((entry) => `${entry.sql} ${entry.databaseName}`.toLowerCase().includes(historySearch.toLowerCase())).map((entry) => <article className="history-entry" key={entry.id}><button type="button" className="history-open" onClick={() => openHistoryEntry(entry)}><code>{entry.sql}</code><small>{entry.databaseName} · {new Date(entry.executedAt).toLocaleString()} · {Math.round(entry.durationMs)} ms · {entry.error ? 'Failed' : 'Succeeded'}</small></button><button type="button" aria-label="Delete history entry" onClick={() => setHistory((current) => current.filter((item) => item.id !== entry.id))}>×</button></article>)}{history.length === 0 ? <p>No queries yet.</p> : null}</div>
        <div className="dialog-actions"><button type="button" className="cancel-button" disabled={!history.length} onClick={() => setHistory([])}>Clear history</button><button type="button" className="connect-button" onClick={() => setShowHistory(false)}>Done</button></div>
      </section></div> : null}

      {scriptToClose ? <div className="modal-backdrop" role="presentation">
        <section className="connection-dialog" role="dialog" aria-modal="true" aria-labelledby="close-script-title">
          <div className="dialog-heading"><h2 id="close-script-title">Close {scriptToClose.title}?</h2></div>
          <p>The script and results will be discarded.</p>
          <div className="dialog-actions"><button type="button" className="cancel-button" autoFocus onClick={() => setScriptToClose(null)}>Keep editing</button><button type="button" className="connect-button" onClick={() => { closeTab(scriptToClose, true); setScriptToClose(null) }}>Close script</button></div>
        </section>
      </div> : null}

      {pendingNavigation ? <div className="modal-backdrop" role="presentation">
        <section className="connection-dialog unsaved-dialog" role="dialog" aria-modal="true" aria-labelledby="unsaved-title" onKeyDown={(event) => {
          if (event.key === 'Escape' && !savingChanges) setPendingNavigation(null)
          if (event.key === 'Tab') {
            const buttons = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')]
            const first = buttons[0], last = buttons[buttons.length - 1]
            if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus() }
            else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus() }
          }
        }}>
          <div className="dialog-heading"><h2 id="unsaved-title">Unsaved changes</h2></div>
          <p>Save your table changes before continuing, or discard the draft.</p>
          <div className="dialog-actions">
            <button type="button" className="cancel-button" autoFocus disabled={savingChanges} onClick={() => setPendingNavigation(null)}>Keep editing</button>
            <button type="button" className="cancel-button" disabled={savingChanges} onClick={() => void resolveNavigation(false)}>Discard and continue</button>
            <button type="button" className="connect-button" disabled={savingChanges} onClick={() => void resolveNavigation(true)}>{savingChanges ? 'Saving…' : 'Save and continue'}</button>
          </div>
          {tableError ? <div role="alert">{tableError}</div> : null}
        </section>
      </div> : null}

      {showConnectionDialog ? <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget && !connecting) setShowConnectionDialog(false) }}>
        <section className="connection-dialog" role="dialog" aria-modal="true" aria-labelledby="dialog-title">
          <button className="dialog-close" type="button" aria-label="Close" onClick={() => setShowConnectionDialog(false)} disabled={connecting}><svg viewBox="0 0 18 18" fill="none"><path d="m4 4 10 10M14 4 4 14" /></svg></button>
          <div className="dialog-icon"><DatabaseIcon /></div>
          <div className="dialog-heading"><h2 id="dialog-title">{editingConnectionId ? 'Edit connection' : 'New connection'}</h2></div>
          <form onSubmit={handleConnect}>
            <label className="field-label" htmlFor="connection-name">Connection name <span>Optional</span></label>
            <input id="connection-name" className="dialog-input" value={connectionName} onChange={(event) => setConnectionName(event.target.value)} placeholder="e.g. Production" autoComplete="off" disabled={connecting} />
            <label className="field-label connection-url-label" htmlFor="connection-url">Database URL</label>
            <div className="url-input-wrap"><input id="connection-url" className="dialog-input url-input" value={connectionUrl} onChange={(event) => setConnectionUrl(event.target.value)} placeholder={editingConnectionId ? 'Leave blank to keep the saved URL' : 'postgresql://user:password@host:5432/dbname'} type={showUrl ? 'text' : 'password'} autoComplete="off" autoFocus required={!editingConnectionId} disabled={connecting} aria-describedby={editingConnectionId ? 'connection-url-hint' : undefined} /><button className="reveal-url" type="button" disabled={connecting} onClick={() => setShowUrl((visible) => !visible)} aria-label={showUrl ? 'Hide URL' : 'Show URL'}>{showUrl ? <svg viewBox="0 0 20 20" fill="none"><path d="M3 3 17 17M8.6 8.7a2 2 0 0 0 2.7 2.7M7.1 5.3A9.8 9.8 0 0 1 10 4.8c4.6 0 7.5 4.1 8 5.2-.2.5-1 1.8-2.4 2.9M5.2 6.7C3.5 7.8 2.4 9.5 2 10c.5 1.1 3.4 5.2 8 5.2 1 0 1.9-.2 2.7-.6" /></svg> : <svg viewBox="0 0 20 20" fill="none"><path d="M2 10s2.8-5.2 8-5.2 8 5.2 8 5.2-2.8 5.2-8 5.2S2 10 2 10Z" /><circle cx="10" cy="10" r="2.2" /></svg>}</button></div>
            {editingConnectionId ? <p className="field-hint" id="connection-url-hint">Leave blank to keep the saved URL.</p> : null}
            <label className="connection-option" htmlFor="show-all-databases">
              <input id="show-all-databases" type="checkbox" checked={showAllDatabases} onChange={(event) => setShowAllDatabases(event.target.checked)} disabled={connecting} aria-labelledby="show-all-databases-label" aria-describedby="show-all-databases-hint" />
              <span><strong id="show-all-databases-label">Show all databases</strong><small id="show-all-databases-hint">Turn off to show only the database in the URL.</small></span>
            </label>
            {connectionError ? <div className="form-error" role="alert"><svg viewBox="0 0 18 18" fill="none"><circle cx="9" cy="9" r="6.7" /><path d="M9 5.5v4M9 12.1v.1" /></svg>{connectionError}</div> : null}
            <div className="dialog-note"><svg viewBox="0 0 18 18" fill="none"><path d="M9 2.2 3.2 4.5v4.1c0 3.3 2.5 5.9 5.8 7.2 3.3-1.3 5.8-3.9 5.8-7.2V4.5L9 2.2Z" /><path d="m6.4 8.8 1.7 1.7 3.6-3.7" /></svg><span>Saved securely on this device.</span></div>
            <div className="dialog-actions"><button className="cancel-button" type="button" onClick={() => setShowConnectionDialog(false)} disabled={connecting}>Cancel</button><button className="connect-button" type="submit" disabled={connecting || !editingConnectionId && !connectionUrl.trim()}>{connecting ? <><span className="button-spinner" />{editingConnectionId ? 'Saving' : 'Connecting'}</> : editingConnectionId ? 'Save connection' : 'Connect database'}</button></div>
          </form>
        </section>
      </div> : null}

      {showSettingsDialog ? <div className="modal-backdrop settings-page-backdrop" role="presentation">
        <section className="connection-dialog settings-dialog settings-page" role="dialog" aria-modal="true" aria-labelledby="settings-title">
          <button className="dialog-close" type="button" aria-label="Close settings" onClick={() => setShowSettingsDialog(false)}><svg viewBox="0 0 18 18" fill="none"><path d="m4 4 10 10M14 4 4 14" /></svg></button>
          <div className="dialog-heading"><h2 id="settings-title">Settings</h2></div>
          <div className="settings-layout"><nav className="settings-nav" aria-label="Settings categories">
            {(['appearance', 'shortcuts', 'updates'] as const).map((category) => <button type="button" key={category} className={settingsCategory === category ? 'is-active' : ''} aria-current={settingsCategory === category ? 'page' : undefined} onClick={() => { setSettingsCategory(category); setRecordingShortcut(null); setShortcutError('') }}>{category === 'appearance' ? 'Appearance' : category === 'shortcuts' ? 'Keyboard shortcuts' : 'Updates'}</button>)}
          </nav><div className="settings-content">
          <div hidden={settingsCategory !== 'appearance'}><div className="settings-section">
            <span className="field-label">Appearance</span>
            <div className="theme-options" role="radiogroup" aria-label="Color theme">
              <button className={`theme-option ${theme === 'light' ? 'is-selected' : ''}`} type="button" role="radio" aria-checked={theme === 'light'} tabIndex={theme === 'light' ? 0 : -1} onKeyDown={(event) => handleRadioGroupKeyDown(event, themeValues, theme, setTheme)} onClick={() => setTheme('light')}>
                <span className="theme-preview theme-preview-light"><i /><i /><i /><b /></span>
                <span className="theme-option-copy"><strong>Light</strong></span>
                <span className="theme-radio" />
              </button>
              <button className={`theme-option ${theme === 'cream' ? 'is-selected' : ''}`} type="button" role="radio" aria-checked={theme === 'cream'} tabIndex={theme === 'cream' ? 0 : -1} onKeyDown={(event) => handleRadioGroupKeyDown(event, themeValues, theme, setTheme)} onClick={() => setTheme('cream')}>
                <span className="theme-preview theme-preview-cream"><i /><i /><i /><b /></span>
                <span className="theme-option-copy"><strong>Cream</strong></span>
                <span className="theme-radio" />
              </button>
              <button className={`theme-option ${theme === 'dark' ? 'is-selected' : ''}`} type="button" role="radio" aria-checked={theme === 'dark'} tabIndex={theme === 'dark' ? 0 : -1} onKeyDown={(event) => handleRadioGroupKeyDown(event, themeValues, theme, setTheme)} onClick={() => setTheme('dark')}>
                <span className="theme-preview theme-preview-dark"><i /><i /><i /><b /></span>
                <span className="theme-option-copy"><strong>Dark</strong></span>
                <span className="theme-radio" />
              </button>
              <button className={`theme-option ${theme === 'discord' ? 'is-selected' : ''}`} type="button" role="radio" aria-checked={theme === 'discord'} tabIndex={theme === 'discord' ? 0 : -1} onKeyDown={(event) => handleRadioGroupKeyDown(event, themeValues, theme, setTheme)} onClick={() => setTheme('discord')}>
                <span className="theme-preview theme-preview-discord"><i /><i /><i /><b /></span>
                <span className="theme-option-copy"><strong>Discord</strong></span>
                <span className="theme-radio" />
              </button>
            </div>
          </div>
          <div className="settings-section font-size-section">
            <label className="field-label" htmlFor="font-size-control">Font size</label>
            <div className="font-size-control-row">
              <input id="font-size-control" className="font-size-control" type="range" min={MIN_FONT_SIZE_PX} max={MAX_FONT_SIZE_PX} step="1" value={fontSizePx} onChange={(event) => setFontSizePx(Number(event.currentTarget.value))} aria-valuetext={`${fontSizePx} pixels`} />
              <output className="font-size-value" htmlFor="font-size-control">{fontSizePx} px</output>
            </div>
            <div className="font-size-range-labels" aria-hidden="true"><span>{MIN_FONT_SIZE_PX} px</span><span>{MAX_FONT_SIZE_PX} px</span></div>
          </div>
          </div>
          <div hidden={settingsCategory !== 'shortcuts'} className="shortcut-settings"><h3>Keyboard shortcuts</h3>
            {(Object.keys(shortcutLabels) as ShortcutAction[]).map((action) => <div className="shortcut-row" key={action}><span>{shortcutLabels[action]}</span><div><button type="button" className="shortcut-key" onClick={() => { setRecordingShortcut(action); setShortcutError('') }} onKeyDown={(event) => { if (recordingShortcut === action) recordShortcut(event, action) }} onBlur={() => setRecordingShortcut(null)} aria-label={`Set shortcut for ${shortcutLabels[action]}`}>{recordingShortcut === action ? 'Press keys…' : shortcuts[action] || 'Not set'}</button><button type="button" className="shortcut-clear" disabled={!shortcuts[action]} aria-label={`Clear shortcut for ${shortcutLabels[action]}`} onClick={() => { setShortcuts((current) => ({ ...current, [action]: '' })); setShortcutError('') }}>Clear</button></div></div>)}
            {shortcutError ? <p role="alert">{shortcutError}</p> : null}<button type="button" className="shortcut-clear" onClick={() => { setShortcuts({ ...defaultShortcuts }); setShortcutError('') }}>Reset defaults</button>
          </div>
          <div hidden={settingsCategory !== 'updates'}><div className="settings-section update-settings-section">
            <span className="field-label">Update channel</span>
            <div className="theme-options update-channel-options" role="radiogroup" aria-label="Update channel">
              <button className={`theme-option ${updateChannel === 'stable' ? 'is-selected' : ''}`} type="button" role="radio" aria-checked={updateChannel === 'stable'} tabIndex={updateChannel === 'stable' ? 0 : -1} onKeyDown={(event) => handleRadioGroupKeyDown(event, updateChannelValues, updateChannel, setUpdateChannel)} onClick={() => setUpdateChannel('stable')}>
                <span className="theme-option-copy"><strong>Stable</strong></span>
                <span className="theme-radio" />
              </button>
              <button className={`theme-option ${updateChannel === 'nightly' ? 'is-selected' : ''}`} type="button" role="radio" aria-checked={updateChannel === 'nightly'} tabIndex={updateChannel === 'nightly' ? 0 : -1} onKeyDown={(event) => handleRadioGroupKeyDown(event, updateChannelValues, updateChannel, setUpdateChannel)} onClick={() => setUpdateChannel('nightly')}>
                <span className="theme-option-copy"><strong>Nightly</strong></span>
                <span className="theme-radio" />
              </button>
            </div>
            <div className="update-check-row">
              <span className={updateCheckError ? 'update-check-message is-error' : 'update-check-message'} role={updateCheckError ? 'alert' : 'status'}>{updateCheckError || (checkingUpdates ? 'Checking for updates…' : updateCheckMessage || '')}</span>
              <button className="update-check-button" type="button" disabled={checkingUpdates || installingUpdate} onClick={() => setUpdateRefreshKey((key) => key + 1)}>{checkingUpdates ? 'Checking' : 'Check now'}</button>
            </div>
          </div>
          </div></div></div>
        </section>
      </div> : null}
    </div>
  )
}

function DatabaseIcon() {
  return <svg viewBox="0 0 20 20" fill="none" aria-hidden="true"><ellipse cx="10" cy="4.5" rx="6.5" ry="2.5" /><path d="M3.5 4.5v5c0 1.4 2.9 2.5 6.5 2.5s6.5-1.1 6.5-2.5v-5M3.5 9.5v5c0 1.4 2.9 2.5 6.5 2.5s6.5-1.1 6.5-2.5v-5" /><path d="M3.5 9.5C3.5 10.9 6.4 12 10 12s6.5-1.1 6.5-2.5" /></svg>
}

function normalizeTableData(result: Awaited<ReturnType<typeof PostgresService.GetTableData>>): TableData {
  return {
    columns: result.columns ?? [],
    rows: (result.rows ?? []).map((row) => row ?? []),
    rowCount: result.rowCount ?? 0,
    identities: result.identities ?? [],
  }
}

function sliceTablePage(data: TableData, limit: number): TableData {
  return { ...data, rows: data.rows.slice(0, limit), identities: data.identities.slice(0, limit) }
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  const units = ['KiB', 'MiB', 'GiB']
  let value = bytes / 1024
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit++ }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`
}

function errorMessage(error: unknown, fallback: string) {
  if (typeof error === 'string' && error.trim()) return error
  if (error instanceof Error && error.message) return error.message
  return fallback
}

export default App
