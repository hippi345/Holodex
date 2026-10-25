import type { ChannelSummary, Video } from "../types"

export const MENTION_VIDEO_LIMIT = 50
export const MENTION_CHANNEL_LIMIT = 5
export const MENTION_OPERATION_LIMIT = 100

export interface MentionOperation {
  videoId: string
  channelId: string
  skip: "uploader" | "existing" | "placeholder" | null
}

export interface MentionPlan {
  videos: readonly Video[]
  channelIds: readonly string[]
  operations: readonly MentionOperation[]
  requests: number
}

export type MentionState =
  | "pending"
  | "checking"
  | "skipped"
  | "confirmed"
  | "failed"
  | "unknown"
  | "notAttempted"

export interface MentionResult {
  operation: MentionOperation
  state: MentionState
  error?: string
}

export interface MentionServices {
  read: (
    ids: string[],
    signal?: AbortSignal
  ) => Promise<Record<string, ChannelSummary[]>>
  add: (
    videoId: string,
    channelId: string,
    signal?: AbortSignal
  ) => Promise<unknown>
  allowed: () => boolean
  forbidden: () => Promise<void>
  progress: (results: readonly MentionResult[]) => void
}

export function planMentionAdditions(
  videos: readonly Video[],
  channelIds: readonly string[],
  mentions: Record<string, ChannelSummary[]>
): MentionPlan {
  const uniqueVideos = [
    ...new Map(videos.map((video) => [video.id, video])).values(),
  ]
  const uniqueChannels = [...new Set(channelIds)]
  if (!uniqueVideos.length || uniqueVideos.length > MENTION_VIDEO_LIMIT)
    throw new Error("videoLimit")
  if (
    !uniqueChannels.length ||
    uniqueChannels.length > MENTION_CHANNEL_LIMIT ||
    uniqueChannels.some((id) => !id.trim())
  )
    throw new Error("channelLimit")
  const operations = uniqueVideos.flatMap((video) =>
    uniqueChannels.map((channelId): MentionOperation => ({
      videoId: video.id,
      channelId,
      skip:
        video.type === "placeholder" || video.type === "legacy-placeholder"
          ? "placeholder"
          : video.channel.id === channelId
            ? "uploader"
            : mentions[video.id]?.some((channel) => channel.id === channelId)
              ? "existing"
              : null,
    }))
  )
  const requests = operations.filter((operation) => !operation.skip).length
  if (requests > MENTION_OPERATION_LIMIT) throw new Error("operationLimit")
  return Object.freeze({
    videos: Object.freeze(uniqueVideos),
    channelIds: Object.freeze(uniqueChannels),
    operations: Object.freeze(
      operations.map((operation) => Object.freeze(operation))
    ),
    requests,
  })
}

function statusOf(error: unknown): number | undefined {
  return error &&
    typeof error === "object" &&
    "status" in error &&
    typeof error.status === "number"
    ? error.status
    : undefined
}

export async function runMentionPlan(
  plan: MentionPlan,
  services: MentionServices,
  signal: AbortSignal
): Promise<{
  results: MentionResult[]
  mentions: Record<string, ChannelSummary[]>
  completedIds: string[]
}> {
  const results: MentionResult[] = plan.operations.map((operation) => ({
    operation,
    state:
      operation.skip === "uploader" || operation.skip === "placeholder"
        ? "skipped"
        : "pending",
  }))
  let canonical: Record<string, ChannelSummary[]> = {}
  const publish = () =>
    services.progress(results.map((result) => ({ ...result })))
  const finish = () => ({
    results,
    mentions: canonical,
    completedIds: plan.videos
      .filter((video) =>
        results
          .filter((result) => result.operation.videoId === video.id)
          .every(
            (result) =>
              result.state === "confirmed" || result.state === "skipped"
          )
      )
      .map((video) => video.id),
  })
  publish()
  if (signal.aborted || !services.allowed()) {
    results.forEach((result) => {
      result.state = "notAttempted"
    })
    publish()
    return finish()
  }
  try {
    canonical = await services.read(
      plan.videos.map((video) => video.id),
      signal
    )
  } catch {
    results.forEach((result) => {
      result.state = "notAttempted"
      result.error = "readFailed"
    })
    publish()
    return finish()
  }
  const attempted = new Set<string>()
  for (const result of results) {
    const { videoId, channelId, skip } = result.operation
    if (signal.aborted || !services.allowed()) break
    if (skip === "uploader" || skip === "placeholder") continue
    if (canonical[videoId]?.some((channel) => channel.id === channelId)) {
      result.state = "skipped"
      continue
    }
    if (skip === "existing") {
      result.state = "failed"
      result.error = "previewChanged"
      continue
    }
    attempted.add(videoId)
    result.state = "checking"
    let stop = false
    try {
      await services.add(videoId, channelId, signal)
    } catch (error) {
      const status = statusOf(error)
      if (status !== undefined && status >= 400 && status < 500) {
        result.state = "failed"
        result.error =
          status === 403
            ? "forbidden"
            : status === 401
              ? "sessionChanged"
              : status === 429
                ? "rateLimited"
                : "rejected"
      } else {
        result.state = "unknown"
        result.error = "unknown"
      }
      if (status === 403) {
        try {
          await services.forbidden()
        } catch {
          result.error = "forbidden"
        }
      }
      stop = true
    }
    publish()
    if (stop) break
  }
  results.forEach((result) => {
    if (result.state === "pending") result.state = "notAttempted"
  })
  if (attempted.size) {
    try {
      const verified = await services.read(
        [...attempted],
        AbortSignal.timeout(15_000)
      )
      canonical = { ...canonical, ...verified }
      for (const result of results) {
        if (
          result.state !== "checking" &&
          result.state !== "unknown" &&
          result.state !== "failed"
        )
          continue
        if (
          verified[result.operation.videoId]?.some(
            (channel) => channel.id === result.operation.channelId
          )
        ) {
          result.state = "confirmed"
          result.error = undefined
        } else if (result.state === "checking") {
          result.state = "failed"
          result.error = "notApplied"
        }
      }
    } catch {
      for (const result of results) {
        if (result.state === "unknown" || result.state === "checking") {
          result.state = "unknown"
          result.error = "unknown"
        }
      }
    }
  }
  publish()
  return finish()
}
