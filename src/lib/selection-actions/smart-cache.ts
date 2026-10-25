import type { VideoCurationEdit } from "../mention-cache"
import type { Video, VideoRef } from "../types"
import type { SmartOutcome, SmartPlan } from "./smart"

function reference(video: Video): VideoRef {
  return {
    id: video.id,
    title: video.title ?? undefined,
    type: video.type,
    status: video.status,
    channel: video.channel,
  }
}

export function smartCacheEdits(
  plan: SmartPlan,
  outcome: Pick<SmartOutcome, "items" | "snapshot">
): Record<string, VideoCurationEdit> {
  const edits: Record<string, VideoCurationEdit> = {}
  for (const item of outcome.items) {
    if (item.state !== "confirmed") continue
    const id = item.id
    if (plan.action === "merge-participants") {
      edits[id] = {
        addMentions: plan.participants.map((participant) => ({
          ...participant,
          ...outcome.snapshot?.mentions[id]?.find(
            (channel) => channel.id === participant.id
          ),
        })),
      }
    } else if (plan.action === "remove-mentions") {
      edits[id] = {
        removeMentions: plan.before.mentions[id].map((channel) => channel.id),
      }
    } else if (plan.action === "dissociate-channel") {
      edits[id] = { removeMentions: [plan.body.channelId!] }
    } else if (
      plan.action === "make-simulcast" ||
      plan.action === "make-refer"
    ) {
      const field = plan.action === "make-simulcast" ? "simulcasts" : "refers"
      edits[id] = {
        relationships: {
          [field]: {
            add: plan.before.videos
              .filter(
                (video) =>
                  plan.body.videoIds.includes(video.id) && video.id !== id
              )
              .map(reference),
          },
        },
      }
    } else {
      const target = plan.body.targetVideoId!
      edits[id] = {
        relationships: {
          sources: { remove: [target] },
          refers: { remove: [target] },
          simulcasts: { remove: [target] },
        },
      }
      const targetEdit = (edits[target] ??= {
        relationships: { clips: { remove: [] }, simulcasts: { remove: [] } },
      })
      targetEdit.relationships!.clips!.remove!.push(id)
      targetEdit.relationships!.simulcasts!.remove!.push(id)
    }
  }
  return edits
}
