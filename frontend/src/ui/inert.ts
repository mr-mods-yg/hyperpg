// Overlapping overlays may close in a different order from the one they opened.
const owners = new WeakMap<HTMLElement, { count: number; original: boolean }>()

export function acquireInert(elements: Iterable<HTMLElement>): () => void {
  const targets = [...new Set(elements)]
  for (const element of targets) {
    const state = owners.get(element) ?? { count: 0, original: element.inert }
    state.count++
    owners.set(element, state)
    element.inert = true
  }
  let released = false
  return () => {
    if (released) return
    released = true
    for (const element of targets) {
      const state = owners.get(element)!
      if (--state.count === 0) {
        element.inert = state.original
        owners.delete(element)
      }
    }
  }
}
