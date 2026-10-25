import assert from "node:assert/strict"
import test from "node:test"
import {
  planMentionAdditions,
  runMentionPlan,
} from "../src/lib/selection-actions/mentions.ts"
import {
  patchMentionLists,
  rememberMentionAdditions,
  withMentionAdditions,
  MENTION_OVERRIDE_MS,
} from "../src/lib/mention-cache.ts"

const video = (id, extra = {}) => ({
  id,
  type: "stream",
  status: "live",
  channel: { id: "uploader", name: "Uploader" },
  ...extra,
})
const channel = (id) => ({ id, name: id })
const rejected = (status) =>
  Object.assign(new Error("Request rejected"), { status })

function service(overrides = {}) {
  const canonical = {}
  const calls = []
  const reads = []
  return {
    canonical,
    calls,
    reads,
    read: async (ids) => {
      reads.push(ids)
      return structuredClone(canonical)
    },
    add: async (videoId, channelId) => {
      calls.push([videoId, channelId])
      ;(canonical[videoId] ??= []).push(channel(channelId))
    },
    allowed: () => true,
    forbidden: async () => {},
    progress: () => {},
    ...overrides,
  }
}

test("planning uses canonical mentions, deduplicates, and skips uploaders and placeholders", () => {
  const plan = planMentionAdditions(
    [
      video("a", { mentions: [channel("stale")] }),
      video("a"),
      video("b", { type: "placeholder" }),
    ],
    ["uploader", "existing", "stale", "new", "new"],
    { a: [channel("existing")] }
  )
  assert.equal(plan.requests, 2)
  assert.deepEqual(
    plan.operations.slice(0, 4).map((operation) => operation.skip),
    ["uploader", "existing", null, null]
  )
  assert.ok(
    plan.operations
      .slice(4)
      .every((operation) => operation.skip === "placeholder")
  )
  assert.ok(Object.isFrozen(plan.operations))
  assert.throws(
    () =>
      planMentionAdditions(
        Array.from({ length: 51 }, (_, index) => video(String(index))),
        ["talent"],
        {}
      ),
    /videoLimit/
  )
  assert.throws(
    () => planMentionAdditions([video("a")], [], {}),
    /channelLimit/
  )
  assert.throws(
    () =>
      planMentionAdditions(
        Array.from({ length: 50 }, (_, index) => video(String(index))),
        ["one", "two", "three"],
        {}
      ),
    /operationLimit/
  )
})

test("partial success is verified per video-channel pair and later requests stop", async () => {
  const services = service()
  const original = services.add
  services.add = async (videoId, channelId) => {
    if (channelId === "two") throw rejected(400)
    return original(videoId, channelId)
  }
  const outcome = await runMentionPlan(
    planMentionAdditions([video("a"), video("b")], ["one", "two"], {}),
    services,
    new AbortController().signal
  )
  assert.deepEqual(
    outcome.results.map((result) => result.state),
    ["confirmed", "failed", "notAttempted", "notAttempted"]
  )
  assert.deepEqual(outcome.completedIds, [])
  assert.equal(services.calls.length, 1)
})

test("an ambiguous response that committed is verified, without replaying the write", async () => {
  const services = service()
  const original = services.add
  services.add = async (...args) => {
    await original(...args)
    throw new TypeError("Connection lost")
  }
  const outcome = await runMentionPlan(
    planMentionAdditions([video("a")], ["one"], {}),
    services,
    new AbortController().signal
  )
  assert.equal(outcome.results[0].state, "confirmed")
  assert.deepEqual(outcome.completedIds, ["a"])
  assert.equal(services.calls.length, 1)
})

test("an ambiguous write stays unknown when verification also fails", async () => {
  let reads = 0
  const services = service({
    read: async () => {
      if (++reads > 1) throw new Error("Offline")
      return {}
    },
    add: async () => {
      throw new TypeError("Offline")
    },
  })
  const outcome = await runMentionPlan(
    planMentionAdditions([video("a")], ["one"], {}),
    services,
    new AbortController().signal
  )
  assert.equal(outcome.results[0].state, "unknown")
  assert.deepEqual(outcome.completedIds, [])
})

test("a successful HTTP response is insufficient when read-back shows no change", async () => {
  const outcome = await runMentionPlan(
    planMentionAdditions([video("a")], ["one"], {}),
    service({ add: async () => "OK" }),
    new AbortController().signal
  )
  assert.equal(outcome.results[0].state, "failed")
  assert.equal(outcome.results[0].error, "notApplied")
})

test("fresh preflight skips mentions added since preview and catches removed preview skips", async () => {
  const services = service()
  services.canonical.a = [channel("new")]
  const plan = planMentionAdditions([video("a")], ["new", "removed"], {
    a: [channel("removed")],
  })
  const outcome = await runMentionPlan(
    plan,
    services,
    new AbortController().signal
  )
  assert.deepEqual(
    outcome.results.map((result) => result.state),
    ["skipped", "failed"]
  )
  assert.deepEqual(services.calls, [])
})

test("cancellation reconciles the in-flight write and preserves unattempted videos", async () => {
  const abort = new AbortController()
  const services = service()
  const original = services.add
  services.add = async (...args) => {
    await original(...args)
    abort.abort()
    throw abort.signal.reason
  }
  const outcome = await runMentionPlan(
    planMentionAdditions([video("a"), video("b")], ["one"], {}),
    services,
    abort.signal
  )
  assert.deepEqual(
    outcome.results.map((result) => result.state),
    ["confirmed", "notAttempted"]
  )
  assert.deepEqual(outcome.completedIds, ["a"])
})

test("an account change stops further mutations", async () => {
  let allowed = true
  const services = service({ allowed: () => allowed })
  const original = services.add
  services.add = async (...args) => {
    await original(...args)
    allowed = false
  }
  const outcome = await runMentionPlan(
    planMentionAdditions([video("a"), video("b")], ["one"], {}),
    services,
    new AbortController().signal
  )
  assert.deepEqual(
    outcome.results.map((result) => result.state),
    ["confirmed", "notAttempted"]
  )
})

test("403 refreshes once and 429 stops without an automatic mutation retry", async () => {
  for (const status of [403, 429]) {
    let refreshes = 0
    let writes = 0
    const services = service({
      add: async () => {
        writes++
        throw rejected(status)
      },
      forbidden: async () => {
        refreshes++
      },
    })
    const outcome = await runMentionPlan(
      planMentionAdditions([video("a"), video("b")], ["one"], {}),
      services,
      new AbortController().signal
    )
    assert.deepEqual(
      outcome.results.map((result) => result.state),
      ["failed", "notAttempted"]
    )
    assert.equal(writes, 1)
    assert.equal(refreshes, status === 403 ? 1 : 0)
  }
})

test("failed preparation sends no writes and keeps every selection", async () => {
  const services = service({
    read: async () => {
      throw new Error("Offline")
    },
  })
  const outcome = await runMentionPlan(
    planMentionAdditions([video("a")], ["one"], {}),
    services,
    new AbortController().signal
  )
  assert.equal(outcome.results[0].state, "notAttempted")
  assert.deepEqual(outcome.completedIds, [])
  assert.deepEqual(services.calls, [])
})

test("confirmed additions survive stale list responses and preserve metadata and pagination", () => {
  const now = Date.now()
  const original = video("cache-test", {
    mentions: [{ ...channel("existing"), photo: "photo.jpg" }],
  })
  rememberMentionAdditions(original.id, [channel("new")], now)
  const data = {
    pages: [{ items: [original], next: "cursor", total: 20 }],
    pageParams: [0],
  }
  const updated = patchMentionLists(data)
  assert.equal(updated.pages[0].next, "cursor")
  assert.deepEqual(
    updated.pages[0].items[0].mentions.map((item) => item.id),
    ["existing", "new"]
  )
  assert.deepEqual(updated.pageParams, [0])
  assert.equal(
    withMentionAdditions(original, now + 1).mentions[0].photo,
    "photo.jpg"
  )
  assert.deepEqual(
    withMentionAdditions(original, now + 1).mentions.map((item) => item.id),
    ["existing", "new"]
  )
  assert.equal(
    withMentionAdditions(original, now + MENTION_OVERRIDE_MS),
    original
  )
})
