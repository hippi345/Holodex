import assert from "node:assert/strict"
import test from "node:test"
import { ApiRequestBudget } from "../src/lib/api-rate-limit.ts"

function budget() {
  let now = 1_000_000
  const waits = []
  return {
    waits,
    now: () => now,
    gate: new ApiRequestBudget({
      limit: 2,
      windowMs: 120_000,
      now: () => now,
      sleep: async (milliseconds, signal) => {
        signal?.throwIfAborted()
        waits.push(milliseconds)
        now += milliseconds
      },
    }),
  }
}

test("the local request budget includes reads and waits for the rolling window", async () => {
  const { gate, waits } = budget()
  await gate.acquire()
  await gate.acquire()
  await gate.acquire()
  assert.deepEqual(waits, [120_000])
})

test("server reset and Retry-After constrain later requests", async () => {
  const { gate, waits, now } = budget()
  gate.observe(
    new Headers({
      "X-RateLimit-Remaining": "0",
      "X-RateLimit-Reset": String((now() + 10_000) / 1000),
      "Retry-After": "15",
    }),
    429
  )
  await gate.acquire()
  assert.deepEqual(waits, [15_000])
})

test("an aborted queued request never consumes a request slot", async () => {
  const { gate, waits } = budget()
  const abort = new AbortController()
  abort.abort()
  await assert.rejects(gate.acquire(abort.signal))
  await gate.acquire()
  await gate.acquire()
  assert.deepEqual(waits, [])
})
