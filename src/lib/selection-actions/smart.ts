import type { ChannelSummary, Video, VideoRef } from "../types"

export const SMART_ACTIONS = [
  {
    id: "merge-participants",
    label: "curation.smart.merge-participants",
    minimum: 2,
    maximum: 12,
  },
  {
    id: "make-simulcast",
    label: "curation.smart.make-simulcast",
    minimum: 2,
    maximum: 12,
  },
  {
    id: "make-refer",
    label: "curation.smart.make-refer",
    minimum: 2,
    maximum: 4,
  },
  {
    id: "dissociate-video",
    label: "curation.smart.dissociate-video",
    minimum: 1,
    maximum: 20,
    destructive: true,
  },
  {
    id: "dissociate-channel",
    label: "curation.smart.dissociate-channel",
    minimum: 1,
    maximum: 50,
    destructive: true,
  },
  {
    id: "remove-mentions",
    label: "curation.smart.remove-mentions",
    minimum: 1,
    maximum: 50,
    destructive: true,
  },
] as const

export type SmartActionId = (typeof SMART_ACTIONS)[number]["id"]
export interface SmartPageContext {
  pageVideoId?: string
  pageChannelId?: string
}
export interface SmartParams {
  targetVideoId?: string
  channelId?: string
  includePageVideo?: boolean
}
export interface SmartBody extends SmartPageContext {
  videoIds: readonly string[]
  targetVideoId?: string
  channelId?: string
}
export interface SmartSnapshot {
  videos: readonly Video[]
  mentions: Record<string, ChannelSummary[]>
}
export interface SmartPlan {
  action: SmartActionId
  body: Readonly<SmartBody>
  before: SmartSnapshot
  participants: readonly ChannelSummary[]
  changes: number
}
export interface SmartItemResult {
  id: string
  state: "confirmed" | "unverified" | "failed" | "notAttempted"
}
export interface SmartOutcome {
  items: SmartItemResult[]
  acknowledged: boolean
  attempted: boolean
  error?: string
  snapshot?: SmartSnapshot
}
export interface SmartServices {
  read: (
    action: SmartActionId,
    body: SmartBody,
    signal: AbortSignal,
    verification?: boolean
  ) => Promise<SmartSnapshot>
  execute: (
    action: SmartActionId,
    body: SmartBody,
    signal: AbortSignal
  ) => Promise<unknown>
  allowed: () => boolean
  forbidden: () => Promise<void>
}

export function smartPageContext(path: string): SmartPageContext {
  const match = /^\/(watch|channel)\/([^/]+)/.exec(path)
  if (!match) return {}
  try {
    return match[1] === "watch"
      ? { pageVideoId: decodeURIComponent(match[2]) }
      : { pageChannelId: decodeURIComponent(match[2]) }
  } catch {
    return {}
  }
}

export function videoTargetId(input: string): string {
  let value = input.trim()
  if (/^https?:\/\//i.test(value)) {
    const url = new URL(value)
    value =
      url.hostname === "youtu.be"
        ? url.pathname.slice(1).split("/")[0]
        : (url.searchParams.get("v") ??
          /^\/watch\/(.+)/.exec(url.pathname)?.[1] ??
          "")
    try {
      value = decodeURIComponent(value)
    } catch {
      throw new Error("targetRequired")
    }
  }
  if (!/^[\w:-]{1,200}$/.test(value)) throw new Error("targetRequired")
  return value
}

export function smartActionIssue(
  action: SmartActionId,
  videos: readonly Video[]
): string | null {
  const definition = SMART_ACTIONS.find((entry) => entry.id === action)!
  const unique = [...new Map(videos.map((video) => [video.id, video])).values()]
  if (unique.length < definition.minimum) return "tooFew"
  if (unique.length > definition.maximum) return "tooMany"
  if (
    action === "make-simulcast" &&
    unique.some((video) => video.type !== "stream")
  )
    return "streamsOnly"
  if (
    (action === "make-refer" || action === "merge-participants") &&
    unique.some(
      (video) =>
        video.type === "placeholder" || video.type === "legacy-placeholder"
    )
  )
    return "noPlaceholders"
  return null
}

export function smartBody(
  action: SmartActionId,
  videos: readonly Video[],
  params: SmartParams,
  page: SmartPageContext = {}
): SmartBody {
  const ids = new Set(videos.map((video) => video.id))
  if (
    params.includePageVideo &&
    page.pageVideoId &&
    ["merge-participants", "make-simulcast", "make-refer"].includes(action)
  )
    ids.add(page.pageVideoId)
  const targetVideoId =
    action === "dissociate-video"
      ? videoTargetId(params.targetVideoId ?? page.pageVideoId ?? "")
      : undefined
  if (targetVideoId) ids.delete(targetVideoId)
  const channelId =
    action === "dissociate-channel"
      ? (params.channelId ?? page.pageChannelId)?.trim()
      : undefined
  if (action === "dissociate-channel" && !channelId)
    throw new Error("channelRequired")
  const definition = SMART_ACTIONS.find((entry) => entry.id === action)!
  if (ids.size < definition.minimum) throw new Error("tooFew")
  if (ids.size > definition.maximum) throw new Error("tooMany")
  if ([...ids].some((id) => !id.trim())) throw new Error("targetRequired")
  return Object.freeze({
    ...page,
    videoIds: Object.freeze([...ids]),
    ...(targetVideoId ? { targetVideoId } : {}),
    ...(channelId ? { channelId } : {}),
  })
}

export function isMentionSmartAction(action: SmartActionId): boolean {
  return (
    action === "merge-participants" ||
    action === "dissociate-channel" ||
    action === "remove-mentions"
  )
}

function findVideo(snapshot: SmartSnapshot, id: string): Video {
  const video = snapshot.videos.find((entry) => entry.id === id)
  if (!video) throw new Error("videoMissing")
  return video
}

function references(
  video: Video,
  field: "simulcasts" | "refers" | "sources" | "clips"
): readonly VideoRef[] | undefined {
  const value = video[field]
  return value === null ? [] : Array.isArray(value) ? value : undefined
}

function idsKey(ids: readonly string[]): string {
  return [...new Set(ids)].sort().join("\n")
}

function dissociationKey(snapshot: SmartSnapshot, body: SmartBody): string {
  const target = findVideo(snapshot, body.targetVideoId!)
  const links = body.videoIds.map((id) => {
    const video = findVideo(snapshot, id)
    return [
      id,
      ...["sources", "refers", "simulcasts"].map(
        (field) =>
          references(video, field as "sources")?.some(
            (reference) => reference.id === target.id
          ) ?? "unknown"
      ),
      references(target, "clips")?.some((reference) => reference.id === id) ??
        "unknown",
      references(target, "simulcasts")?.some(
        (reference) => reference.id === id
      ) ?? "unknown",
    ]
  })
  return JSON.stringify(links)
}

export function planSmartAction(
  action: SmartActionId,
  body: SmartBody,
  snapshot: SmartSnapshot
): SmartPlan {
  const videos = body.videoIds.map((id) => findVideo(snapshot, id))
  const issue = smartActionIssue(action, videos)
  if (issue) throw new Error(issue)
  const participants = new Map<string, ChannelSummary>()
  if (action === "merge-participants") {
    for (const video of videos) {
      for (const channel of [...snapshot.mentions[video.id], video.channel]) {
        if (!channel.type) throw new Error("participantTypeUnknown")
        if (channel.type === "vtuber")
          participants.set(channel.id, { ...channel })
      }
    }
  }
  let changes: number
  if (action === "merge-participants") {
    changes = videos.reduce(
      (count, video) =>
        count +
        [...participants.keys()].filter(
          (id) =>
            !snapshot.mentions[video.id].some((channel) => channel.id === id)
        ).length,
      0
    )
    if (changes > 500) throw new Error("tooManyChanges")
  } else if (action === "make-simulcast" || action === "make-refer") {
    changes =
      (videos.length * (videos.length - 1)) /
      (action === "make-simulcast" ? 2 : 1)
  } else if (action === "dissociate-channel") {
    changes = videos.filter((video) =>
      snapshot.mentions[video.id].some(
        (channel) => channel.id === body.channelId
      )
    ).length
  } else if (action === "remove-mentions") {
    changes = videos.reduce(
      (count, video) => count + snapshot.mentions[video.id].length,
      0
    )
  } else {
    findVideo(snapshot, body.targetVideoId!)
    changes = videos.length
  }
  return Object.freeze({
    action,
    body: Object.freeze({
      ...body,
      videoIds: Object.freeze([...body.videoIds]),
    }),
    before: structuredClone(snapshot),
    participants: Object.freeze([...participants.values()]),
    changes,
  })
}

function previewStillMatches(plan: SmartPlan, current: SmartSnapshot): boolean {
  if (
    plan.action === "remove-mentions" ||
    plan.action === "merge-participants"
  ) {
    if (
      !plan.body.videoIds.every(
        (id) =>
          idsKey(plan.before.mentions[id].map((channel) => channel.id)) ===
          idsKey(current.mentions[id].map((channel) => channel.id))
      )
    )
      return false
    if (plan.action === "merge-participants") {
      const updated = planSmartAction(plan.action, plan.body, current)
      return (
        idsKey(updated.participants.map((channel) => channel.id)) ===
        idsKey(plan.participants.map((channel) => channel.id))
      )
    }
  }
  if (plan.action === "dissociate-channel")
    return plan.body.videoIds.every(
      (id) =>
        plan.before.mentions[id].some(
          (channel) => channel.id === plan.body.channelId
        ) ===
        current.mentions[id].some(
          (channel) => channel.id === plan.body.channelId
        )
    )
  if (plan.action === "dissociate-video")
    return (
      dissociationKey(plan.before, plan.body) ===
      dissociationKey(current, plan.body)
    )
  return true
}

export function verifySmartPlan(
  plan: SmartPlan,
  snapshot: SmartSnapshot,
  acknowledged: boolean
): SmartItemResult[] {
  return plan.body.videoIds.map((id) => {
    let verified = false
    if (plan.action === "merge-participants")
      verified = plan.participants.every((participant) =>
        snapshot.mentions[id]?.some((channel) => channel.id === participant.id)
      )
    else if (plan.action === "dissociate-channel")
      verified =
        Array.isArray(snapshot.mentions[id]) &&
        !snapshot.mentions[id].some(
          (channel) => channel.id === plan.body.channelId
        )
    else if (plan.action === "remove-mentions")
      verified =
        Array.isArray(snapshot.mentions[id]) &&
        snapshot.mentions[id].length === 0
    else {
      const video = snapshot.videos.find((entry) => entry.id === id)
      if (
        video &&
        (plan.action === "make-simulcast" || plan.action === "make-refer")
      ) {
        const links = references(
          video,
          plan.action === "make-simulcast" ? "simulcasts" : "refers"
        )
        verified =
          links !== undefined &&
          plan.body.videoIds
            .filter((other) => other !== id)
            .every(
              (other) =>
                links.some((reference) => reference.id === other) &&
                (plan.action !== "make-simulcast" ||
                  snapshot.videos.some(
                    (otherVideo) =>
                      otherVideo.id === other &&
                      references(otherVideo, "simulcasts")?.some(
                        (reference) => reference.id === id
                      )
                  ))
            )
      } else if (video) {
        const target = snapshot.videos.find(
          (entry) => entry.id === plan.body.targetVideoId
        )
        const fields = ["sources", "refers", "simulcasts"] as const
        const beforeKey = dissociationKey(plan.before, {
          ...plan.body,
          videoIds: [id],
        })
        verified =
          !!target &&
          fields.every((field) =>
            references(video, field)?.every(
              (reference) => reference.id !== target.id
            )
          ) &&
          references(target, "clips")?.every(
            (reference) => reference.id !== id
          ) === true &&
          references(target, "simulcasts")?.every(
            (reference) => reference.id !== id
          ) === true &&
          (acknowledged || beforeKey.includes("true"))
      }
    }
    return { id, state: verified ? "confirmed" : "unverified" }
  })
}

export async function checkSmartPlan(
  plan: SmartPlan,
  services: SmartServices,
  acknowledged: boolean,
  signal = AbortSignal.timeout(20_000)
): Promise<Pick<SmartOutcome, "items" | "snapshot">> {
  try {
    const snapshot = await services.read(plan.action, plan.body, signal, true)
    return { snapshot, items: verifySmartPlan(plan, snapshot, acknowledged) }
  } catch {
    return {
      items: plan.body.videoIds.map((id) => ({ id, state: "unverified" })),
    }
  }
}

export async function runSmartPlan(
  plan: SmartPlan,
  services: SmartServices,
  signal: AbortSignal
): Promise<SmartOutcome> {
  const stopped = (error: string): SmartOutcome => ({
    items: plan.body.videoIds.map((id) => ({ id, state: "notAttempted" })),
    acknowledged: false,
    attempted: false,
    error,
  })
  if (signal.aborted || !services.allowed())
    return stopped(signal.aborted ? "stopped" : "sessionChanged")
  try {
    const current = await services.read(plan.action, plan.body, signal)
    planSmartAction(plan.action, plan.body, current)
    if (!previewStillMatches(plan, current)) return stopped("previewChanged")
  } catch (error) {
    return stopped(
      signal.aborted
        ? "stopped"
        : error instanceof Error &&
            [
              "streamsOnly",
              "noPlaceholders",
              "videoMissing",
              "participantTypeUnknown",
            ].includes(error.message)
          ? error.message
          : "readFailed"
    )
  }
  if (signal.aborted || !services.allowed())
    return stopped(signal.aborted ? "stopped" : "sessionChanged")
  let acknowledged = false
  let errorMessage: string | undefined
  try {
    await services.execute(
      plan.action,
      plan.body,
      AbortSignal.any([signal, AbortSignal.timeout(30_000)])
    )
    acknowledged = true
  } catch (error) {
    const status =
      error && typeof error === "object" && "status" in error
        ? error.status
        : undefined
    if (typeof status === "number" && status >= 400 && status < 500) {
      if (status === 403) {
        try {
          await services.forbidden()
        } catch {
          errorMessage = "forbidden"
        }
      }
      return {
        items: plan.body.videoIds.map((id) => ({ id, state: "failed" })),
        acknowledged: false,
        attempted: true,
        error:
          errorMessage ??
          (status === 403
            ? "forbidden"
            : status === 401
              ? "sessionChanged"
              : status === 429
                ? "rateLimited"
                : "rejected"),
      }
    }
    errorMessage = "unknown"
  }
  const verified = await checkSmartPlan(plan, services, acknowledged)
  return {
    ...verified,
    acknowledged,
    attempted: true,
    error: verified.items.every((item) => item.state === "confirmed")
      ? undefined
      : errorMessage,
  }
}
