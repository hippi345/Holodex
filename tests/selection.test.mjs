import assert from "node:assert/strict"
import test from "node:test"
import {
  removeCompletedSelections,
  SELECTION_LIMIT,
  setSelectedVideos,
  videoRange,
} from "../src/lib/selection.ts"
import { can } from "../src/lib/permissions.ts"

const video = (id) => ({
  id,
  type: "stream",
  status: "live",
  channel: { id: "uploader", name: "Uploader" },
})

test("range follows the supplied display order and tolerates a missing anchor", () => {
  const videos = ["a", "c", "b", "d"].map(video)
  assert.deepEqual(
    videoRange(videos, "c", "d").map((item) => item.id),
    ["c", "b", "d"]
  )
  assert.deepEqual(
    videoRange(videos, "d", "c").map((item) => item.id),
    ["c", "b", "d"]
  )
  assert.deepEqual(
    videoRange(videos, "missing", "b").map((item) => item.id),
    ["b"]
  )
  assert.deepEqual(videoRange(videos, "a", "missing"), [])
})

test("selection deduplicates and enforces its limit without losing existing items", () => {
  const original = setSelectedVideos({}, [video("old")], true, () => "original")
  const next = setSelectedVideos(
    original,
    Array.from({ length: 250 }, (_, index) => video(String(index))),
    true
  )
  assert.equal(Object.keys(next).length, SELECTION_LIMIT)
  assert.equal(next.old.token, "original")
  assert.deepEqual(Object.keys(original), ["old"])
  const restored = JSON.parse(JSON.stringify(next))
  assert.deepEqual(
    Object.values(restored).map(({ video, token }) => [video.id, token]),
    Object.values(next).map(({ video, token }) => [video.id, token])
  )
})

test("completion preserves unrelated items and items deselected then selected again", () => {
  const original = setSelectedVideos(
    {},
    [video("a"), video("b")],
    true,
    () => "first"
  )
  const changed = setSelectedVideos(
    setSelectedVideos(original, [video("a")], false),
    [video("a"), video("c")],
    true,
    () => "second"
  )
  const result = removeCompletedSelections(changed, Object.values(original))
  assert.deepEqual(Object.keys(result).sort(), ["a", "c"])
  assert.equal(result.a.token, "second")
})

test("adding mentions requires a recognized authenticated role", () => {
  assert.equal(can(null, "mention.add"), false)
  for (const role of ["user", "editor", "admin"])
    assert.equal(can({ id: 1, role }, "mention.add"), true)
  assert.equal(can({ role: "unexpected" }, "mention.add"), false)
})
