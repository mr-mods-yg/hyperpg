import Button from './ui/Button'
import { useEffect, useState } from 'react'
import { emptyTableQuery, type TableFilter, type TableQueryOptions } from './table-query'
import './feature-panels.css'

const operators = { eq: '=', ne: '≠', contains: 'Contains', gt: '>', gte: '≥', lt: '<', lte: '≤', between: 'Between', isNull: 'Is NULL', isNotNull: 'Is not NULL' }

export default function TableQueryControls({ columns, value, disabled, onApply }: { columns: string[]; value: TableQueryOptions; disabled: boolean; onApply: (value: TableQueryOptions) => void }) {
  const [open, setOpen] = useState(false)
  const [draft, setDraft] = useState(value)
  useEffect(() => setDraft(value), [value])
  const change = (index: number, update: Partial<TableFilter>) => setDraft((current) => ({ ...current, filters: current.filters.map((filter, i) => i === index ? { ...filter, ...update } : filter) }))
  return <div className="table-query-controls">
    <Button className="compact-toolbar-action" type="button" aria-expanded={open} onClick={() => setOpen(!open)}>Filters{value.filters.length ? ` · ${value.filters.length}` : ''}</Button>
    {value.sort.length ? <Button type="button" disabled={disabled} onClick={() => onApply({ ...value, sort: [] })}>Clear sort</Button> : null}
    {open ? <form className="filter-panel" onSubmit={(event) => { event.preventDefault(); onApply(draft) }}>
      {draft.filters.map((filter, index) => <div className="filter-row" key={index}>
        <select aria-label={`Filter ${index + 1} column`} value={filter.column} onChange={(event) => change(index, { column: event.target.value })}>{columns.map((column) => <option key={column}>{column}</option>)}</select>
        <select aria-label={`Filter ${index + 1} operator`} value={filter.operator} onChange={(event) => change(index, { operator: event.target.value })}>{Object.entries(operators).map(([key, label]) => <option value={key} key={key}>{label}</option>)}</select>
        {!['isNull', 'isNotNull'].includes(filter.operator) ? <input aria-label={`Filter ${index + 1} value`} value={filter.value} onChange={(event) => change(index, { value: event.target.value })} /> : null}
        {filter.operator === 'between' ? <input aria-label={`Filter ${index + 1} end value`} value={filter.value2} onChange={(event) => change(index, { value2: event.target.value })} /> : null}
        <Button iconOnly type="button" aria-label={`Remove filter ${index + 1}`} onClick={() => setDraft({ ...draft, filters: draft.filters.filter((_, i) => i !== index) })}>×</Button>
      </div>)}
      <div className="filter-actions"><Button type="button" disabled={!columns.length} onClick={() => setDraft({ ...draft, filters: [...draft.filters, { column: columns[0], operator: 'eq', value: '', value2: '' }] })}>Add condition</Button><Button type="button" disabled={disabled} onClick={() => { const next = emptyTableQuery(); setDraft(next); onApply(next) }}>Reset</Button><Button variant="primary" type="submit" disabled={disabled}>Apply</Button></div>
    </form> : null}
  </div>
}
