/**
 * Small, dependency-free helpers for arrays: batching and bounded concurrency.
 */

export function chunk(items, size) {
  const list = Array.isArray(items) ? items : []
  const step = Math.max(1, Math.trunc(size) || 1)
  const out = []
  for (let i = 0; i < list.length; i += step) out.push(list.slice(i, i + step))
  return out
}

/**
 * Runs `worker` over `items` with at most `limit` in flight at a time.
 * Results keep the input order. Never rejects because of one failure - use
 * the `onError` callback instead (results contain `null` for failed items).
 */
export async function mapWithConcurrency(items, limit, worker, onError) {
  const list = Array.isArray(items) ? items : []
  const results = new Array(list.length)
  const max = Math.max(1, Math.trunc(limit) || 1)
  let cursor = 0

  async function runner() {
    while (cursor < list.length) {
      const index = cursor++
      try {
        results[index] = await worker(list[index], index)
      } catch (err) {
        if (onError) onError(err, index, list[index])
        results[index] = null
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(max, list.length) }, () => runner()))
  return results
}

export function uniqueBy(items, keyFn) {
  const seen = new Set()
  const out = []
  for (const item of items || []) {
    const key = keyFn(item)
    if (seen.has(key)) continue
    seen.add(key)
    out.push(item)
  }
  return out
}
