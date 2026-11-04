import assert from 'node:assert/strict'
import test from 'node:test'
import { createTtlCache } from '../src/cache.ts'

function fakeClock(start = 0) {
  let time = start
  return { now: () => time, advance: (ms: number) => { time += ms } }
}

test('cached values are returned until the ttl expires', () => {
  const clock = fakeClock()
  const cache = createTtlCache<string>({ ttlMs: 1_000, now: clock.now })
  cache.set('table', 'rows')
  clock.advance(999)
  assert.equal(cache.get('table'), 'rows')
  clock.advance(1)
  assert.equal(cache.get('table'), undefined)
  assert.equal(cache.size, 0)
})

test('updating a key refreshes its expiry and recency', () => {
  const clock = fakeClock()
  const cache = createTtlCache<number>({ ttlMs: 1_000, maxEntries: 2, now: clock.now })
  cache.set('a', 1)
  cache.set('b', 2)
  clock.advance(500)
  cache.set('a', 3)
  clock.advance(600)
  // 'b' expired; 'a' was refreshed and is still valid.
  assert.equal(cache.get('b'), undefined)
  assert.equal(cache.get('a'), 3)
  assert.equal(cache.size, 1)
})

test('the oldest entry is evicted beyond the size limit', () => {
  const clock = fakeClock()
  const cache = createTtlCache<number>({ ttlMs: 10_000, maxEntries: 2, now: clock.now })
  cache.set('a', 1)
  cache.set('b', 2)
  cache.set('c', 3)
  assert.equal(cache.get('a'), undefined)
  assert.equal(cache.get('b'), 2)
  assert.equal(cache.get('c'), 3)
  assert.equal(cache.size, 2)
})

test('clear empties the cache and missing keys are undefined', () => {
  const cache = createTtlCache<string>({ ttlMs: 1_000, now: () => 0 })
  assert.equal(cache.get('missing'), undefined)
  cache.set('a', 'x')
  cache.clear()
  assert.equal(cache.get('a'), undefined)
  assert.equal(cache.size, 0)
})
