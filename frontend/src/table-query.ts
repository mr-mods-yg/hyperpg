export type TableFilter = { column: string; operator: string; value: string; value2: string }
export type TableSort = { column: string; direction: string }
export type TableQueryOptions = { filters: TableFilter[]; sort: TableSort[] }
export const emptyTableQuery = (): TableQueryOptions => ({ filters: [], sort: [] })
