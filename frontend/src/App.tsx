import Button from './ui/Button'
import ActionGroup, { actionFocusReturnTarget } from './ui/ActionGroup'
import { acquireInert } from './ui/inert'
import { lazy, Suspense, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type FormEvent, type KeyboardEvent as ReactKeyboardEvent, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent } from 'react'
import { PostgresService, UpdateService } from './services'
import { createTtlCache } from './cache'
import DataGrid, { type DataGridHandle } from './DataGrid'
import type { TableData } from './grid'
import ConnectionTree, { focusConnectionItem, type ConnectionInfo, type TableInfo } from './ConnectionTree'
import Icon, { type IconName } from './Icon'
const SqlEditor = lazy(() => import('./SqlEditor'))
import TableQueryControls from './TableQueryControls'
import TableDetails from './TableDetails'
import { emptyTableQuery, type TableQueryOptions } from './table-query'
import { readWorkspace, writeWorkspace, readHistory, writeHistory, type HistoryEntry } from './workspace'
import './workspace.css'
import './App.css'

type View = 'data' | 'structure'
type Theme = 'light' | 'dark' | 'cream' | 'discord'
type WorkspaceTab = { id: string; kind: 'table' | 'script'; connectionId: string; database: { id: string; name: string }; table?: TableInfo; title: string; path?: string; savedContent?: string }
type UpdateChannel = 'stable' | 'nightly'
type ShortcutAction = 'refresh' | 'closeTab' | 'newScript' | 'runScript' | 'saveChanges' | 'settings'
const shortcutLabels: Record<ShortcutAction, string> = { refresh: 'Refresh', closeTab: 'Close tab', newScript: 'New SQL script', runScript: 'Run script', saveChanges: 'Save changes', settings: 'Open settings' }
// "Run script" stays unset by default: the SQL editor binds Mod-Enter itself.
const defaultShortcuts: Record<ShortcutAction, string> = { refresh: 'F5', closeTab: 'Ctrl+W', newScript: '', runScript: '', saveChanges: 'Ctrl+S', settings: '' }
const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad|iPod/.test(navigator.platform || navigator.userAgent)
// Shortcuts are stored with "Ctrl" as the primary modifier, which is Cmd on macOS,
// and "Meta" as the secondary one (Control on macOS), so saved bindings work on every platform.
function shortcutFromEvent(event: { key: string; ctrlKey: boolean; altKey: boolean; shiftKey: boolean; metaKey: boolean }): string {
  if (['Control', 'Shift', 'Alt', 'Meta'].includes(event.key)) return ''
  const key = event.key.length === 1 ? event.key.toUpperCase() : event.key
  const primary = isMac ? event.metaKey : event.ctrlKey
  const secondary = isMac ? event.ctrlKey : event.metaKey
  return [primary && 'Ctrl', event.altKey && 'Alt', event.shiftKey && 'Shift', secondary && 'Meta', key].filter(Boolean).join('+')
}
const keyLabels: Record<string, string> = isMac ? { Ctrl: 'Cmd', Meta: 'Ctrl', Alt: 'Option', Escape: 'Esc' } : { Escape: 'Esc' }
function shortcutKeys(shortcut: string): string[] {
  return shortcut ? shortcut.split('+').map((key) => keyLabels[key] ?? key) : []
}
function formatShortcut(shortcut: string): string { return shortcutKeys(shortcut).join('+') }
function ShortcutKeys({ keys }: { keys: string[] }) {
  return <>{keys.map((key, index) => <span key={index}>{index ? '+' : ''}<kbd>{key}</kbd></span>)}</>
}
// Fixed shortcuts, shown read-only in Settings. The SQL editor binds its own
// (Mod-Enter is Cmd+Enter on macOS); tab switching uses the Control key everywhere.
const editorShortcuts = [
  { label: 'Run statement or selection', shortcut: 'Ctrl+Enter' },
  { label: 'Run script', shortcut: 'Ctrl+Shift+Enter' },
]
const fixedShortcuts = [
  ...editorShortcuts.map(({ label, shortcut }) => ({ label, keys: shortcutKeys(shortcut) })),
  { label: 'Cancel running query', keys: ['Esc'] },
  { label: 'Next tab', keys: ['Ctrl', 'Tab'] },
  { label: 'Previous tab', keys: ['Ctrl', 'Shift', 'Tab'] },
]
// The first meaningful line names a reopened history query.
function titleFromSql(sql: string): string {
  const line = sql.split(/\r?\n/).map((text) => text.trim()).find((text) => text && !text.startsWith('--')) ?? ''
  const compact = line.replace(/\s+/g, ' ').replace(/;$/, '')
  if (!compact) return 'History query'
  return compact.length > 40 ? `${compact.slice(0, 39)}…` : compact
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
  const [tablePageCache] = useState(() => createTtlCache<CachedTablePage>({ maxEntries: 25 }))
  const gridRef = useRef<DataGridHandle>(null)
  const tableWorkspace = useRef<HTMLDivElement>(null)
  const filterRecovery = useRef(new Map<string, string[]>())
  const [hasPendingChanges, setHasPendingChanges] = useState(false)
  const handleDirtyChange = useCallback((dirty: boolean) => {
    if (dirty) { connectionSelection.current++; setOpeningConnectionId('') }
    setHasPendingChanges(dirty)
  }, [])
  const [savingChanges, setSavingChanges] = useState(false)
  const [pendingNavigation, setPendingNavigation] = useState<(() => void) | null>(null)
  const pendingNavigationOpener = useRef<HTMLElement | null>(null)
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
  const dialogOpener = useRef<HTMLElement | null>(null)
  const [renamingScript, setRenamingScript] = useState<WorkspaceTab | null>(null)
  const [scriptName, setScriptName] = useState('')
  const [historySearch, setHistorySearch] = useState('')
  const historySearchInput = useRef<HTMLInputElement>(null)
  const historyDeleteButtons = useRef(new Map<string, HTMLButtonElement>())
  const [workspaceError, setWorkspaceError] = useState('')
  const fileInput = useRef<HTMLInputElement>(null)
  // Tabs waiting for the user to confirm discarding unsaved scripts.
  const [closeRequest, setCloseRequest] = useState<WorkspaceTab[] | null>(null)
  const [closeRequestSaving, setCloseRequestSaving] = useState(false)
  const [runningScripts, setRunningScripts] = useState<Set<string>>(new Set())
  // Script tabs that close as soon as their cancelled query stops.
  const [pendingCloseIds, setPendingCloseIds] = useState<Set<string>>(new Set())
  const [cancelRequests, setCancelRequests] = useState<Record<string, number>>({})
  const [focusEditorTabId, setFocusEditorTabId] = useState('')
  const [tabMenu, setTabMenu] = useState<{ tab: WorkspaceTab; x: number; y: number; opener: HTMLElement | null } | null>(null)
  const tabMenuRef = useRef<HTMLDivElement>(null)
  const tabStrip = useRef<HTMLDivElement>(null)
  const [tabsOverflow, setTabsOverflow] = useState(false)
  const [showTabList, setShowTabList] = useState(false)
  const tabListButton = useRef<HTMLButtonElement>(null)
  const tabListRef = useRef<HTMLDivElement>(null)
  const [clearedHistory, setClearedHistory] = useState<HistoryEntry[] | null>(null)
  const [pendingChangeCount, setPendingChangeCount] = useState(0)
  const [windowCloseRequested, setWindowCloseRequested] = useState(false)
  const afterDialogFocus = useRef<(() => void) | null>(null)
  const pagerFocus = useRef<HTMLButtonElement | null>(null)
  const nextScriptId = useRef(Math.max(0, ...initialWorkspace.current.tabs.map((tab) => Number(/^Script (\d+)$/.exec(tab.title)?.[1] ?? 0))))
  const tableTabState = useRef<Record<string, { offset: number; size: number; search: string; view: View; query: TableQueryOptions }>>({})
  const [sqlDrafts, setSqlDrafts] = useState<Record<string, string>>(() => initialWorkspace.current.drafts)
  const [rowSearch, setRowSearch] = useState('')
  const [tableQuery, setTableQuery] = useState<TableQueryOptions>(emptyTableQuery)
  const queryKey = JSON.stringify(tableQuery)
  const [mobileNavOpen, setMobileNavOpen] = useState(false)
  const mobileNavButton = useRef<HTMLButtonElement>(null)
  const mobileSidebar = useRef<HTMLElement>(null)
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
  const editingConnection = editingConnectionId ? connections.find((connection) => connection.id === editingConnectionId) ?? null : null
  const cachedPage = tablePage.current
  const sameTable = !!cachedPage && cachedPage.databaseId === selectedDatabase.id && cachedPage.schema === selectedTable?.schema &&
    cachedPage.table === selectedTable?.name
  const sameTablePage = sameTable && cachedPage.offset === pageOffset && cachedPage.queryKey === queryKey
  // While another page, sort or filter of the same table loads, the last page stays
  // on screen (read-only) so the grid, pagination and focus survive. A failed load
  // of a different page falls back to the error and filter recovery instead.
  const tableData = sameTablePage || (sameTable && !tableError) ? loadedTableData : null
  const shownOffset = sameTable && cachedPage ? cachedPage.offset : pageOffset
  const recoveryColumns = filterRecovery.current.get(activeTabId)
  const tableStale = !!sameTablePage && cachedPage.refreshKey !== refreshKey
  const tableBusy = tableLoading || (tableStale && !tableError)
  const pagerBusy = tableBusy || savingChanges
  const modalOpen = showConnectionDialog || showSettingsDialog || !!closeRequest || windowCloseRequested || showHistory || !!renamingScript || !!pendingNavigation
  const isDirtyScript = (tab: WorkspaceTab) => tab.kind === 'script' && (sqlDrafts[tab.id] ?? '') !== (tab.savedContent ?? '')
  const tabHasUnsavedChanges = (tab: WorkspaceTab) => isDirtyScript(tab) || (tab.kind === 'table' && tab.id === activeTabId && hasPendingChanges)
  const connectionLabel = (id: string) => connections.find((connection) => connection.id === id)?.name ?? ''
  // Table tabs that share a name get a subtle connection or database suffix.
  const tabContext = (tab: WorkspaceTab) => {
    if (tab.kind !== 'table') return ''
    const twins = tabs.filter((item) => item.kind === 'table' && item.title === tab.title && item.id !== tab.id)
    if (!twins.length) return ''
    if (twins.some((item) => item.connectionId !== tab.connectionId)) return connectionLabel(tab.connectionId) || tab.database.name
    if (twins.some((item) => item.database.name !== tab.database.name)) return tab.database.name
    return tab.table?.schema ?? ''
  }
  // Accessible tab name: "users, Production, unsaved changes".
  const tabLabel = (tab: WorkspaceTab) => [tab.title, tabContext(tab), tabHasUnsavedChanges(tab) ? 'unsaved changes' : ''].filter(Boolean).join(', ')
  const tabTooltip = (tab: WorkspaceTab) => [connectionLabel(tab.connectionId), tab.database.name, tab.table ? `${tab.table.schema}.${tab.table.name}` : tab.path || tab.title].filter(Boolean).join(' › ')
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
        if (!cancelled && request === connectionSelection.current) setSavedConnectionsError(errorMessage(error, 'Could not open the saved connection', true))
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

  useLayoutEffect(() => {
    if (!mobileNavOpen) return
    const drawer = mobileSidebar.current
    const mobile = window.matchMedia('(max-width: 560px)')
    if (!drawer || !mobile.matches) { setMobileNavOpen(false); return }
    const background = [...(drawer.parentElement?.children ?? [])].filter((element) =>
      element !== drawer && !element.matches('.mobile-sidebar-scrim, .modal-backdrop'),
    ) as HTMLElement[]
    const releaseBackground = acquireInert(background)
    const controls = () => [...drawer.querySelectorAll<HTMLElement>(
      'button:not(:disabled), input:not(:disabled), select:not(:disabled), a[href], [tabindex]:not([tabindex="-1"])',
    )].filter((element) => element.tabIndex >= 0 && element.getClientRects().length > 0)
    const dialogOpen = () => !!document.querySelector('.modal-backdrop [role="dialog"]')
    const focusFirst = () => controls()[0]?.focus()
    focusFirst()
    const keyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || dialogOpen()) return
      if (event.key === 'Escape') {
        event.preventDefault()
        setMobileNavOpen(false)
      } else if (event.key === 'Tab') {
        const items = controls()
        const first = items[0]
        const last = items[items.length - 1]
        if (!drawer.contains(document.activeElement) || event.shiftKey && document.activeElement === first || !event.shiftKey && document.activeElement === last) {
          event.preventDefault()
          ;(event.shiftKey ? last : first)?.focus()
        }
      }
    }
    const keepFocus = (event: FocusEvent) => {
      if (!dialogOpen() && !drawer.contains(event.target as Node)) focusFirst()
    }
    const resized = () => { if (!mobile.matches) setMobileNavOpen(false) }
    document.addEventListener('keydown', keyDown)
    document.addEventListener('focusin', keepFocus)
    mobile.addEventListener('change', resized)
    return () => {
      document.removeEventListener('keydown', keyDown)
      document.removeEventListener('focusin', keepFocus)
      mobile.removeEventListener('change', resized)
      releaseBackground()
      if (!dialogOpen()) {
        if (mobileNavButton.current?.getClientRects().length) mobileNavButton.current.focus()
        else drawer.querySelector<HTMLElement>('.settings-button')?.focus()
      }
    }
  }, [mobileNavOpen])

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
    if (!modalOpen) return
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || recordingShortcut) return
      if (pendingNavigation) { if (!savingChanges) setPendingNavigation(null) }
      else if (renamingScript) setRenamingScript(null)
      else if (showHistory) setShowHistory(false)
      else if (closeRequest) { if (!closeRequestSaving) setCloseRequest(null) }
      else if (windowCloseRequested) setWindowCloseRequested(false)
      else if (showSettingsDialog) setShowSettingsDialog(false)
      else if (!connecting) setShowConnectionDialog(false)
    }
    window.addEventListener('keydown', closeOnEscape)
    return () => window.removeEventListener('keydown', closeOnEscape)
  }, [modalOpen, showConnectionDialog, showSettingsDialog, connecting, recordingShortcut, closeRequest, closeRequestSaving, windowCloseRequested, showHistory, renamingScript, pendingNavigation, savingChanges])

  useEffect(() => {
    if (!modalOpen) return
    const dialogs = [...document.querySelectorAll<HTMLElement>('.modal-backdrop [role="dialog"]')]
    const dialog = dialogs[dialogs.length - 1]
    const backdrop = dialog?.closest<HTMLElement>('.modal-backdrop')
    if (!dialog || !backdrop) return

    const previouslyFocused = document.activeElement instanceof HTMLElement ? document.activeElement : null
    const siblings = [...(backdrop.parentElement?.children ?? [])].filter((element) => element !== backdrop) as HTMLElement[]
    const releaseBackground = acquireInert(siblings)

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
      releaseBackground()
      const next = afterDialogFocus.current
      afterDialogFocus.current = null
      if (next) { requestAnimationFrame(next); return }
      const opener = pendingNavigation ? pendingNavigationOpener.current : showSettingsDialog ? settingsDialogOpener.current : showConnectionDialog ? connectionDialogOpener.current : dialogOpener.current ?? previouslyFocused
      const target = [opener, previouslyFocused, mobileNavButton.current, mobileSidebar.current?.querySelector<HTMLElement>('.settings-button')]
        .find((element) => element?.isConnected && element.getClientRects().length && !element.closest('[inert]'))
      target?.focus()
    }
  }, [showConnectionDialog, showSettingsDialog, closeRequest, windowCloseRequested, showHistory, renamingScript, pendingNavigation])

  const pageStart = tableData?.rows.length ? shownOffset + 1 : 0
  const pageEnd = tableData ? Math.min(shownOffset + tableData.rows.length, tableData.rowCount) : 0
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
        if (!cancelled) setTablesError(errorMessage(error, 'Could not load tables', true))
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
    const locationKey = tablePageKey(selectedDatabase.id, selectedTable.schema, selectedTable.name, pageOffset, queryKey)
    // Reopening a tab primes `tablePage` from the cache, so the same page is
    // reused instead of being read again. Refreshes, filters, sorts and paging
    // never consult the cache: those are explicit requests for fresh rows.
    const current = tablePage.current
    const sameLocation = !!current && current.databaseId === selectedDatabase.id && current.schema === selectedTable.schema &&
      current.table === selectedTable.name && current.offset === pageOffset && current.queryKey === queryKey
    const samePage = sameLocation && current.refreshKey === refreshKey

    if (samePage && current && pageSize <= current.limit) {
      current.appliedSize = pageSize
      tablePage.current = current
      setTableData(sliceTablePage(current.data, pageSize))
      setTableLoading(false)
    } else if (samePage && current) {
      // Read the last cached row again to detect a shift in the ordered page
      // before appending. A concurrent change falls back to a fresh page read.
      const overlap = current.data.rows.length > 0 ? 1 : 0
      const extraOffset = pageOffset + current.data.rows.length - overlap
      const extraLimit = pageSize - current.data.rows.length + overlap
      tablePage.current = current
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
          tablePageCache.set(locationKey, current)
          setTableData(sliceTablePage(data, pageSize))
        } catch (error: unknown) {
          if (!cancelled) {
            setTableError(errorMessage(error, 'Could not load more rows', true))
            setPageSize(current.appliedSize)
          }
        } finally {
          if (!cancelled) setTableLoading(false)
        }
      }
      void loadMore()
    } else {
      // Keep showing the current page while it refreshes, or fall back to a
      // recently cached page for this location before clearing.
      const displayed = tablePage.current
      const displayedMatches = displayed && displayed.databaseId === selectedDatabase.id && displayed.schema === selectedTable.schema &&
        displayed.table === selectedTable.name && displayed.offset === pageOffset && displayed.queryKey === queryKey
      if (!displayedMatches) {
        if (current) {
          tablePage.current = current
          setTableData(sliceTablePage(current.data, Math.min(current.appliedSize, pageSize)))
        } else {
          tablePage.current = null
          setTableData(null)
        }
      }
      setTableLoading(true)
      setTableError('')
      readPage(pageSize, pageOffset)
        .then((result) => {
          if (!cancelled) {
            const data = normalizeTableData(result)
            const page: CachedTablePage = { queryKey, databaseId: selectedDatabase.id, schema: selectedTable.schema, table: selectedTable.name, offset: pageOffset, refreshKey, data, limit: pageSize, appliedSize: pageSize }
            tablePageCache.set(locationKey, page)
            tablePage.current = page
            setTableData(data)
          }
        })
        .catch((error: unknown) => {
          if (!cancelled) setTableError(errorMessage(error, 'Could not load this table', true))
        })
        .finally(() => {
          if (!cancelled) setTableLoading(false)
        })
    }

    return () => { cancelled = true }
  }, [selectedDatabase.id, selectedTable?.schema, selectedTable?.name, pageSize, pageOffset, refreshKey, queryKey, tablePageCache])

  const guardNavigation = (action: () => void) => {
    if (savingChanges) return
    if (hasPendingChanges) {
      pendingNavigationOpener.current = actionFocusReturnTarget()
      setPendingNavigation(() => action)
    }
    else action()
  }

  const applyTableQuery = (query: TableQueryOptions) => guardNavigation(() => {
    if (tableData) filterRecovery.current.set(activeTabId, tableData.columns.map((column) => column.name))
    const queryChanged = JSON.stringify(query) !== queryKey || pageOffset !== 0
    if (queryChanged || tableError) {
      // The filter panel closes on apply; keep keyboard focus on the stable table container.
      pendingNavigationOpener.current = tableWorkspace.current
      tableWorkspace.current?.focus({ preventScroll: true })
    }
    if (!queryChanged && tableError) setRefreshKey((current) => current + 1)
    setTableQuery(query); setPageOffset(0); setRowSearch('')
  })

  const resolveNavigation = async (save: boolean) => {
    if (save && !(await gridRef.current?.save())) { setPendingNavigation(null); return }
    if (!save) gridRef.current?.discard()
    const action = pendingNavigation
    setPendingNavigation(null)
    action?.()
  }

  const openConnectionDialog = () => {
    connectionDialogOpener.current = actionFocusReturnTarget()
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
    connectionDialogOpener.current = actionFocusReturnTarget()
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
    settingsDialogOpener.current = mobileNavOpen ? mobileNavButton.current : document.activeElement instanceof HTMLElement ? document.activeElement : null
    if (mobileNavOpen) setMobileNavOpen(false)
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
      // Focus the connection in the tree once the dialog has closed.
      afterDialogFocus.current = () => { if (!focusConnectionItem(connection.id)) connectionDialogOpener.current?.focus() }
    } catch (error) {
      setConnectionError(errorMessage(error, 'Could not connect. Check the URL and try again.'))
    } finally {
      setConnecting(false)
    }
  }

  // The inputs are disabled while connecting, so return focus to the URL after a failure.
  useEffect(() => {
    if (connectionError && !connecting && showConnectionDialog) document.getElementById('connection-url')?.focus()
  }, [connectionError, connecting, showConnectionDialog])

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
      if (request === connectionSelection.current) setSavedConnectionsError(errorMessage(error, 'Could not open this connection', true))
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
      if (request === connectionSelection.current) setSavedConnectionsError(errorMessage(error, 'Could not open this database', true))
    } finally {
      if (request === connectionSelection.current) setOpeningConnectionId('')
    }
  }

  const removeConnection = (connection: ConnectionInfo) => guardNavigation(() => { void deleteConnection(connection) })

  const deleteConnection = async (connection: ConnectionInfo) => {
    try {
      await PostgresService.DeleteSavedConnection(connection.id)
    } catch (error) {
      setSavedConnectionsError(errorMessage(error, 'Could not remove this connection', true))
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
      }).catch((error: unknown) => { if (request === connectionSelection.current) setWorkspaceError(`${errorMessage(error, 'Could not reopen this database', true)} Your draft is preserved.`) }).finally(() => { if (request === connectionSelection.current) setOpeningConnectionId('') })
      return
    }
    activateResolvedTab(tab)
  }

  const activateResolvedTab = (tab: WorkspaceTab) => {
    const saved = tableTabState.current[tab.id]
    const offset = saved?.offset ?? 0
    const query = saved?.query ?? emptyTableQuery()
    const size = saved?.size ?? 100
    // Prime the next render with a cached page so switching tabs never flashes
    // a loading state for data that was fetched moments ago.
    if (tab.kind === 'table' && tab.table) {
      const page = tablePageCache.get(tablePageKey(tab.database.id, tab.table.schema, tab.table.name, offset, JSON.stringify(query)))
      if (page) {
        tablePage.current = page
        setTableData(sliceTablePage(page.data, Math.min(size, page.limit)))
      }
    }
    setSelectedConnectionId(tab.connectionId)
    setSelectedDatabase(tab.database)
    setSelectedTable(tab.table ?? null)
    setShowSql(tab.kind === 'script')
    setActiveTabId(tab.id)
    setPageOffset(offset)
    setPageSize(size)
    setRowSearch(saved?.search ?? '')
    setView(saved?.view ?? 'data')
    setTableQuery(query)
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
    setFocusEditorTabId(tab.id)
    activateTab(tab)
  })
  // Generated and reopened scripts get numbered titles ("users · SELECT 2") instead of duplicates.
  const uniqueTitle = (title: string) => {
    const taken = new Set(tabsRef.current.map((tab) => tab.title))
    if (!taken.has(title)) return title
    let number = 2
    while (taken.has(`${title} ${number}`)) number++
    return `${title} ${number}`
  }
  const openScriptContent = (name: string, content: string, path = '', connectionId = selectedConnectionId, database = selectedDatabase) => {
    const tab: WorkspaceTab = { id: crypto.randomUUID(), kind: 'script', connectionId, database, title: path ? name : uniqueTitle(name), path, savedContent: path ? content : undefined }
    setTabs((current) => [...current, tab]); setSqlDrafts((current) => ({ ...current, [tab.id]: content })); activateTab(tab)
  }
  const fileService = PostgresService as typeof PostgresService & { OpenSQLFile?: () => Promise<{ path: string; name: string; content: string }>; SaveSQLFile?: (path: string, name: string, content: string) => Promise<{ path: string; name: string; content: string }> }
  const openScript = async () => {
    if (!fileService.OpenSQLFile) { fileInput.current?.click(); return }
    try { const file = await fileService.OpenSQLFile(); if (file?.path) guardNavigation(() => openScriptContent(file.name, file.content, file.path)) }
    catch (error) { setWorkspaceError(errorMessage(error, 'Could not open the script', true)) }
  }
  // Resolves true once the script is saved; false when saving failed or the file dialog was cancelled.
  const saveScript = async (tab: WorkspaceTab): Promise<boolean> => {
    const content = sqlDrafts[tab.id] ?? ''
    try {
      if (fileService.SaveSQLFile) {
        const file = await fileService.SaveSQLFile(tab.path ?? '', tab.title, content)
        if (!file?.path) return false
        setTabs((current) => current.map((item) => item.id === tab.id ? { ...item, path: file.path, title: tab.path ? item.title : file.name, savedContent: content } : item))
      } else {
        const url = URL.createObjectURL(new Blob([content], { type: 'application/sql' })); const link = document.createElement('a'); link.href = url; link.download = tab.title.endsWith('.sql') ? tab.title : `${tab.title}.sql`; link.click(); URL.revokeObjectURL(url)
        setTabs((current) => current.map((item) => item.id === tab.id ? { ...item, savedContent: content } : item))
      }
      setWorkspaceError('')
      return true
    } catch (error) { setWorkspaceError(errorMessage(error, 'Could not save the script', true)); return false }
  }
  // An orphaned script (its saved connection was removed) can be moved to another connection.
  const moveScriptToConnection = (tab: WorkspaceTab, connectionId: string) => {
    const connection = connections.find((item) => item.id === connectionId)
    if (!connection) return
    const moved: WorkspaceTab = { ...tab, connectionId, database: { name: connection.database, id: '' } }
    setTabs((current) => current.map((item) => item.id === tab.id ? moved : item))
    setWorkspaceError('')
    activateTab(moved)
  }
  const renameScript = (tab: WorkspaceTab) => { dialogOpener.current = actionFocusReturnTarget(); setScriptName(tab.title); setRenamingScript(tab) }
  const filteredHistory = history.filter((entry) => `${entry.sql} ${entry.databaseName}`.toLowerCase().includes(historySearch.toLowerCase()))
  const deleteHistoryEntry = (id: string) => {
    const index = filteredHistory.findIndex((entry) => entry.id === id)
    const neighbor = filteredHistory[index + 1] ?? filteredHistory[index - 1]
    if (neighbor) historyDeleteButtons.current.get(neighbor.id)?.focus()
    else historySearchInput.current?.focus()
    setHistory((current) => current.filter((entry) => entry.id !== id))
  }
  const openHistoryEntry = (entry: HistoryEntry) => guardNavigation(() => {
    setShowHistory(false)
    openScriptContent(titleFromSql(entry.sql), entry.sql, '', entry.connectionId, { name: entry.databaseName, id: '' })
  })

  // Removes tabs immediately; callers handle confirmation and running scripts.
  const removeTabs = (ids: string[]) => {
    const current = tabsRef.current
    const closing = new Set(ids)
    if (!current.some((item) => closing.has(item.id))) return
    connectionSelection.current++
    setOpeningConnectionId('')
    const remaining = current.filter((item) => !closing.has(item.id))
    setTabs(remaining)
    for (const id of ids) { delete tableTabState.current[id]; filterRecovery.current.delete(id) }
    setSqlDrafts((drafts) => { const next = { ...drafts }; for (const id of ids) delete next[id]; return next })
    setPendingCloseIds((pending) => pending.size && ids.some((id) => pending.has(id)) ? new Set([...pending].filter((id) => !closing.has(id))) : pending)
    if (closing.has(activeTabId)) {
      // Prefer the nearest surviving tab to the right of the closed active tab, then to its left.
      const index = current.findIndex((item) => item.id === activeTabId)
      const next = current.slice(index + 1).find((item) => !closing.has(item.id)) ?? current.slice(0, index).reverse().find((item) => !closing.has(item.id))
      if (next) activateTab(next)
      else { setActiveTabId(''); setShowSql(false); setSelectedTable(null) }
    }
  }
  const closeTabs = (targets: WorkspaceTab[], confirmed = false) => {
    if (!targets.length) return
    if (!confirmed && targets.some(isDirtyScript)) { dialogOpener.current = actionFocusReturnTarget(); setCloseRequest(targets); return }
    // A running script is cancelled first and its tab closes when the query stops.
    const running = targets.filter((tab) => runningScripts.has(tab.id))
    if (running.length) {
      setPendingCloseIds((pending) => new Set([...pending, ...running.map((tab) => tab.id)]))
      setCancelRequests((requests) => ({ ...requests, ...Object.fromEntries(running.map((tab) => [tab.id, (requests[tab.id] ?? 0) + 1])) }))
    }
    const closable = targets.filter((tab) => !runningScripts.has(tab.id)).map((tab) => tab.id)
    if (!closable.length) return
    // Pending table edits only belong to the active tab, so only closing it needs the guard.
    if (closable.includes(activeTabId)) guardNavigation(() => removeTabs(closable))
    else removeTabs(closable)
  }
  const closeTab = (tab: WorkspaceTab, confirmed = false) => closeTabs([tab], confirmed)
  const closeOtherTabs = (tab: WorkspaceTab) => closeTabs(tabs.filter((item) => item.id !== tab.id))
  const closeTabsToRight = (tab: WorkspaceTab) => closeTabs(tabs.slice(tabs.findIndex((item) => item.id === tab.id) + 1))
  const resolveCloseRequest = async (save: boolean) => {
    const targets = closeRequest
    if (!targets) return
    if (save) {
      setCloseRequestSaving(true)
      // Saving can open a file dialog per script; stop at the first one that is not saved.
      for (const tab of targets.filter(isDirtyScript)) {
        if (!(await saveScript(tab))) { setCloseRequestSaving(false); return }
      }
      setCloseRequestSaving(false)
    }
    setCloseRequest(null)
    closeTabs(targets.map((tab) => tabsRef.current.find((item) => item.id === tab.id) ?? tab), true)
  }

  // Close tabs whose cancelled query has stopped.
  useEffect(() => {
    const ready = [...pendingCloseIds].filter((id) => !runningScripts.has(id))
    if (!ready.length) return
    setPendingCloseIds((pending) => new Set([...pending].filter((id) => !ready.includes(id))))
    removeTabs(ready)
  })

  const switchTab = (direction: 1 | -1) => {
    if (tabs.length < 2) return
    const index = tabs.findIndex((tab) => tab.id === activeTabId)
    const next = tabs[(index + direction + tabs.length) % tabs.length]
    guardNavigation(() => {
      activateTab(next)
      requestAnimationFrame(() => document.getElementById(`workspace-tab-${next.id}`)?.focus())
    })
  }

  const openTabMenu = (tab: WorkspaceTab, x: number, y: number, opener: HTMLElement | null) => { setShowTabList(false); setTabMenu({ tab, x, y, opener }) }
  const closeTabMenu = (restoreFocus = true) => {
    const opener = tabMenu?.opener
    setTabMenu(null)
    if (restoreFocus && opener?.isConnected) opener.focus()
  }
  useLayoutEffect(() => {
    if (!tabMenu || !tabMenuRef.current) return
    const element = tabMenuRef.current
    const bounds = element.getBoundingClientRect()
    element.style.left = `${Math.max(8, Math.min(tabMenu.x, window.innerWidth - bounds.width - 8))}px`
    element.style.top = `${Math.max(8, Math.min(tabMenu.y, window.innerHeight - bounds.height - 8))}px`
    element.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus({ preventScroll: true })
  }, [tabMenu])
  useEffect(() => {
    if (!tabMenu && !showTabList) return
    const dismiss = (event: Event) => {
      const target = event.target as Node
      if (tabMenuRef.current?.contains(target) || tabListRef.current?.contains(target) || tabListButton.current?.contains(target)) return
      setTabMenu(null); setShowTabList(false)
    }
    const dismissOnResize = () => { setTabMenu(null); setShowTabList(false) }
    document.addEventListener('pointerdown', dismiss, true)
    window.addEventListener('resize', dismissOnResize)
    return () => { document.removeEventListener('pointerdown', dismiss, true); window.removeEventListener('resize', dismissOnResize) }
  }, [tabMenu, showTabList])
  useLayoutEffect(() => {
    if (showTabList) tabListRef.current?.querySelector<HTMLButtonElement>('[aria-checked="true"], button')?.focus({ preventScroll: true })
  }, [showTabList])
  const menuKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>, close: () => void) => {
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(); return }
    if (event.key === 'Tab') { event.preventDefault(); close(); return }
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return
    event.preventDefault()
    const buttons = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')]
    const index = buttons.indexOf(document.activeElement as HTMLButtonElement)
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : (index + (event.key === 'ArrowDown' ? 1 : buttons.length - 1)) % buttons.length
    buttons[next]?.focus()
  }

  // Show the overflow list only when the tab strip cannot fit every tab.
  useLayoutEffect(() => {
    const strip = tabStrip.current
    if (!strip) { setTabsOverflow(false); return }
    const measure = () => setTabsOverflow(strip.scrollWidth > strip.clientWidth + 1)
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(strip)
    return () => observer.disconnect()
  }, [tabs, fontSizePx])

  useEffect(() => {
    document.getElementById(`workspace-tab-${activeTabId}`)?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
  }, [activeTabId])

  // A pager button that becomes disabled on the first or last page hands focus to its neighbour.
  useEffect(() => {
    const button = pagerFocus.current
    if (!button || pagerBusy) return
    pagerFocus.current = null
    if (button.disabled && (document.activeElement === document.body || document.activeElement === button)) {
      button.closest('.pagination-actions')?.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus()
    }
  }, [pagerBusy, loadedTableData])

  // New SQL focuses the editor once; later visits keep the user's own focus.
  useEffect(() => {
    if (!focusEditorTabId) return
    const timer = window.setTimeout(() => setFocusEditorTabId(''), 1500)
    return () => window.clearTimeout(timer)
  }, [focusEditorTabId])

  useEffect(() => {
    try { localStorage.setItem('hyperpg-shortcuts', JSON.stringify(shortcuts)) } catch { /* Settings remain available for this session. */ }
  }, [shortcuts])

  useEffect(() => {
    const onShortcut = (event: KeyboardEvent) => {
      if (event.isComposing) return
      // Dialogs owned by child components (native <dialog> or aria-modal) block app shortcuts too.
      const childModalOpen = !!document.querySelector('dialog[open], [aria-modal="true"]')
      // Ctrl+Tab / Ctrl+Shift+Tab and Ctrl+PageDown / Ctrl+PageUp cycle tabs (Control on every platform).
      const tabKey = event.ctrlKey && !event.altKey && !event.metaKey && (event.key === 'Tab' || (!event.shiftKey && (event.key === 'PageDown' || event.key === 'PageUp')))
      if (tabKey && tabs.length > 1) {
        event.preventDefault()
        if (mobileNavOpen || modalOpen || childModalOpen || recordingShortcut) return
        switchTab(event.key === 'PageUp' || (event.key === 'Tab' && event.shiftKey) ? -1 : 1)
        return
      }
      const pressed = shortcutFromEvent(event)
      const action = (Object.keys(shortcutLabels) as ShortcutAction[]).find((key) => shortcuts[key] && shortcuts[key] === pressed)
      if (!action) return
      event.preventDefault()
      if (mobileNavOpen || modalOpen || childModalOpen || event.repeat) return
      const activeTab = tabs.find((item) => item.id === activeTabId)
      if (action === 'refresh' && !activeConnection || action === 'closeTab' && !activeTab || action === 'newScript' && !activeConnection || action === 'runScript' && !showSql) return
      if (action === 'refresh') guardNavigation(() => setRefreshKey((value) => value + 1))
      else if (action === 'closeTab' && activeTab) closeTab(activeTab)
      else if (action === 'newScript') newScript()
      else if (action === 'saveChanges') {
        // In a script tab Save writes the script; in a table tab it saves pending edits.
        if (showSql && activeTab?.kind === 'script') void saveScript(activeTab)
        else if (!showSql && selectedTable && hasPendingChanges && !savingChanges) void gridRef.current?.save()
      }
      else if (action === 'runScript') window.dispatchEvent(new Event('hyperpg-run-script'))
      else openSettingsDialog()
    }
    window.addEventListener('keydown', onShortcut, true)
    return () => window.removeEventListener('keydown', onShortcut, true)
  })

  // Window close (Wails WindowClosing hook): the backend keeps the window open while
  // table edits are pending and asks the frontend to confirm. Older backends and
  // test mocks without these bindings skip the guard.
  const windowGuard = PostgresService as typeof PostgresService & { SetUnsavedChanges?: (unsaved: boolean) => Promise<void>; CloseWindow?: () => Promise<void> }
  useEffect(() => {
    if (typeof windowGuard.SetUnsavedChanges !== 'function') return
    void windowGuard.SetUnsavedChanges(hasPendingChanges).catch(() => {})
  }, [hasPendingChanges])
  useEffect(() => {
    if (typeof windowGuard.SetUnsavedChanges !== 'function') return
    let off: (() => void) | undefined
    let disposed = false
    void import('@wailsio/runtime').then(({ Events }) => {
      if (disposed) return
      off = Events.On('hyperpg:close-requested', () => {
        dialogOpener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
        setWindowCloseRequested(true)
      })
    }).catch(() => {})
    return () => { disposed = true; off?.() }
  }, [])
  const quitWithoutSaving = () => {
    setWindowCloseRequested(false)
    gridRef.current?.discard()
    void windowGuard.CloseWindow?.().catch((error: unknown) => setWorkspaceError(errorMessage(error, 'Could not close the window', true)))
  }
  const saveAndQuit = async () => {
    if (!(await gridRef.current?.save())) return
    setWindowCloseRequested(false)
    void windowGuard.CloseWindow?.().catch((error: unknown) => setWorkspaceError(errorMessage(error, 'Could not close the window', true)))
  }

  const openTabCounts = useMemo(() => Object.fromEntries(connections.map((connection) => [connection.id, tabs.filter((tab) => tab.connectionId === connection.id).length])), [connections, tabs])
  const refreshTitle = shortcuts.refresh ? `Refresh (${formatShortcut(shortcuts.refresh)})` : 'Refresh'
  const refreshKeys = shortcuts.refresh ? shortcuts.refresh.replace(/^Ctrl\+/, isMac ? 'Meta+' : 'Control+').replace(/\+Meta\+/, isMac ? '+Control+' : '+Meta+') : undefined
  const unsavedSummary = pendingChangeCount && selectedTable
    ? `You have ${pendingChangeCount} unsaved ${pendingChangeCount === 1 ? 'row change' : 'row changes'} in ${selectedTable.schema}.${selectedTable.name}.`
    : 'You have unsaved table changes.'
  // The table name lives in the tab and breadcrumb; the toolbar carries the view switcher.
  const tableToolbarStart = selectedTable ? <>
    <h1 className="visually-hidden">{selectedTable.schema}.{selectedTable.name}</h1>
    <div className="view-switcher" role="tablist" aria-label="Table view" onKeyDown={handleTableViewKeyDown}>
      <button id="table-view-data-tab" type="button" role="tab" aria-controls="table-view-panel" aria-selected={view === 'data'} tabIndex={view === 'data' ? 0 : -1} className={view === 'data' ? 'is-selected' : ''} onClick={() => setView('data')}>Data</button>
      <button id="table-view-structure-tab" type="button" role="tab" aria-controls="table-view-panel" aria-selected={view === 'structure'} tabIndex={view === 'structure' ? 0 : -1} className={view === 'structure' ? 'is-selected' : ''} onClick={() => guardNavigation(() => setView('structure'))}>Structure</button>
    </div>
  </> : null
  const tableRefreshButton = <Button variant="ghost" iconOnly className="workspace-refresh" type="button" aria-label="Refresh" title={refreshTitle} aria-keyshortcuts={refreshKeys} disabled={tableBusy || savingChanges} onClick={() => guardNavigation(() => setRefreshKey((value) => value + 1))}><Icon name="refresh" /></Button>
  const tableMetrics = <span className="table-status-metrics" title="Fetched rows on this page; size is the estimated UTF-8 JSON size of row values, excluding metadata and network overhead.">{tableData ? `${tableData.rows.length.toLocaleString()} ${tableData.rows.length === 1 ? 'row' : 'rows'} · ~${formatBytes(loadedBytes)}` : '—'}</span>
  const tableActivityStatus = <span className="table-status-activity" role="status" aria-live="polite">{tableActivity ? `${tableActivity}…` : tableStale && tableError ? 'Refresh failed' : ''}</span>
  // While a page loads the buttons stay focusable (aria-disabled), so keyboard users keep their place.
  const pagerButton = (label: string, icon: IconName, text: string, atBoundary: boolean, go: () => void) => {
    const content = icon.endsWith('left') ? <><Icon name={icon} /><span className="pagination-label">{text}</span></> : <><span className="pagination-label">{text}</span><Icon name={icon} /></>
    return <Button type="button" aria-label={label} title={label} disabled={!pagerBusy && (atBoundary || tableStale)} aria-disabled={pagerBusy || undefined}
      onClick={(event) => { if (pagerBusy) return; pagerFocus.current = event.currentTarget; guardNavigation(go) }}>{content}</Button>
  }
  const openExternal = (event: ReactMouseEvent<HTMLAnchorElement>, url: string) => {
    event.preventDefault()
    void import('@wailsio/runtime').then(({ Browser }) => Browser.OpenURL(url)).catch(() => { window.open(url, '_blank', 'noopener,noreferrer') })
  }

  const recordShortcut = (event: ReactKeyboardEvent<HTMLButtonElement>, action: ShortcutAction) => {
    event.preventDefault()
    event.stopPropagation()
    if (event.key === 'Escape') { setRecordingShortcut(null); setShortcutError(''); return }
    const value = shortcutFromEvent(event)
    if (!value) return
    if (!event.ctrlKey && !event.altKey && !event.metaKey && !/^F([1-9]|1[0-2])$/.test(event.key)) { setShortcutError('Use a modifier or a function key.'); return }
    if ((event.ctrlKey || event.metaKey) && ['a', 'c', 'v', 'x', 'z', 'y'].includes(event.key.toLowerCase())) { setShortcutError('Reserved for text editing.'); return }
    if (editorShortcuts.some((item) => item.shortcut === value) || (event.ctrlKey && ['Tab', 'PageUp', 'PageDown'].includes(event.key))) { setShortcutError(`${formatShortcut(value)} is a built-in shortcut.`); return }
    const conflict = (Object.keys(shortcutLabels) as ShortcutAction[]).find((key) => key !== action && shortcuts[key] === value)
    if (conflict) { setShortcutError(`${formatShortcut(value)} is assigned to ${shortcutLabels[conflict]}.`); return }
    setShortcuts((current) => ({ ...current, [action]: value }))
    setRecordingShortcut(null)
    setShortcutError('')
  }

  return (
    <div className={`app-shell ${resizingSidebar ? 'is-resizing-sidebar' : ''}`} style={{ '--sidebar-width': `${sidebarWidth}px` } as CSSProperties}>
      <aside ref={mobileSidebar} className={`sidebar ${mobileNavOpen ? 'is-mobile-open' : ''}`} id="database-sidebar" role={mobileNavOpen ? 'dialog' : undefined} aria-modal={mobileNavOpen || undefined} aria-label="Database navigation">
        <div className="sidebar-section-heading">
          <span>Connections</span>
          <div className="sidebar-heading-actions">
          <Button className="mobile-drawer-close" variant="ghost" iconOnly size="sm" type="button" aria-label="Close navigation panel" title="Close navigation" onClick={() => setMobileNavOpen(false)}><Icon name="close" /></Button>
          <Button variant="ghost" iconOnly size="sm" type="button" onClick={openConnectionDialog} aria-label="Add connection" title="Add connection">
            <Icon name="plus" />
          </Button>
          </div>
        </div>

        {connections.length === 0 ? (
          <button className="sidebar-empty" type="button" onClick={openConnectionDialog}>
            <span className="empty-symbol"><Icon name="plus" /></span>
            <span>Add connection</span>
          </button>
        ) : (
          <ConnectionTree
            connections={connections} selectedConnectionId={selectedConnectionId}
            selectedDatabase={selectedDatabase.name} selectedTable={selectedTable}
            openingConnectionId={openingConnectionId} refreshKey={refreshKey} revisions={connectionRevisions}
            onSelectConnection={selectConnection} onSelectDatabase={selectDatabase}
            onEdit={editConnection} onDelete={removeConnection} openTabCounts={openTabCounts}
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
      {mobileNavOpen ? <button className="mobile-sidebar-scrim" type="button" tabIndex={-1} aria-label="Close navigation" onClick={() => setMobileNavOpen(false)} /> : null}

      <main className="main-panel">
        <header className="topbar">
          <div className="breadcrumbs">
            <button ref={mobileNavButton} className="mobile-nav-button" type="button" onClick={() => setMobileNavOpen((open) => !open)} aria-label="Open navigation" title="Open navigation" aria-expanded={mobileNavOpen}>
              <svg viewBox="0 0 18 18" fill="none" aria-hidden="true"><path d="M3 5h12M3 9h12M3 13h12" /></svg>
            </button>
            {activeConnection ? <><span className="crumb-muted">{activeConnection.name}</span><svg viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="m6 3 5 5-5 5" /></svg><span className={selectedTable ? 'crumb-muted' : 'crumb-current'}>{selectedDatabase.name}</span>{selectedTable ? <><svg viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="m6 3 5 5-5 5" /></svg><span className="crumb-muted">{selectedTable.schema}</span><svg viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="m6 3 5 5-5 5" /></svg><span className="crumb-current">{selectedTable.name}</span></> : null}</> : null}
          </div>
          <div className="topbar-right">
            {activeConnection ? <Button type="button" className="compact-toolbar-action" aria-label="New SQL script" title={shortcuts.newScript ? `New SQL script (${formatShortcut(shortcuts.newScript)})` : 'New SQL script'} onClick={newScript}>New SQL</Button> : null}
            <ActionGroup label="Workspace actions">
            {activeConnection ? <Button type="button" onClick={() => void openScript()}>Open SQL</Button> : null}
            <Button type="button" onClick={() => { dialogOpener.current = actionFocusReturnTarget(); setClearedHistory(null); setShowHistory(true) }}>Query history</Button>
            <input ref={fileInput} type="file" accept=".sql,text/plain,application/sql" hidden onChange={(event) => { const file = event.currentTarget.files?.[0]; event.currentTarget.value = ''; if (file) void file.text().then((content) => guardNavigation(() => openScriptContent(file.name, content))).catch((error: unknown) => setWorkspaceError(errorMessage(error, 'Could not open the script', true))) }} />
            <Button type="button" onClick={openConnectionDialog}><Icon name="plus" /> Add connection</Button>
            </ActionGroup>
          </div>
        </header>

        {activeConnection || tabs.length ? (
          <div className="content-area">
            {savedConnectionsError || workspaceError ? <div className="notice notice-error compact-notice dismissible-notice" role="alert"><span>{savedConnectionsError || workspaceError}</span><Button variant="ghost" iconOnly size="sm" type="button" aria-label="Dismiss message" title="Dismiss" onClick={() => { setSavedConnectionsError(''); setWorkspaceError('') }}><Icon name="close" /></Button></div> : null}
            {tabs.length ? <div className="editor-tab-strip">
              <div ref={tabStrip} className="editor-tab-bar" role="tablist" aria-label="Open workspaces" onKeyDown={handleTableViewKeyDown}>{tabs.map((tab) => {
                const unsaved = tabHasUnsavedChanges(tab)
                const context = tabContext(tab)
                const running = runningScripts.has(tab.id)
                const closing = pendingCloseIds.has(tab.id)
                return <div className={`editor-tab${activeTabId === tab.id ? ' is-active' : ''}${unsaved ? ' is-unsaved' : ''}`} key={tab.id}
                  onMouseDown={(event) => { if (event.button === 1) event.preventDefault() }}
                  onAuxClick={(event) => { if (event.button === 1) { event.preventDefault(); closeTab(tab) } }}
                  onContextMenu={(event) => { event.preventDefault(); openTabMenu(tab, event.clientX, event.clientY, document.getElementById(`workspace-tab-${tab.id}`)) }}>
                  <button type="button" className="editor-tab-select" role="tab" id={`workspace-tab-${tab.id}`} aria-controls={`workspace-panel-${tab.id}`} aria-selected={activeTabId === tab.id} tabIndex={activeTabId === tab.id || (!activeTabId && tabs[0]?.id === tab.id) ? 0 : -1} aria-current={activeTabId === tab.id ? 'page' : undefined} title={tabTooltip(tab)} aria-label={tabLabel(tab)}
                    onClick={() => { if (activeTabId !== tab.id || !tab.database.id) guardNavigation(() => activateTab(tab)) }}
                    onKeyDown={(event) => {
                      if (event.key === 'Delete') { event.preventDefault(); closeTab(tab) }
                      else if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) { event.preventDefault(); const bounds = event.currentTarget.getBoundingClientRect(); openTabMenu(tab, bounds.left, bounds.bottom, event.currentTarget) }
                    }}>
                    <Icon name={tab.kind === 'table' ? 'table' : 'edit'} /><span className="editor-tab-title">{tab.title}</span>
                    {context ? <span className="editor-tab-context">{context}</span> : null}
                    {unsaved ? <span className="editor-tab-unsaved" /> : null}
                  </button>
                  <Button variant="ghost" size="sm" iconOnly className="editor-tab-dismiss" disabled={closing} aria-label={running ? `Cancel query and close ${tab.title}` : `Close ${tab.title}`} title={closing ? 'Closing after the query stops' : running ? 'Cancel query and close' : shortcuts.closeTab ? `Close tab (${formatShortcut(shortcuts.closeTab)})` : 'Close tab'} onClick={() => closeTab(tab)}>{closing ? <span className="button-spinner" /> : <Icon name="close" />}</Button>
                </div>
              })}</div>
              {tabsOverflow || showTabList ? <Button ref={tabListButton} variant="ghost" iconOnly size="sm" type="button" className="editor-tab-list-button" aria-label="Show all tabs" title="Show all tabs" aria-haspopup="menu" aria-expanded={showTabList} onClick={() => { setTabMenu(null); setShowTabList((open) => !open) }}><Icon name="chevron-down" /></Button> : null}
              {showTabList ? <div ref={tabListRef} className="grid-context-menu editor-tab-list" role="menu" aria-label="Open tabs" onKeyDown={(event) => menuKeyDown(event, () => { setShowTabList(false); tabListButton.current?.focus() })}>
                {tabs.map((tab) => <button type="button" role="menuitemradio" key={tab.id} aria-checked={activeTabId === tab.id} title={tabTooltip(tab)} aria-label={tabLabel(tab)} onClick={() => { setShowTabList(false); if (activeTabId !== tab.id || !tab.database.id) guardNavigation(() => activateTab(tab)) }}>
                  <Icon name={tab.kind === 'table' ? 'table' : 'edit'} /><span className="editor-tab-list-title">{tab.title}{tabContext(tab) ? <small> · {tabContext(tab)}</small> : null}</span>{tabHasUnsavedChanges(tab) ? <span className="editor-tab-unsaved" /> : null}
                </button>)}
              </div> : null}
            </div> : null}
            {tabs.filter((tab) => tab.kind === 'script').map((tab) => {
              const dirty = isDirtyScript(tab)
              const orphaned = !connections.some((connection) => connection.id === tab.connectionId)
              const fileActions = <div className="script-file-actions">
                <Button className="compact-toolbar-action" title={shortcuts.saveChanges ? `Save SQL (${formatShortcut(shortcuts.saveChanges)})` : undefined} aria-keyshortcuts={shortcuts.saveChanges ? shortcuts.saveChanges.replace(/^Ctrl/, isMac ? 'Meta' : 'Control') : undefined} onClick={() => void saveScript(tab)}>Save SQL</Button>
                <ActionGroup label="File options"><Button onClick={() => renameScript(tab)}>Rename</Button></ActionGroup>
                <span className={`script-save-status${dirty ? ' is-dirty' : ''}`}>{dirty ? 'Unsaved' : tab.path ? 'Saved' : ''}</span>
              </div>
              return <div key={tab.id} className="script-tab-panel" id={`workspace-panel-${tab.id}`} role="tabpanel" aria-labelledby={`workspace-tab-${tab.id}`} hidden={activeTabId !== tab.id}>
                {orphaned ? <div className="notice notice-warning script-orphan-notice" role="status">
                  <span>This script’s saved connection was removed, so it can’t run until you choose another connection.</span>
                  {connections.length ? <label className="script-orphan-picker"><span>Run on</span><select aria-label="Choose a connection for this script" value="" onChange={(event) => { if (event.target.value) moveScriptToConnection(tab, event.target.value) }}>
                    <option value="" disabled>Choose a connection</option>
                    {connections.map((connection) => <option key={connection.id} value={connection.id}>{connection.name} · {connection.database}</option>)}
                  </select></label> : <Button size="sm" type="button" onClick={openConnectionDialog}><Icon name="plus" />Add connection</Button>}
                </div> : null}
                <Suspense fallback={<span role="status">Loading editor…</span>}><SqlEditor
                  fileActions={fileActions} autoFocus={focusEditorTabId === tab.id} cancelRequest={cancelRequests[tab.id] ?? 0}
                  onRunningChange={(running) => setRunningScripts((current) => { const next = new Set(current); if (running) next.add(tab.id); else next.delete(tab.id); return next })}
                  active={activeTabId === tab.id && !mobileNavOpen && !modalOpen}
                  databaseId={tab.database.id} databaseName={tab.database.name} script={sqlDrafts[tab.id] ?? ''}
                  onScriptChange={(script) => setSqlDrafts((drafts) => ({ ...drafts, [tab.id]: script }))} onExecuted={() => setScriptRefreshPending(true)}
                  onHistory={(entry) => setHistory((current) => [{ ...entry, id: crypto.randomUUID(), connectionId: tab.connectionId, databaseName: tab.database.name }, ...current].slice(0, 200))} /></Suspense>
              </div>
            })}
            {!showSql && activeConnection ? <>
            {!selectedTable ? <section className="database-header">
              <div>
                <h1>{selectedDatabase.name}</h1>
                <div className="database-meta">{activeConnection.name}<span className="meta-divider" />{activeConnection.host}<span className="meta-divider" />{tables.length} tables</div>
              </div>
              <Button variant="ghost" iconOnly className="database-refresh" type="button" aria-label="Refresh" title={refreshTitle} aria-keyshortcuts={refreshKeys} onClick={() => guardNavigation(() => setRefreshKey((value) => value + 1))}>
                <Icon name="refresh" />
              </Button>
            </section> : null}

            <section id={activeTabId ? `workspace-panel-${activeTabId}` : undefined} role={activeTabId ? 'tabpanel' : undefined} aria-labelledby={activeTabId ? `workspace-tab-${activeTabId}` : undefined} className={`workspace-section ${selectedTable ? 'has-selected-table' : ''}`}>
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
                      {tables.map((table) => <button className="catalog-table" key={`${table.schema}.${table.name}`} type="button" title={`${table.schema}.${table.name}`} onClick={() => selectTable(table)}>
                        <span className="catalog-icon"><svg viewBox="0 0 18 18" fill="none" aria-hidden="true"><rect x="2.5" y="3" width="13" height="12" rx="2" /><path d="M2.5 7h13M7 7v8" /></svg></span>
                        <span><strong>{table.name}</strong><small>{table.schema} schema</small></span>
                        <svg className="catalog-arrow" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="m6 3 5 5-5 5" /></svg>
                      </button>)}
                    </div>
                  </div> : tablesError ? <div className="notice notice-error dismissible-notice" role="alert"><span>{tablesError}</span><Button size="sm" type="button" onClick={() => guardNavigation(() => setRefreshKey((value) => value + 1))}>Try again</Button></div> : tablesLoading ? <div className="overview-loading"><span className="spinner" />Reading database schema…</div> : <div className="empty-database"><span className="empty-database-icon"><DatabaseIcon /></span><strong>No tables</strong><span>Tables will appear here as soon as they’re available.</span></div>}
                </div>
              ) : (
                <div ref={tableWorkspace} className="table-workspace" id="table-view-panel" role="tabpanel" aria-labelledby={view === 'data' ? 'table-view-data-tab' : 'table-view-structure-tab'} tabIndex={0}>
                  {tableError ? <div className="notice notice-error dismissible-notice" role="alert"><span>{tableError}</span><Button size="sm" type="button" disabled={tableBusy || savingChanges} onClick={() => guardNavigation(() => { setTableError(''); setRefreshKey((value) => value + 1) })}>Try again</Button></div> : null}
                  {view === 'data' && tableError && !tableData && recoveryColumns ? <div className="filter-recovery"><TableQueryControls columns={recoveryColumns} value={tableQuery} disabled={tableBusy || savingChanges} onApply={applyTableQuery} initialOpen /></div> : null}
                  {view === 'data' && tableData ? <DataGrid
                    key={`${selectedDatabase.id}:${selectedTable.schema}:${selectedTable.name}`}
                    toolbarStart={tableToolbarStart} toolbarEnd={tableRefreshButton}
                    queryControls={<TableQueryControls key={`${activeTabId}:${queryKey}`} columns={tableData.columns.map((column) => column.name)} value={tableQuery} disabled={tableBusy || savingChanges} onApply={applyTableQuery} />}
                    ref={gridRef} data={tableData} connectionID={selectedDatabase.id} schema={selectedTable.schema} table={selectedTable.name}
                    queryOptions={tableQuery} onSortChange={(sort) => guardNavigation(() => { setTableQuery({ ...tableQuery, sort }); setPageOffset(0) })}
                    pageOffset={shownOffset} loading={tableBusy} readOnly={tableStale || !sameTablePage} selectionVersion={tableSelectionVersion} search={rowSearch} onSearchChange={setRowSearch} onDirtyChange={handleDirtyChange} onPendingCountChange={setPendingChangeCount} onSavingChange={setSavingChanges}
                    onSaved={(rowCountDelta) => {
                      // The grid keeps its "Saved N changes" notice and focus while the page refreshes.
                      const remainingCount = Math.max(0, tableData.rowCount + rowCountDelta)
                      setPageOffset((offset) => Math.min(offset, Math.max(0, Math.ceil(remainingCount / pageSize) - 1) * pageSize))
                      setRefreshKey((value) => value + 1)
                    }}
                    footer={<div className="grid-pagination">
                      {tableActivityStatus}
                      <label className="page-size-control"><span>Rows per page</span><select aria-label="Rows per page" value={pageSize} disabled={savingChanges || tableStale} onChange={(event) => { const size = Number(event.target.value); guardNavigation(() => { setTableError(''); setPageSize(size) }) }}>
                        {[25, 50, 100, 250, 500].map((size) => <option key={size} value={size}>{size}</option>)}
                      </select></label>
                      <span className="pagination-range">{pageStart.toLocaleString()}–{pageEnd.toLocaleString()} of {tableData.rowCount.toLocaleString()} rows</span>
                      {tableMetrics}
                      <div className="pagination-actions">
                        {pagerButton('First page', 'chevrons-left', 'First', shownOffset === 0, () => setPageOffset(0))}
                        {pagerButton('Previous page', 'chevron-left', 'Previous', shownOffset === 0, () => setPageOffset((offset) => Math.max(0, offset - pageSize)))}
                        {pagerButton('Next page', 'chevron-right', 'Next', shownOffset + pageSize >= tableData.rowCount, () => setPageOffset((offset) => offset + pageSize))}
                        {pagerButton('Last page', 'chevrons-right', 'Last', shownOffset >= lastPageOffset, () => setPageOffset(lastPageOffset))}
                      </div>
                    </div>}
                  /> : null}
                  {view === 'data' && !tableData ? <>
                    <div className="grid-actions table-toolbar">{tableToolbarStart}<span className="table-toolbar-spacer" />{tableRefreshButton}</div>
                    {tableBusy ? <div className="table-loading"><span className="spinner" />Loading rows…</div> : null}
                    <div className="table-statusbar">{tableMetrics}{tableActivityStatus}</div>
                  </> : null}
                  {view === 'structure' ? <>
                    <div className="grid-actions table-toolbar">{tableToolbarStart}<span className="table-toolbar-meta">{selectedTable.schema} schema</span><span className="table-toolbar-spacer" />{tableRefreshButton}</div>
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
                    <div className="table-statusbar">{tableActivityStatus}</div>
                  </> : null}
                </div>
              )}
            </section>
            </> : null }
          </div>
        ) : (
          <div className="welcome-area">
            <div className="welcome-content">
              {savedConnectionsError || workspaceError ? <div className="notice notice-error compact-notice dismissible-notice" role="alert"><span>{savedConnectionsError || workspaceError}</span><Button variant="ghost" iconOnly size="sm" type="button" aria-label="Dismiss message" title="Dismiss" onClick={() => { setSavedConnectionsError(''); setWorkspaceError('') }}><Icon name="close" /></Button></div> : null}
              <div className="welcome-art" aria-hidden="true">
                <div className="art-db"><DatabaseIcon /></div>
              </div>
              <span className="welcome-kicker">PostgreSQL workspace</span>
              <h1>Connect a database</h1>
              <Button variant="primary" size="lg" className="welcome-action" type="button" onClick={openConnectionDialog}><Icon name="plus" /> Add connection</Button>
            </div>
          </div>
        )}
      </main>

      {tabMenu ? <div ref={tabMenuRef} className="grid-context-menu tab-context-menu" role="menu" aria-label={`${tabMenu.tab.title} tab actions`} style={{ left: tabMenu.x, top: tabMenu.y }} onKeyDown={(event) => menuKeyDown(event, () => closeTabMenu())}>
        <button type="button" role="menuitem" onClick={() => { const tab = tabMenu.tab; closeTabMenu(false); closeTab(tab) }}><Icon name="close" /><span>Close</span>{shortcuts.closeTab ? <kbd aria-hidden="true">{formatShortcut(shortcuts.closeTab)}</kbd> : null}</button>
        <button type="button" role="menuitem" disabled={tabs.length < 2} onClick={() => { const tab = tabMenu.tab; closeTabMenu(); closeOtherTabs(tab) }}><span className="menu-icon-spacer" /><span>Close others</span></button>
        <button type="button" role="menuitem" disabled={tabs[tabs.length - 1]?.id === tabMenu.tab.id} onClick={() => { const tab = tabMenu.tab; closeTabMenu(); closeTabsToRight(tab) }}><span className="menu-icon-spacer" /><span>Close to the right</span></button>
        <hr />
        <button type="button" role="menuitem" onClick={() => { closeTabMenu(false); closeTabs(tabs) }}><span className="menu-icon-spacer" /><span>Close all</span></button>
      </div> : null}

      {updateInfo && (updateInfo.available || updateInstallError) && dismissedUpdate !== (updateInfo.version || 'update-error') && !showSettingsDialog && !showConnectionDialog ? <aside className={`update-alert ${updateInstallError ? 'has-error' : ''}`} role="status" aria-label={updateInstallError ? 'Update failed' : 'Update available'}>
        <span className="update-alert-mark" aria-hidden="true"><svg viewBox="0 0 18 18" fill="none"><path d="M9 2.2v8.2m0 3.4v.1M4.2 15.3h9.6" /><path d="m5.7 6.4 3.3-3.3 3.3 3.3" /></svg></span>
        <span className="update-alert-copy"><strong>{updateInstallError ? 'Update failed' : 'Update available'}</strong><small>{updateInstallError || `${updateInfo.version} · ${updateChannel === 'stable' ? 'Stable' : 'Nightly'}`}{updateInfo.releaseUrl ? <> · <a className="update-release-link" href={updateInfo.releaseUrl} target="_blank" rel="noreferrer" onClick={(event) => openExternal(event, updateInfo.releaseUrl)}>Release notes</a></> : null}</small></span>
        <Button variant="primary" type="button" onClick={() => guardNavigation(() => { void handleInstallUpdate() })} disabled={installingUpdate || !updateInfo.available}>{installingUpdate ? <><span className="button-spinner" />{updateRestarting ? 'Opening installer…' : 'Updating…'}</> : updateInfo.available ? 'Update now' : 'Update unavailable'}</Button>
        <Button variant="ghost" iconOnly size="sm" className="update-dismiss" type="button" aria-label="Dismiss update notice" title="Dismiss" onClick={() => setDismissedUpdate(updateInfo.version || 'update-error')}><Icon name="close" /></Button>
      </aside> : null}

      {renamingScript ? <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setRenamingScript(null) }}><section className="connection-dialog" role="dialog" aria-modal="true" aria-labelledby="rename-title"><div className="dialog-heading"><h2 id="rename-title">Rename script</h2></div><form onSubmit={(event) => { event.preventDefault(); const title = scriptName.trim(); if (!title) return; setTabs((current) => current.map((tab) => tab.id === renamingScript.id ? { ...tab, title } : tab)); setRenamingScript(null) }}><label className="field-label" htmlFor="script-name">Script name</label><input id="script-name" className="dialog-input" autoFocus value={scriptName} onChange={(event) => setScriptName(event.target.value)} /><div className="dialog-actions"><Button type="button" size="lg" onClick={() => setRenamingScript(null)}>Cancel</Button><Button type="submit" variant="primary" size="lg" disabled={!scriptName.trim()}>Rename</Button></div></form></section></div> : null}
      {showHistory ? <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setShowHistory(false) }}><section className="connection-dialog history-dialog" role="dialog" aria-modal="true" aria-labelledby="history-title">
        <div className="dialog-heading"><h2 id="history-title">Query history</h2></div>
        <input ref={historySearchInput} className="dialog-input" aria-label="Search query history" autoFocus placeholder="Search SQL or database" value={historySearch} onChange={(event) => setHistorySearch(event.target.value)} />
        <div className="history-list">{filteredHistory.map((entry) => <article className={`history-entry${entry.error ? ' is-failed' : ''}`} key={entry.id}>
          <button type="button" className="history-open" onClick={() => openHistoryEntry(entry)}>
            <code title={entry.sql}>{entry.sql}</code>
            <small><span className="history-database" title={entry.databaseName}>{entry.databaseName}</span><span>{new Date(entry.executedAt).toLocaleString()} · {Math.round(entry.durationMs)} ms · <span className={entry.error ? 'history-status is-failed' : 'history-status'}>{entry.error ? entry.error === 'Query cancelled' ? 'Cancelled' : 'Failed' : 'Succeeded'}</span></span>{entry.error && entry.error !== 'Query cancelled' ? <span className="history-error" title={entry.error}>{entry.error}</span> : null}</small>
          </button>
          <Button ref={(button) => { if (button) historyDeleteButtons.current.set(entry.id, button); else historyDeleteButtons.current.delete(entry.id) }} variant="ghost" iconOnly aria-label="Delete history entry" title="Delete from history" onClick={() => deleteHistoryEntry(entry.id)}><Icon name="close" /></Button>
        </article>)}{!filteredHistory.length ? <div className="history-empty" role="status"><Icon name="search" /><strong>{history.length ? 'No matching queries' : clearedHistory ? 'History cleared.' : 'No queries yet.'}</strong><span>{history.length ? 'Try another SQL fragment or database name.' : clearedHistory ? `${clearedHistory.length} ${clearedHistory.length === 1 ? 'query was' : 'queries were'} removed.` : 'Run a query to add it to your history.'}</span>{!history.length && clearedHistory ? <Button type="button" onClick={() => { setHistory(clearedHistory); setClearedHistory(null); historySearchInput.current?.focus() }}><Icon name="undo" />Undo</Button> : null}</div> : null}</div>
        <div className="dialog-actions"><Button type="button" size="lg" disabled={!history.length} onClick={() => { setClearedHistory(history); setHistory([]); setHistorySearch(''); historySearchInput.current?.focus() }}>Clear history</Button><Button type="button" variant="primary" size="lg" onClick={() => setShowHistory(false)}>Done</Button></div>
      </section></div> : null}

      {closeRequest ? <div className="modal-backdrop" role="presentation">
        <section className="connection-dialog unsaved-dialog" role="dialog" aria-modal="true" aria-labelledby="close-script-title" aria-describedby="close-script-description">
          {(() => {
            const dirty = closeRequest.filter(isDirtyScript)
            const single = closeRequest.length === 1 && dirty.length === 1
            return <>
              <div className="dialog-heading"><h2 id="close-script-title">{single ? `Save changes to ${dirty[0].title}?` : `Save changes to ${dirty.length} ${dirty.length === 1 ? 'script' : 'scripts'}?`}</h2></div>
              <p id="close-script-description">{single ? 'Your edits to this script will be lost if you don’t save them.' : `${dirty.map((tab) => tab.title).join(', ')} ${dirty.length === 1 ? 'has' : 'have'} unsaved edits that will be lost if you don’t save them.`}</p>
              <div className="dialog-actions">
                <Button type="button" size="lg" autoFocus disabled={closeRequestSaving} onClick={() => setCloseRequest(null)}>Cancel</Button>
                <Button type="button" size="lg" disabled={closeRequestSaving} onClick={() => void resolveCloseRequest(false)}>Don’t save</Button>
                <Button type="button" variant="primary" size="lg" disabled={closeRequestSaving} onClick={() => void resolveCloseRequest(true)}>{closeRequestSaving ? 'Saving…' : 'Save'}</Button>
              </div>
            </>
          })()}
        </section>
      </div> : null}

      {pendingNavigation ? <div className="modal-backdrop" role="presentation">
        <section className="connection-dialog unsaved-dialog" role="dialog" aria-modal="true" aria-labelledby="unsaved-title" tabIndex={-1}>
          <div className="dialog-heading"><h2 id="unsaved-title">Unsaved changes</h2></div>
          <p>{unsavedSummary} Save them before continuing, or discard them.</p>
          <div className="dialog-actions">
            <Button type="button" size="lg" autoFocus disabled={savingChanges} onClick={() => setPendingNavigation(null)}>Keep editing</Button>
            <Button type="button" size="lg" disabled={savingChanges} onClick={() => void resolveNavigation(false)}>Discard and continue</Button>
            <Button type="button" variant="primary" size="lg" disabled={savingChanges} onClick={() => void resolveNavigation(true)}>{savingChanges ? 'Saving…' : 'Save and continue'}</Button>
          </div>
          {tableError ? <div className="notice notice-error" role="alert">{tableError}</div> : null}
        </section>
      </div> : null}

      {windowCloseRequested ? <div className="modal-backdrop" role="presentation">
        <section className="connection-dialog unsaved-dialog" role="dialog" aria-modal="true" aria-labelledby="quit-title">
          <div className="dialog-heading"><h2 id="quit-title">Quit with unsaved changes?</h2></div>
          <p>{unsavedSummary} They will be lost if you quit without saving.</p>
          <div className="dialog-actions">
            <Button type="button" size="lg" autoFocus disabled={savingChanges} onClick={() => setWindowCloseRequested(false)}>Keep editing</Button>
            <Button type="button" size="lg" disabled={savingChanges} onClick={quitWithoutSaving}>Quit without saving</Button>
            <Button type="button" variant="primary" size="lg" disabled={savingChanges || !hasPendingChanges} onClick={() => void saveAndQuit()}>{savingChanges ? 'Saving…' : 'Save and quit'}</Button>
          </div>
        </section>
      </div> : null}

      {showConnectionDialog ? <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget && !connecting) setShowConnectionDialog(false) }}>
        <section className="connection-dialog connection-form-dialog" role="dialog" aria-modal="true" aria-labelledby="dialog-title">
          <button className="dialog-close" type="button" aria-label="Close" title="Close" onClick={() => setShowConnectionDialog(false)} disabled={connecting}><svg viewBox="0 0 18 18" fill="none" aria-hidden="true"><path d="m4 4 10 10M14 4 4 14" /></svg></button>
          <div className="dialog-icon"><DatabaseIcon /></div>
          <div className="dialog-heading"><h2 id="dialog-title">{editingConnectionId ? 'Edit connection' : 'Add connection'}</h2>{editingConnection ? <p className="connection-current">Currently <code>{editingConnection.username ? `${editingConnection.username}@` : ''}{editingConnection.host}/{editingConnection.database}</code></p> : null}</div>
          <form onSubmit={handleConnect}>
            <div className="connection-form-body">
            <label className="field-label" htmlFor="connection-name">Connection name <span>Optional</span></label>
            <input id="connection-name" className="dialog-input" value={connectionName} onChange={(event) => setConnectionName(event.target.value)} placeholder="e.g. Production" autoComplete="off" disabled={connecting} />
            <label className="field-label connection-url-label" htmlFor="connection-url">Database URL</label>
            <div className="url-input-wrap"><input id="connection-url" className="dialog-input url-input" value={connectionUrl} onChange={(event) => setConnectionUrl(event.target.value)} placeholder={editingConnectionId ? 'Leave blank to keep the saved URL' : 'postgresql://user:password@host:5432/dbname'} type={showUrl ? 'text' : 'password'} autoComplete="off" autoFocus required={!editingConnectionId} disabled={connecting} aria-describedby={editingConnectionId ? 'connection-url-hint' : undefined} /><button className="reveal-url" type="button" disabled={connecting} onClick={() => setShowUrl((visible) => !visible)} aria-label={showUrl ? 'Hide URL' : 'Show URL'} title={showUrl ? 'Hide URL' : 'Show URL'}>{showUrl ? <svg viewBox="0 0 20 20" fill="none"><path d="M3 3 17 17M8.6 8.7a2 2 0 0 0 2.7 2.7M7.1 5.3A9.8 9.8 0 0 1 10 4.8c4.6 0 7.5 4.1 8 5.2-.2.5-1 1.8-2.4 2.9M5.2 6.7C3.5 7.8 2.4 9.5 2 10c.5 1.1 3.4 5.2 8 5.2 1 0 1.9-.2 2.7-.6" /></svg> : <svg viewBox="0 0 20 20" fill="none"><path d="M2 10s2.8-5.2 8-5.2 8 5.2 8 5.2-2.8 5.2-8 5.2S2 10 2 10Z" /><circle cx="10" cy="10" r="2.2" /></svg>}</button></div>
            {editingConnectionId ? <p className="field-hint" id="connection-url-hint">Leave blank to keep the saved URL.</p> : null}
            <label className="connection-option" htmlFor="show-all-databases">
              <input id="show-all-databases" type="checkbox" checked={showAllDatabases} onChange={(event) => setShowAllDatabases(event.target.checked)} disabled={connecting} aria-labelledby="show-all-databases-label" aria-describedby="show-all-databases-hint" />
              <span><strong id="show-all-databases-label">Show all databases</strong><small id="show-all-databases-hint">Turn off to show only the database in the URL.</small></span>
            </label>
            {connectionError ? <div className="form-error" role="alert"><svg viewBox="0 0 18 18" fill="none"><circle cx="9" cy="9" r="6.7" /><path d="M9 5.5v4M9 12.1v.1" /></svg>{connectionError}</div> : null}
            <div className="dialog-note"><svg viewBox="0 0 18 18" fill="none"><path d="M9 2.2 3.2 4.5v4.1c0 3.3 2.5 5.9 5.8 7.2 3.3-1.3 5.8-3.9 5.8-7.2V4.5L9 2.2Z" /><path d="m6.4 8.8 1.7 1.7 3.6-3.7" /></svg><span>Saved securely on this device.</span></div>
            </div>
            <div className="dialog-actions"><Button className="connection-form-action" size="lg" type="button" onClick={() => setShowConnectionDialog(false)} disabled={connecting}>Cancel</Button><Button className="connection-form-action" variant="primary" size="lg" type="submit" disabled={connecting || !editingConnectionId && !connectionUrl.trim()}>{connecting ? <><span className="button-spinner" />{editingConnectionId ? 'Saving' : 'Connecting'}</> : editingConnectionId ? 'Save connection' : 'Connect'}</Button></div>
          </form>
        </section>
      </div> : null}

      {showSettingsDialog ? <div className="modal-backdrop settings-page-backdrop" role="presentation">
        <section className="connection-dialog settings-dialog settings-page" role="dialog" aria-modal="true" aria-labelledby="settings-title">
          <button className="dialog-close" type="button" aria-label="Close settings" title="Close settings" onClick={() => setShowSettingsDialog(false)}><svg viewBox="0 0 18 18" fill="none" aria-hidden="true"><path d="m4 4 10 10M14 4 4 14" /></svg></button>
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
            {(Object.keys(shortcutLabels) as ShortcutAction[]).map((action) => <div className="shortcut-row" key={action}><span>{shortcutLabels[action]}</span><div><Button type="button" className="shortcut-binding" onClick={() => { setRecordingShortcut(action); setShortcutError('') }} onKeyDown={(event) => { if (recordingShortcut === action) recordShortcut(event, action) }} onBlur={() => setRecordingShortcut(null)} aria-label={`Set shortcut for ${shortcutLabels[action]}`}>{recordingShortcut === action ? 'Press keys…' : shortcuts[action] ? <ShortcutKeys keys={shortcutKeys(shortcuts[action])} /> : 'Not set'}</Button><Button type="button" variant="ghost" className="shortcut-reset" disabled={!shortcuts[action]} aria-label={`Clear shortcut for ${shortcutLabels[action]}`} onClick={() => { setShortcuts((current) => ({ ...current, [action]: '' })); setShortcutError('') }}>Clear</Button></div></div>)}
            {shortcutError ? <p className="shortcut-error" role="alert">{shortcutError}</p> : null}<Button type="button" variant="ghost" className="shortcut-reset" onClick={() => { setShortcuts({ ...defaultShortcuts }); setShortcutError('') }}>Reset defaults</Button>
            <h3 className="fixed-shortcuts-heading">Built-in shortcuts</h3>
            <p className="fixed-shortcuts-note">These work in the SQL editor and tab strip and can’t be changed.</p>
            {fixedShortcuts.map(({ label, keys }) => <div className="shortcut-row is-fixed" key={label}><span>{label}</span><span className="shortcut-fixed-keys"><ShortcutKeys keys={keys} /></span></div>)}
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
              <Button type="button" disabled={checkingUpdates || installingUpdate} onClick={() => setUpdateRefreshKey((key) => key + 1)}>{checkingUpdates ? 'Checking' : 'Check now'}</Button>
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

function tablePageKey(databaseId: string, schema: string, table: string, offset: number, queryKey: string) {
  return JSON.stringify([databaseId, schema, table, offset, queryKey])
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

// With `context`, the fallback names the failed action and prefixes the cause:
// "Could not remove this connection: database is locked."
function errorMessage(error: unknown, fallback: string, context = false) {
  const message = typeof error === 'string' ? error.trim() : error instanceof Error ? error.message.trim() : ''
  if (!context) return message || fallback
  if (!message) return `${fallback}.`
  return `${fallback}: ${message}${/[.!?]$/.test(message) ? '' : '.'}`
}

export default App
