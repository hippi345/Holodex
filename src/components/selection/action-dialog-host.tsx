import { lazy, Suspense } from "react"

import { useSelectionAction } from "@/stores/selection-action"

const MentionActionDialog = lazy(() =>
  import("./mention-action-dialog").then((module) => ({
    default: module.MentionActionDialog,
  }))
)

const SmartActionDialog = lazy(() =>
  import("./smart-action-dialog").then((module) => ({
    default: module.SmartActionDialog,
  }))
)

export function SelectionActionHost() {
  const request = useSelectionAction((state) => state.request)
  if (!request) return null
  return (
    <Suspense fallback={null}>
      {request.action === "add-mentions" ? (
        <MentionActionDialog key={request.id} request={request} />
      ) : (
        <SmartActionDialog
          key={request.id}
          request={request}
          action={request.action}
        />
      )}
    </Suspense>
  )
}
