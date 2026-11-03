import Button from './ui/Button'
import { useEffect, useRef, useState } from 'react'
import { emptyTableQuery, type TableFilter, type TableQueryOptions } from './table-query'
import './feature-panels.css'

const operators = { eq: '=', ne: '≠', contains: 'Contains', gt: '>', gte: '≥', lt: '<', lte: '≤', between: 'Between', isNull: 'Is NULL', isNotNull: 'Is not NULL' }

export default function TableQueryControls({ columns, value, disabled, onApply, initialOpen = false }: { columns: string[]; value: TableQueryOptions; disabled: boolean; onApply: (value: TableQueryOptions) => void; initialOpen?: boolean }) {
  const [open, setOpen] = useState(initialOpen)
  const [draft, setDraft] = useState(value)
  const addCondition = useRef<HTMLButtonElement>(null)
  useEffect(() => setDraft(value), [value])
  const change = (index: number, update: Partial<TableFilter>) => setDraft((current) => ({ ...current, filters: current.filters.map((filter, i) => i === index ? { ...filter, ...update } : filter) }))
  return <div className="table-query-controls">
    <Button className="compact-toolbar-action" type="button" aria-expanded={open} onClick={() => setOpen(!open)}>Filters{value.filters.length ? ` · ${value.filters.length}` : ''}</Button>
    {value.sort.length ? <Button type="button" disabled={disabled} onClick={() => onApply({ ...value, sort: [] })}>Clear sort</Button> : null}
    {open ? <form className="filter-panel" onSubmit={(event) => { event.preventDefault(); onApply(draft) }}>
      <div className="filter-intro"><strong>Filter rows</strong><span>{draft.filters.length ? 'All conditions must match.' : 'Add a condition to filter rows.'}</span></div>
      {draft.filters.map((filter, index) => <div className="filter-row" role="group" aria-label={`Condition ${index + 1}`} key={index}>
        <div className="filter-row-heading"><strong>Condition {index + 1}</strong><Button iconOnly type="button" aria-label={`Remove filter ${index + 1}`} onClick={() => { addCondition.current?.focus(); setDraft((current) => ({ ...current, filters: current.filters.filter((_, i) => i !== index) })) }}>×</Button></div>
        <div className="filter-fields">
          <label className="filter-column"><span>Column</span><select aria-label={`Filter ${index + 1} column`} title={filter.column} value={filter.column} onChange={(event) => change(index, { column: event.target.value })}>{columns.map((column) => <option key={column}>{column}</option>)}</select></label>
          <label className="filter-operator"><span>Operator</span><select aria-label={`Filter ${index + 1} operator`} value={filter.operator} onChange={(event) => change(index, { operator: event.target.value })}>{Object.entries(operators).map(([key, label]) => <option value={key} key={key}>{label}</option>)}</select></label>
          {!['isNull', 'isNotNull'].includes(filter.operator) ? <label className="filter-value"><span>{filter.operator === 'between' ? 'Start value' : 'Value'}</span><input aria-label={`Filter ${index + 1} ${filter.operator === 'between' ? 'start value' : 'value'}`} value={filter.value} onChange={(event) => change(index, { value: event.target.value })} /></label> : null}
          {filter.operator === 'between' ? <label className="filter-value"><span>End value</span><input aria-label={`Filter ${index + 1} end value`} value={filter.value2} onChange={(event) => change(index, { value2: event.target.value })} /></label> : null}
        </div>
      </div>)}
      <div className="filter-actions"><Button ref={addCondition} type="button" disabled={!columns.length} onClick={() => setDraft({ ...draft, filters: [...draft.filters, { column: columns[0], operator: 'eq', value: '', value2: '' }] })}>Add condition</Button><Button type="button" disabled={disabled} onClick={() => onApply(emptyTableQuery())}>Reset</Button><Button variant="primary" type="submit" disabled={disabled}>Apply</Button></div>
    </form> : null}
  </div>
}
