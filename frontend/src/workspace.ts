export type StoredTab = { id: string; kind: 'table' | 'script'; connectionId: string; databaseName: string; table?: { schema: string; name: string }; title: string; path?: string; savedContent?: string }
export type Workspace = { tabs: StoredTab[]; activeTabId: string; drafts: Record<string, string> }
export type HistoryEntry = { id: string; sql: string; connectionId: string; databaseName: string; executedAt: number; durationMs: number; error: string }
const workspaceKey = 'hyperpg-workspace-v1'
const historyKey = 'hyperpg-query-history-v1'
export function readWorkspace(): Workspace {
  try {
    const value = JSON.parse(localStorage.getItem(workspaceKey) || '{}')
    const tabs = Array.isArray(value.tabs) ? value.tabs.filter((tab: StoredTab) => tab && typeof tab.id === 'string' && (tab.kind === 'script' || tab.kind === 'table') && typeof tab.connectionId === 'string' && typeof tab.databaseName === 'string' && typeof tab.title === 'string') : []
    return { tabs, activeTabId: typeof value.activeTabId === 'string' ? value.activeTabId : '', drafts: value.drafts && typeof value.drafts === 'object' ? value.drafts : {} }
  } catch { return { tabs: [], activeTabId: '', drafts: {} } }
}
export function writeWorkspace(value: Workspace) { try { localStorage.setItem(workspaceKey, JSON.stringify(value)) } catch { /* drafts remain in memory */ } }
export function readHistory(): HistoryEntry[] { try { const value = JSON.parse(localStorage.getItem(historyKey) || '[]'); return Array.isArray(value) ? value.filter((item) => item && typeof item.sql === 'string' && typeof item.databaseName === 'string').slice(0, 200) : [] } catch { return [] } }
export function writeHistory(value: HistoryEntry[]) { try { localStorage.setItem(historyKey, JSON.stringify(value.slice(0, 200))) } catch { /* history remains in memory */ } }
