import Button from './ui/Button'
import Icon from './Icon'
import { useEffect, useRef, useState } from 'react'
import { emptyTableQuery, type TableFilter, type TableQueryOptions } from './table-query'
import './feature-panels.css'

const operators = { eq: '=', ne: '≠', contains: 'Contains', gt: '>', gte: '≥', lt: '<', lte: '≤', between: 'Between', isNull: 'Is NULL', isNotNull: 'Is not NULL' }
const needsValue = (filter: TableFilter) => !['isNull', 'isNotNull'].includes(filter.operator)

// Returns field keys (`index:value` / `index:value2`) that need a value before applying.
export function missingFilterValues(filters: TableFilter[]): string[] {
  return filters.flatMap((filter, index) => [
    needsValue(filter) && !filter.value.trim() ? `${index}:value` : '',
    filter.operator === 'between' && !filter.value2.trim() ? `${index}:value2` : '',
  ].filter(Boolean))
}

export default function TableQueryControls({ columns, value, disabled, onApply, initialOpen = false }: { columns: string[]; value: TableQueryOptions; disabled: boolean; onApply: (value: TableQueryOptions) => void; initialOpen?: boolean }) {
  const [open, setOpen] = useState(initialOpen)
  const [draft, setDraft] = useState(value)
  const [invalid, setInvalid] = useState<string[]>([])
  const addCondition = useRef<HTMLButtonElement>(null)
  const toggle = useRef<HTMLButtonElement>(null)
  const form = useRef<HTMLFormElement>(null)
  const focusColumn = useRef<number | null>(null)
  useEffect(() => { setDraft(value); setInvalid([]) }, [value])
  useEffect(() => {
    if (focusColumn.current === null) return
    form.current?.querySelector<HTMLSelectElement>(`[data-filter-column="${focusColumn.current}"]`)?.focus()
    focusColumn.current = null
  }, [draft.filters.length])
  const change = (index: number, update: Partial<TableFilter>) => {
    setInvalid((current) => current.filter((key) => !key.startsWith(`${index}:`)))
    setDraft((current) => ({ ...current, filters: current.filters.map((filter, i) => i === index ? { ...filter, ...update } : filter) }))
  }
  const remove = (index: number) => {
    addCondition.current?.focus()
    setInvalid([])
    setDraft((current) => ({ ...current, filters: current.filters.filter((_, i) => i !== index) }))
  }
  const close = () => { setOpen(false); setInvalid([]); toggle.current?.focus() }
  const apply = () => {
    const missing = missingFilterValues(draft.filters)
    setInvalid(missing)
    if (missing.length) {
      const [index, field] = missing[0].split(':')
      form.current?.querySelector<HTMLInputElement>(`[data-filter-field="${index}:${field}"]`)?.focus()
      return
    }
    onApply(draft)
  }
  const fieldProps = (index: number, field: 'value' | 'value2', label: string) => {
    const key = `${index}:${field}`
    const isInvalid = invalid.includes(key)
    return { 'data-filter-field': key, 'aria-label': label, 'aria-invalid': isInvalid || undefined, 'aria-describedby': isInvalid ? `filter-error-${index}` : undefined }
  }
  return <div className="table-query-controls">
    <Button ref={toggle} className={`compact-toolbar-action${value.filters.length ? ' is-filtered' : ''}`} type="button" aria-expanded={open} onClick={() => open ? close() : setOpen(true)}><Icon name="filter" />Filters{value.filters.length ? ` · ${value.filters.length}` : ''}</Button>
    {value.filters.length ? <Button variant="ghost" iconOnly size="sm" type="button" className="clear-filters" disabled={disabled} aria-label="Clear filters" title="Clear filters" onClick={() => onApply({ ...value, filters: [] })}><Icon name="close" /></Button> : null}
    {value.sort.length ? <Button type="button" disabled={disabled} onClick={() => onApply({ ...value, sort: [] })} title={`Sorted by ${value.sort.map((sort) => `${sort.column} ${sort.direction.toLowerCase()}`).join(', ')}`}>Clear sort</Button> : null}
    {open ? <form ref={form} className="filter-panel" noValidate onSubmit={(event) => { event.preventDefault(); apply() }} onKeyDown={(event) => {
      if (event.key !== 'Escape') return
      event.preventDefault(); event.stopPropagation(); close()
    }}>
      <div className="filter-intro"><strong>Filter rows</strong><span>{draft.filters.length ? 'All conditions must match.' : 'Add a condition to filter rows.'}</span>
        <Button variant="ghost" iconOnly size="sm" type="button" className="filter-close" aria-label="Close filters" title="Close filters (Esc)" onClick={close}><Icon name="close" /></Button>
      </div>
      {draft.filters.map((filter, index) => {
        const rowInvalid = invalid.some((key) => key.startsWith(`${index}:`))
        return <div className={`filter-row${rowInvalid ? ' is-invalid' : ''}`} role="group" aria-label={`Condition ${index + 1}`} key={index}>
          <div className="filter-row-heading"><strong>Condition {index + 1}</strong><Button variant="ghost" iconOnly size="sm" type="button" aria-label={`Remove filter ${index + 1}`} title="Remove condition" onClick={() => remove(index)}><Icon name="close" /></Button></div>
          <div className="filter-fields">
            <label className="filter-column"><span>Column</span><select data-filter-column={index} aria-label={`Filter ${index + 1} column`} title={filter.column} value={filter.column} onChange={(event) => change(index, { column: event.target.value })}>{columns.map((column) => <option key={column}>{column}</option>)}</select></label>
            <label className="filter-operator"><span>Operator</span><select aria-label={`Filter ${index + 1} operator`} value={filter.operator} onChange={(event) => change(index, { operator: event.target.value })}>{Object.entries(operators).map(([key, label]) => <option value={key} key={key}>{label}</option>)}</select></label>
            {needsValue(filter) ? <label className="filter-value"><span>{filter.operator === 'between' ? 'Start value' : 'Value'}</span><input {...fieldProps(index, 'value', `Filter ${index + 1} ${filter.operator === 'between' ? 'start value' : 'value'}`)} value={filter.value} onChange={(event) => change(index, { value: event.target.value })} /></label> : null}
            {filter.operator === 'between' ? <label className="filter-value"><span>End value</span><input {...fieldProps(index, 'value2', `Filter ${index + 1} end value`)} value={filter.value2} onChange={(event) => change(index, { value2: event.target.value })} /></label> : null}
          </div>
          {rowInvalid ? <p className="filter-error" id={`filter-error-${index}`}>Enter a value, or choose Is NULL / Is not NULL.</p> : null}
        </div>
      })}
      <div className="filter-actions"><Button ref={addCondition} type="button" disabled={!columns.length} onClick={() => { focusColumn.current = draft.filters.length; setDraft({ ...draft, filters: [...draft.filters, { column: columns[0], operator: 'eq', value: '', value2: '' }] }) }}><Icon name="plus" />Add condition</Button><Button type="button" disabled={disabled} onClick={() => onApply(emptyTableQuery())}>Reset</Button><Button variant="primary" type="submit" disabled={disabled}>Apply</Button></div>
    </form> : null}
  </div>
}
