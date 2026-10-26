/** `wait`: needs the person; `hold`: waits on its own agents, background work or a plan's approval. */
export type OrchestraStatus = 'run' | 'wait' | 'hold' | 'idle' | 'done' | 'fail'

export type OrchestraNode = {
  id: string
  parentId: string | null
  kind: 'main' | 'agent' | 'session'
  label: string
  type: string
  status: OrchestraStatus
  model?: string
  calls: number
  lastTool?: string
  lastAt?: number
  startedAt: number
  endedAt?: number
  result?: string
  /** The task the agent was given (its prompt), cut short. */
  task?: string
  /** The latest tool call with its main argument: `Bash ls -la`. */
  action?: string
  /** Files this node edited or wrote. */
  edited?: string[]
  /** Its most repeated action and how often it ran. */
  repeat?: { action: string; count: number }
  /** What its own model requests cost, in US dollars, when the host keeps a ledger. */
  costUsd?: number
  /** Tokens its own model requests used: input, cache and output together. */
  tokens?: number
}

export type OrchestraGraph = {
  nodes: OrchestraNode[]
  ctxPercent?: number
  costUsd?: number
  waitMs?: number
  peak?: number
  startedAt?: number
  now: number
}

export type OrchestraCounter = { calls: number; lastTool?: string; lastAt?: number }

/** What the session has seen so far, kept in $.state so a reload loses none of it. */
export type OrchestraHistory = {
  sessionStartedAt: number
  mainModel?: string
  waitMs: number
  peak: number
  counters: Record<string, OrchestraCounter>
  models: Record<string, string>
  startedAt: Record<string, number>
  endedAt: Record<string, number>
  results: Record<string, string>
  tasks: Record<string, string>
  actions: Record<string, string>
  edited: Record<string, string[]>
  /** Per node, how often each action ran; capped so a long run stays small. */
  seen: Record<string, Record<string, number>>
  /** Per node, dollars and tokens its own requests used. */
  costs: Record<string, number>
  tokens: Record<string, number>
  /** The session's cost when the last request was attributed; the next one's share is the difference. */
  lastUsd: number
  sideSessions: OrchestraNode[]
  /** Every agent seen in the agent list, so one the list drops when it ends stays on the graph. */
  agents: Record<string, { label: string; type: string; parentId: string | null; status: OrchestraStatus }>
}

declare module 'claude-code' {
  interface PluginState {
    orchestra: {
      isOn: boolean
      graph: OrchestraGraph
      history: OrchestraHistory | null
      /** The clock the pane draws ages with, ticked only while something is live. */
      now: number
      /** Whether folded finished agents are shown. */
      isFoldOpen: boolean
    }
  }
}
