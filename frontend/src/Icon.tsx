type IconName = 'plus' | 'copy' | 'table' | 'search' | 'lock' | 'chevron-left' | 'chevron-right'

export default function Icon({ name, className = '' }: { name: IconName; className?: string }) {
  const paths = {
    plus: <path d="M10 4v12M4 10h12" />,
    copy: <><rect x="7" y="7" width="10" height="10" rx="2" /><path d="M13 7V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v6a2 2 0 0 0 2 2h2" /></>,
    table: <><rect x="3" y="3.5" width="14" height="13" rx="2" /><path d="M3 8h14M8 8v8.5" /></>,
    search: <><circle cx="8.5" cy="8.5" r="5.5" /><path d="m13 13 4 4" /></>,
    lock: <><rect x="5" y="8.5" width="10" height="8" rx="2" /><path d="M7 8.5v-3a3 3 0 0 1 6 0v3M10 12v1" /></>,
    'chevron-left': <path d="m12 5-5 5 5 5" />,
    'chevron-right': <path d="m8 5 5 5-5 5" />,
  }

  return <svg className={`ui-icon ${className}`} viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[name]}</svg>
}
