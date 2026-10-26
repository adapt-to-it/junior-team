export type Tier = 'haiku' | 'sonnet'

// `paths` and `test` are already normalized: absolute paths, command as argv.
// `lines` is the estimate of the lines the junior writes: the contract ceiling comes from it.
export type Unit = {
  id: string
  paths: string[]
  model: Tier
  lines: number
  reason?: string
  // The units whose code this one uses: its junior starts only after they have passed the test run.
  after?: string[]
  test?: string[]
  // The unit's test uses no shared resources: it runs at once, in parallel with the others.
  light?: boolean
  // The junior works in its own worktree, created from the current state: it does not see the half-written code of the others.
  isolated?: boolean
}

// A board note: the lead writes references, and the mod resolves them when a junior asks.
export type Note = {
  key: string
  refs: string[]
  text?: string
  unit?: string
}

export type Role = 'lead' | 'junior' | 'reviewer'

// A subagent closes only one turn per run: the tokens are those of the whole run.
// `contract` and `code` are characters: the launch prompt and what the junior writes with Edit and Write.
export type AgentRow = {
  unit: string
  role: Role
  model: string
  turns: number
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
  contract: number
  code: number
  lookups: number
  lookupChars: number
  // Unit test runs and whole-file reads outside the unit.
  tests: number
  // Write, Edit and test runs: they do not count toward the call limit.
  writes?: number
  // Calls and writes at the moment of the last resume with SendMessage: the limit applies per round.
  from?: number
  writesFrom?: number
  // Failing tests in the last test run, and whether they dropped compared to the run before: a junior that improves gets one more test run.
  failing?: number
  gaining?: boolean
  reads: number
  // Tool calls of the run: the mod enforces the limit, because maxTurns does not stop a plugin agent.
  toolCalls: number
  // Nudges to write data already: one per IDLE_CALLS threshold.
  nudged?: number
  // True when the run has handed back: a subagent closes only one turn. A message from the lead reopens it.
  done?: boolean
}

declare module 'claude-code' {
  interface PluginState {
    'junior-team': {
      units: Unit[]
      checks: string[][]
      agents: Record<string, AgentRow>
      notes: Record<string, Note>
      // The index answers already computed, by reference.
      cache: Record<string, string>
      // Per agent, the references already served: a second request does not send them again.
      served: Record<string, string[]>
      misses: string[]
      index: string
      // Failed verifies in a row, per unit.
      failures: Record<string, number>
      // Per unit, the files its juniors wrote with Edit and Write.
      written: Record<string, string[]>
      // The code the main thread writes itself, in characters: with Edit and Write, and estimated from the Bash commands that write files.
      // `solo` restarts at each user request, plan and verify; `noticed` counts the warnings already given since then.
      architect: { code: number; bash: number; solo: number; noticed: number }
      // Per unit, whether the last test run or verify passed: it unlocks the units that follow it.
      passed: Record<string, boolean>
      // The context tokens of the main thread's last response.
      context: number
      root: string
      // True since `plan` found the context over the threshold, until a compaction or a lighter response brings it back below.
      heavy: boolean
      isolates: Record<string, string>
    }
  }
}
