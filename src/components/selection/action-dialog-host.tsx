import { useSelectionAction } from "@/stores/selection-action"
import { MentionActionDialog } from "./mention-action-dialog"
import { SmartActionDialog } from "./smart-action-dialog"

export function SelectionActionHost() {
  const request = useSelectionAction((state) => state.request)
  if (!request) return null
  return request.action === "add-mentions" ? (
    <MentionActionDialog key={request.id} request={request} />
  ) : (
    <SmartActionDialog
      key={request.id}
      request={request}
      action={request.action}
    />
  )
}
