import assert from "node:assert/strict"
import test from "node:test"
import {
  SMART_ACTIONS,
  checkSmartPlan,
  planSmartAction,
  runSmartPlan,
  smartActionIssue,
  smartBody,
  smartPageContext,
  verifySmartPlan,
  videoTargetId,
} from "../src/lib/selection-actions/smart.ts"
import { smartCacheEdits } from "../src/lib/selection-actions/smart-cache.ts"
import {
  rememberMentionAdditions,
  rememberVideoEdit,
  withMentionAdditions,
  patchMentionLists,
} from "../src/lib/mention-cache.ts"
import { can } from "../src/lib/permissions.ts"

const channel = (id, type = "vtuber") => ({ id, name: id, type })
const video = (id, type = "stream") => ({
  id,
  title: id,
  type,
  status: "past",
  channel: channel(`owner-${id}`),
  sources: [],
  clips: [],
  simulcasts: [],
  refers: [],
})
const reference = (id) => ({ id, title: id })
const rejected = (status) => Object.assign(new Error("Rejected"), { status })

function fixture() {
  const snapshot = {
    videos: [video("a"), video("b"), video("c")],
    mentions: { a: [channel("guest")], b: [], c: [] },
  }
  const calls = []
  let refreshes = 0
  const services = {
    read: async (action, body, signal) => {
      signal.throwIfAborted()
      return structuredClone(snapshot)
    },
    execute: async (action, body, signal) => {
      signal.throwIfAborted()
      calls.push({ action, body: structuredClone(body) })
      const selected = snapshot.videos.filter((entry) =>
        body.videoIds.includes(entry.id)
      )
      if (action === "merge-participants") {
        const participants = new Map(
          selected
            .flatMap((entry) => [...snapshot.mentions[entry.id], entry.channel])
            .filter((entry) => entry.type === "vtuber")
            .map((entry) => [entry.id, entry])
        )
        for (const entry of selected)
          snapshot.mentions[entry.id] = [
            ...new Map(
              [...snapshot.mentions[entry.id], ...participants.values()].map(
                (participant) => [participant.id, participant]
              )
            ).values(),
          ]
      } else if (action === "make-simulcast" || action === "make-refer") {
        const field = action === "make-simulcast" ? "simulcasts" : "refers"
        for (const entry of selected)
          entry[field].push(
            ...selected
              .filter((other) => other.id !== entry.id)
              .map((other) => reference(other.id))
          )
      } else if (
        action === "dissociate-channel" ||
        action === "remove-mentions"
      ) {
        for (const entry of selected)
          snapshot.mentions[entry.id] =
            action === "remove-mentions"
              ? []
              : snapshot.mentions[entry.id].filter(
                  (participant) => participant.id !== body.channelId
                )
      } else {
        for (const entry of selected)
          for (const field of ["sources", "refers", "simulcasts"])
            entry[field] = entry[field].filter(
              (other) => other.id !== body.targetVideoId
            )
        const target = snapshot.videos.find(
          (entry) => entry.id === body.targetVideoId
        )
        for (const field of ["clips", "simulcasts"])
          target[field] = target[field].filter(
            (other) => !body.videoIds.includes(other.id)
          )
      }
      return { success: true }
    },
    allowed: () => true,
    forbidden: async () => {
      refreshes++
    },
  }
  return { snapshot, services, calls, refreshes: () => refreshes }
}

function planFor(model, action, params = {}) {
  const body = smartBody(action, model.snapshot.videos.slice(0, 2), params)
  return planSmartAction(action, body, model.snapshot)
}

test("only editors and admins have smart-edit capability", () => {
  assert.equal(can(null, "smart.edit"), false)
  assert.equal(can({ role: "user" }, "smart.edit"), false)
  assert.equal(can({ role: "editor" }, "smart.edit"), true)
  assert.equal(can({ role: "admin" }, "smart.edit"), true)
})

test("smart actions enforce distinct video counts, stream types, and backend refer limits", () => {
  assert.equal(SMART_ACTIONS.length, 6)
  assert.equal(
    smartActionIssue("make-simulcast", [video("a"), video("a")]),
    "tooFew"
  )
  assert.equal(
    smartActionIssue("make-simulcast", [video("a"), video("b", "clip")]),
    "streamsOnly"
  )
  assert.equal(
    smartActionIssue(
      "make-refer",
      Array.from({ length: 5 }, (_, index) => video(String(index)))
    ),
    "tooMany"
  )
  assert.equal(
    smartActionIssue("make-refer", [video("a"), video("b", "placeholder")]),
    "noPlaceholders"
  )
  assert.equal(
    smartActionIssue(
      "make-simulcast",
      Array.from({ length: 13 }, (_, index) => video(String(index)))
    ),
    "tooMany"
  )
})

test("targets accept supported video URLs and selected targets are excluded from edited IDs", () => {
  assert.equal(
    videoTargetId("https://www.youtube.com/watch?v=abc_def-123"),
    "abc_def-123"
  )
  assert.equal(
    videoTargetId("https://youtu.be/abc_def-123?t=30"),
    "abc_def-123"
  )
  assert.equal(
    videoTargetId("https://holodex.net/watch/tw%3Asome-stream"),
    "tw:some-stream"
  )
  assert.throws(
    () => videoTargetId("https://example.com/no-video"),
    /targetRequired/
  )
  const body = smartBody(
    "dissociate-video",
    [video("a"), video("b"), video("b")],
    { targetVideoId: "b" }
  )
  assert.deepEqual(body.videoIds, ["a"])
  assert.throws(
    () => smartBody("dissociate-video", [video("a")], { targetVideoId: "a" }),
    /tooFew/
  )
  assert.throws(
    () => smartBody("dissociate-channel", [video("a")], {}),
    /channelRequired/
  )
})

test("page context is explicit and plans freeze the exact request and preview snapshot", () => {
  assert.deepEqual(smartPageContext("/watch/page-video"), {
    pageVideoId: "page-video",
  })
  assert.deepEqual(smartPageContext("/channel/UC_example"), {
    pageChannelId: "UC_example",
  })
  const page = { pageVideoId: "c" }
  assert.deepEqual(
    smartBody("make-refer", [video("a"), video("b")], {}, page).videoIds,
    ["a", "b"]
  )
  assert.deepEqual(
    smartBody(
      "make-refer",
      [video("a"), video("b")],
      { includePageVideo: true },
      page
    ).videoIds,
    ["a", "b", "c"]
  )
  const model = fixture()
  const body = { videoIds: ["a", "b"] }
  const plan = planSmartAction("merge-participants", body, model.snapshot)
  body.videoIds.push("c")
  model.snapshot.mentions.a.push(channel("later"))
  assert.deepEqual(plan.body.videoIds, ["a", "b"])
  assert.equal(plan.before.mentions.a.length, 1)
  assert.ok(Object.isFrozen(plan.body.videoIds))
})

test("merge previews include talent uploaders and exclude non-talent participants", () => {
  const model = fixture()
  model.snapshot.videos[1].channel.type = "subber"
  model.snapshot.mentions.a.push(channel("subber", "subber"))
  const plan = planFor(model, "merge-participants")
  assert.deepEqual(plan.participants.map((entry) => entry.id).sort(), [
    "guest",
    "owner-a",
  ])
  assert.equal(plan.changes, 3)
  delete model.snapshot.mentions.a[0].type
  assert.throws(
    () => planFor(model, "merge-participants"),
    /participantTypeUnknown/
  )
})

for (const action of SMART_ACTIONS)
  test(`${action.id} sends one group request and verifies all edited videos`, async () => {
    const model = fixture()
    model.snapshot.videos[0].sources = [reference("c")]
    model.snapshot.videos[0].simulcasts = [reference("c")]
    model.snapshot.videos[2].clips = [reference("a")]
    model.snapshot.videos[2].simulcasts = [reference("a")]
    model.snapshot.videos[2].refers = [reference("a")]
    const plan = planFor(model, action.id, {
      targetVideoId: "c",
      channelId: "guest",
    })
    const outcome = await runSmartPlan(
      plan,
      model.services,
      new AbortController().signal
    )
    assert.equal(model.calls.length, 1)
    assert.deepEqual(model.calls[0].body.videoIds, ["a", "b"])
    assert.equal(outcome.acknowledged, true)
    assert.ok(outcome.items.every((entry) => entry.state === "confirmed"))
    if (action.id === "dissociate-video")
      assert.deepEqual(model.snapshot.videos[2].refers, [reference("a")])
  })

test("destructive and merge actions stop if relevant data changes after preview", async () => {
  for (const action of [
    "remove-mentions",
    "merge-participants",
    "dissociate-channel",
    "dissociate-video",
  ]) {
    const model = fixture()
    const plan = planFor(model, action, {
      channelId: "guest",
      targetVideoId: "c",
    })
    if (action === "dissociate-video")
      model.snapshot.videos[0].refers.push(reference("c"))
    else if (action === "dissociate-channel") model.snapshot.mentions.a = []
    else model.snapshot.mentions.a.push(channel("later"))
    const outcome = await runSmartPlan(
      plan,
      model.services,
      new AbortController().signal
    )
    assert.equal(outcome.error, "previewChanged")
    assert.equal(model.calls.length, 0)
    assert.ok(outcome.items.every((entry) => entry.state === "notAttempted"))
  }
})

test("an ambiguous committed write is verified without replaying it", async () => {
  const model = fixture()
  const execute = model.services.execute
  model.services.execute = async (...args) => {
    await execute(...args)
    throw new TypeError("Connection lost")
  }
  const outcome = await runSmartPlan(
    planFor(model, "merge-participants"),
    model.services,
    new AbortController().signal
  )
  assert.equal(model.calls.length, 1)
  assert.equal(outcome.acknowledged, false)
  assert.ok(outcome.items.every((entry) => entry.state === "confirmed"))
})

test("partial relationship writes keep unverifiable members and only patch verified effects", async () => {
  const model = fixture()
  model.services.execute = async () => {
    model.snapshot.videos[0].refers.push(reference("b"))
    throw rejected(500)
  }
  const plan = planFor(model, "make-refer")
  const outcome = await runSmartPlan(
    plan,
    model.services,
    new AbortController().signal
  )
  assert.deepEqual(
    outcome.items.map((entry) => entry.state),
    ["confirmed", "unverified"]
  )
  const edits = smartCacheEdits(plan, outcome)
  assert.deepEqual(Object.keys(edits), ["a"])
  assert.deepEqual(
    edits.a.relationships.refers.add.map((entry) => entry.id),
    ["b"]
  )
})

test("catalog lag stays unverified and Check results never repeats the mutation", async () => {
  const model = fixture()
  const before = structuredClone(model.snapshot)
  let stale = true
  const read = model.services.read
  model.services.read = async (action, body, signal, verification) =>
    verification && stale ? structuredClone(before) : read(action, body, signal)
  const plan = planFor(model, "make-simulcast")
  const outcome = await runSmartPlan(
    plan,
    model.services,
    new AbortController().signal
  )
  assert.equal(outcome.acknowledged, true)
  assert.ok(outcome.items.every((entry) => entry.state === "unverified"))
  assert.deepEqual(smartCacheEdits(plan, outcome), {})
  stale = false
  const checked = await checkSmartPlan(plan, model.services, true)
  assert.ok(checked.items.every((entry) => entry.state === "confirmed"))
  assert.equal(model.calls.length, 1)
})

test("omitted relationship fields are unknown rather than empty", () => {
  const model = fixture()
  const plan = planFor(model, "make-simulcast")
  delete model.snapshot.videos[0].simulcasts
  assert.equal(
    verifySmartPlan(plan, model.snapshot, true)[0].state,
    "unverified"
  )
  const dissociation = planFor(model, "dissociate-video", {
    targetVideoId: "c",
  })
  delete model.snapshot.videos[2].clips
  assert.equal(
    verifySmartPlan(dissociation, model.snapshot, true)[0].state,
    "unverified"
  )
})

test("simulcast verification requires the reverse link too", () => {
  const model = fixture()
  const plan = planFor(model, "make-simulcast")
  model.snapshot.videos[0].simulcasts.push(reference("b"))
  assert.ok(
    verifySmartPlan(plan, model.snapshot, true).every(
      (item) => item.state === "unverified"
    )
  )
})

test("401, 403, and 429 stop without mutation retries; 403 refreshes once", async () => {
  for (const status of [401, 403, 429]) {
    const model = fixture()
    let attempts = 0
    model.services.execute = async () => {
      attempts++
      throw rejected(status)
    }
    const outcome = await runSmartPlan(
      planFor(model, "make-refer"),
      model.services,
      new AbortController().signal
    )
    assert.equal(attempts, 1)
    assert.equal(model.refreshes(), status === 403 ? 1 : 0)
    assert.ok(outcome.items.every((entry) => entry.state === "failed"))
  }
})

test("an account change or cancellation during preflight sends no mutation", async () => {
  for (const cancel of [false, true]) {
    const model = fixture()
    const abort = new AbortController()
    const read = model.services.read
    let allowed = true
    model.services.allowed = () => allowed
    model.services.read = async (...args) => {
      const snapshot = await read(...args)
      if (cancel) abort.abort()
      else allowed = false
      return snapshot
    }
    const outcome = await runSmartPlan(
      planFor(model, "remove-mentions"),
      model.services,
      abort.signal
    )
    assert.equal(model.calls.length, 0)
    assert.ok(outcome.items.every((entry) => entry.state === "notAttempted"))
  }
})

test("stopping an in-flight write still performs independent read-back", async () => {
  const model = fixture()
  const abort = new AbortController()
  const execute = model.services.execute
  model.services.execute = async (...args) => {
    await execute(...args)
    abort.abort()
    throw abort.signal.reason
  }
  const outcome = await runSmartPlan(
    planFor(model, "remove-mentions"),
    model.services,
    abort.signal
  )
  assert.equal(model.calls.length, 1)
  assert.ok(outcome.items.every((entry) => entry.state === "confirmed"))
})

test("removal overlays supersede old additions and retain unrelated metadata", () => {
  const id = "cache-smart-removal"
  const original = {
    ...video(id),
    mentions: [{ ...channel("guest"), photo: "photo.jpg" }, channel("other")],
  }
  rememberMentionAdditions(id, [channel("guest")])
  rememberVideoEdit(id, { removeMentions: ["guest"] })
  assert.deepEqual(
    withMentionAdditions(original).mentions.map((entry) => entry.id),
    ["other"]
  )
  rememberMentionAdditions(id, [channel("guest")])
  assert.deepEqual(
    withMentionAdditions(original).mentions.map((entry) => entry.id),
    ["guest", "other"]
  )
  assert.equal(withMentionAdditions(original).mentions[0].photo, "photo.jpg")
})

test("dissociation cache patches preserve reverse references and numeric clip counts", () => {
  const model = fixture()
  model.snapshot.videos[0].refers = [reference("c"), reference("other")]
  model.snapshot.videos[2].refers = [reference("a")]
  const plan = planFor(model, "dissociate-video", { targetVideoId: "c" })
  const edits = smartCacheEdits(plan, {
    items: [{ id: "a", state: "confirmed" }],
    snapshot: model.snapshot,
  })
  rememberVideoEdit("cache-source", edits.a)
  rememberVideoEdit("cache-target", edits.c)
  const source = withMentionAdditions({
    ...video("cache-source"),
    refers: [reference("c"), reference("other")],
  })
  const target = withMentionAdditions({
    ...video("cache-target"),
    clips: 3,
    refers: [reference("a")],
    simulcasts: [reference("a"), reference("other")],
  })
  assert.deepEqual(
    source.refers.map((entry) => entry.id),
    ["other"]
  )
  assert.deepEqual(target.refers, [reference("a")])
  assert.deepEqual(target.simulcasts, [reference("other")])
  assert.equal(target.clips, 3)
  assert.deepEqual(patchMentionLists(target).refers, [reference("a")])
})
