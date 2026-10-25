import type { Video } from "./types"

export const SELECTION_LIMIT = 200

export interface SelectedVideo {
  video: Video
  token: string
}

export type VideoSelection = Record<string, SelectedVideo>

function snapshotVideo(video: Video): Video {
  return {
    id: video.id,
    title: video.title,
    type: video.type,
    status: video.status,
    channel: { ...video.channel },
    thumbnail: video.thumbnail,
    placeholderType: video.placeholderType,
    link: video.link,
  }
}

export function setSelectedVideos(
  selection: VideoSelection,
  videos: readonly Video[],
  selected: boolean,
  token: () => string = () => crypto.randomUUID()
): VideoSelection {
  const next = { ...selection }
  let count = Object.keys(next).length
  for (const video of videos) {
    if (!selected) {
      if (next[video.id]) count--
      delete next[video.id]
    } else if (!next[video.id] && count < SELECTION_LIMIT) {
      next[video.id] = { video: snapshotVideo(video), token: token() }
      count++
    }
  }
  return next
}

export function videoRange(
  videos: readonly Video[],
  anchor: string | undefined,
  target: string
): Video[] {
  const end = videos.findIndex((video) => video.id === target)
  if (end < 0) return []
  const start = videos.findIndex((video) => video.id === anchor)
  return start < 0
    ? [videos[end]]
    : videos.slice(Math.min(start, end), Math.max(start, end) + 1)
}

export function removeCompletedSelections(
  selection: VideoSelection,
  completed: readonly SelectedVideo[]
): VideoSelection {
  const next = { ...selection }
  for (const entry of completed) {
    if (next[entry.video.id]?.token === entry.token) delete next[entry.video.id]
  }
  return next
}
