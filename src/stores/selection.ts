import { create } from "zustand"
import { createJSONStorage, persist } from "zustand/middleware"

import {
  removeCompletedSelections,
  setSelectedVideos,
  videoRange,
  type SelectedVideo,
  type VideoSelection,
} from "@/lib/selection"
import type { Video } from "@/lib/types"

interface SelectionStore {
  items: VideoSelection
  selecting: boolean
  anchor: { scope: string; id: string } | null
  enter: (initial?: { video: Video; scope: string }) => void
  exit: () => void
  toggle: (video: Video, scope: string) => void
  set: (videos: readonly Video[], selected: boolean) => void
  range: (scope: string, videos: readonly Video[], target: string) => void
  clear: () => void
  removeCompleted: (entries: readonly SelectedVideo[]) => void
}

export const useSelection = create<SelectionStore>()(
  persist(
    (set) => ({
      items: {},
      selecting: false,
      anchor: null,
      enter: (initial) =>
        set((state) => ({
          selecting: true,
          items: initial
            ? setSelectedVideos(state.items, [initial.video], true)
            : state.items,
          anchor: initial
            ? { scope: initial.scope, id: initial.video.id }
            : state.anchor,
        })),
      exit: () => set({ selecting: false, items: {}, anchor: null }),
      toggle: (video, scope) =>
        set((state) => ({
          items: setSelectedVideos(
            state.items,
            [video],
            !state.items[video.id]
          ),
          anchor: { scope, id: video.id },
        })),
      set: (videos, selected) =>
        set((state) => ({
          items: setSelectedVideos(state.items, videos, selected),
        })),
      range: (scope, videos, target) =>
        set((state) => ({
          items: setSelectedVideos(
            state.items,
            videoRange(
              videos,
              state.anchor?.scope === scope ? state.anchor.id : undefined,
              target
            ),
            true
          ),
          anchor:
            state.anchor?.scope === scope
              ? state.anchor
              : { scope, id: target },
        })),
      clear: () => set({ items: {}, anchor: null }),
      removeCompleted: (entries) =>
        set((state) => ({
          items: removeCompletedSelections(state.items, entries),
        })),
    }),
    {
      name: "holodex-v3/selection",
      version: 1,
      storage: createJSONStorage(() => sessionStorage),
      partialize: (state) => ({ items: state.items }),
    }
  )
)

interface SelectionScopes {
  scopes: Record<string, readonly Video[]>
  active: string | null
  register: (id: string, videos: readonly Video[]) => void
  unregister: (id: string) => void
  activate: (id: string) => void
}

export const useSelectionScopes = create<SelectionScopes>((set) => ({
  scopes: {},
  active: null,
  register: (id, videos) =>
    set((state) => ({
      scopes: { ...state.scopes, [id]: videos },
      active: state.active ?? id,
    })),
  unregister: (id) =>
    set((state) => {
      const scopes = { ...state.scopes }
      delete scopes[id]
      return {
        scopes,
        active:
          state.active === id ? (Object.keys(scopes)[0] ?? null) : state.active,
      }
    }),
  activate: (id) =>
    set((state) => (state.active === id ? state : { active: id })),
}))
