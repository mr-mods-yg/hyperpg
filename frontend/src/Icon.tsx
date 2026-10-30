type IconName = 'plus' | 'copy' | 'table' | 'search' | 'lock' | 'chevron-left' | 'chevron-right' | 'chevrons-left' | 'chevrons-right' | 'edit' | 'null' | 'undo' | 'row-above' | 'row-below' | 'duplicate' | 'trash' | 'restore'

export default function Icon({ name, className = '' }: { name: IconName; className?: string }) {
  const paths = {
    plus: <path d="M10 4v12M4 10h12" />,
    copy: <><rect x="7" y="7" width="10" height="10" rx="2" /><path d="M13 7V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v6a2 2 0 0 0 2 2h2" /></>,
    table: <><rect x="3" y="3.5" width="14" height="13" rx="2" /><path d="M3 8h14M8 8v8.5" /></>,
    search: <><circle cx="8.5" cy="8.5" r="5.5" /><path d="m13 13 4 4" /></>,
    lock: <><rect x="5" y="8.5" width="10" height="8" rx="2" /><path d="M7 8.5v-3a3 3 0 0 1 6 0v3M10 12v1" /></>,
    'chevron-left': <path d="m12 5-5 5 5 5" />,
    'chevron-right': <path d="m8 5 5 5-5 5" />,
    'chevrons-left': <><path d="m12 5-5 5 5 5" /><path d="m18 5-5 5 5 5" /></>,
    'chevrons-right': <><path d="m5 5 5 5-5 5" /><path d="m12 5 5 5-5 5" /></>,
    edit: <><path d="m4 13 8.4-8.4a2 2 0 0 1 2.8 2.8L6.8 15.8 3.5 16.5 4 13Z" /><path d="m11.5 5.5 3 3" /></>,
    null: <><circle cx="10" cy="10" r="6.5" /><path d="m5.4 14.6 9.2-9.2" /></>,
    undo: <><path d="M7 6 4 9l3 3M4 9h7a4 4 0 0 1 0 8H8" /></>,
    'row-above': <><path d="M3 13h14M4 17h12M10 3v7m-3-4 3-3 3 3" /></>,
    'row-below': <><path d="M3 7h14M4 3h12M10 17v-7m-3 4 3 3 3-3" /></>,
    duplicate: <><rect x="7" y="7" width="10" height="10" rx="2" /><path d="M13 7V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v6a2 2 0 0 0 2 2h2M12 9.5v5M9.5 12h5" /></>,
    trash: <><path d="M4 6h12M8 6V4h4v2m2.5 0-.7 10H6.2L5.5 6M8.5 9v4.5M11.5 9v4.5" /></>,
    restore: <><path d="M4 9a6 6 0 1 1 1.8 4.3M4 5v4h4" /><path d="m7.5 10 1.7 1.7L12.7 8" /></>,
  }

  return <svg className={`ui-icon ${className}`} viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[name]}</svg>
}
