export type ToolHistoryKind = 'skill' | 'mcp' | 'subagent'

export type ToolHistoryEntry = {
  // The tool_use_id of the call.
  id: string
  kind: ToolHistoryKind
  name: string
  source: string
  startedAt: number
  endedAt?: number
  isFailed: boolean
  // The id of the subagent entry this call ran under.
  parentId?: string
  // A subagent's own loop id, which its calls carry as `agentId`.
  agentId?: string
  // A skill whose source skill.prompt has not told yet.
  isSourcePending?: boolean
  // A background subagent, which ends at its turn.complete.
  isBackground?: boolean
}

export type ToolHistory = { sessionId: string; entries: ToolHistoryEntry[] }

declare module 'claude-code' {
  interface PluginState {
    'tool-history': { history: Shaped<ToolHistory> }
  }
}
