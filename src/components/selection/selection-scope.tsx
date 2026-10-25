import {
  createContext,
  useContext,
  useEffect,
  useId,
  useMemo,
  type ReactNode,
} from "react"

import type { Video } from "@/lib/types"
import { useSelectionScopes } from "@/stores/selection"

const ScopeContext = createContext<{
  id: string
  videos: readonly Video[]
} | null>(null)

export function SelectionScope({
  id,
  videos,
  children,
}: {
  id: string
  videos: readonly Video[]
  children: ReactNode
}) {
  const instance = useId()
  const scopeId = `${id}:${instance}`
  const scope = useMemo(() => ({ id: scopeId, videos }), [scopeId, videos])
  useEffect(() => {
    useSelectionScopes.getState().register(scopeId, videos)
  }, [scopeId, videos])
  useEffect(
    () => () => useSelectionScopes.getState().unregister(scopeId),
    [scopeId]
  )
  return <ScopeContext.Provider value={scope}>{children}</ScopeContext.Provider>
}

export function useSelectionScope() {
  return useContext(ScopeContext)
}
