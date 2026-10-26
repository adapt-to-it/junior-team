import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { AgentRow, Note, Role, Unit } from '../types'
import { isInitialized, isMiss, nodeArgv, outline, parseRef, shape } from './code-index'
import { describeBoard, isVisible, noteChars, parseKeys, parseNotes } from './board'
import {
  addUsage,
  blame,
  failedCount,
  contractBudget,
  describeAgents,
  bashCode,
  describePlan,
  describeWaves,
  isBashWrite,
  isCode,
  FAILURES_TO_STOP,
  emptyRow,
  isInside,
  normalize,
  parsePlan,
  sharedTests,
  shorten,
  tail,
  unitOf,
  waves,
} from './plan'
import { ARCHITECT_RULE, JUNIOR_PROMPT, REVIEWER_PROMPT } from './prompts'
import { closeWorktree, intoWorktree, openWorktree, outOfWorktree, syncWorktree, worktreeDir } from './isolate'
import { openPane, registerView, setHeavy } from './view'

const TOOL = 'mcp__junior-team__team'
const LOOKUP = 'mcp__junior-team__lookup'
const TRIAL = 'mcp__junior-team__test'
const JUNIOR = 'junior-team:junior'
const REVIEWER = 'junior-team:reviewer'
const MAIN = 'lead'
const TEST_TIMEOUT_MS = 300_000
// A failure caused by code in the middle of another junior's work: the test run waits for it to finish, then retries on its own.
const WAIT_MAX_MS = 900_000
const WAIT_STEP_MS = 5_000
// The first indexing of a large project takes minutes.
const INDEX_TIMEOUT_MS = 600_000
const LOOKUP_TIMEOUT_MS = 30_000
const INDEX_READY = 'ready'
// Safety net against Bash loops: the measured median is 7 turns.
const JUNIOR_TURNS_MAX = 30
// Beyond this, the junior reports the failure instead of retrying.
const TRIALS_MAX = 3
// Beyond TRIALS_MAX a test run starts only if the last one reduced the failing tests, up to this cap.
const TRIALS_HARD = 5
// The calls without writes after which the junior is asked to write.
const IDLE_CALLS = [15, 25]
// The measured median is 13 calls; beyond 40 the junior spins idle and rereads the context on every call.
const JUNIOR_CALLS_MAX = 40
// Writes and test runs do not use up the cap: a junior writing in small Edits must not be stopped halfway.
// This cap, on the total, still stops a run that never ends.
const JUNIOR_CALLS_HARD = 60
const isWork = (tool: string): boolean => tool === 'Write' || tool === 'Edit' || tool === TRIAL
const HANDBACK = 'SubagentHandback'
// The most expensive measured reviewer made 34 calls, 30 of them Bash.
const REVIEWER_TURNS_MAX = 16
// Every ~200 lines written by the lead without the team, a notice.
const SOLO_STEP = 8000
// Above this context every lead call rereads too much: better to compact before a wave.
const CONTEXT_HEAVY = 150_000
// Whole-file reads outside the unit before the mod points to the index.
const WHOLE_READS_MAX = 8
// Characters of the file map attached to the read refusal.
const MAP_MAX = 3000

const units = atom({ plugin: 'junior-team', key: 'units' } as const, [])
const checks = atom({ plugin: 'junior-team', key: 'checks' } as const, [])
const agents = atom({ plugin: 'junior-team', key: 'agents' } as const, {})
const notes = atom({ plugin: 'junior-team', key: 'notes' } as const, {})
const cache = atom({ plugin: 'junior-team', key: 'cache' } as const, {})
const served = atom({ plugin: 'junior-team', key: 'served' } as const, {})
const misses = atom({ plugin: 'junior-team', key: 'misses' } as const, [])
const index = atom({ plugin: 'junior-team', key: 'index' } as const, '')
const failures = atom({ plugin: 'junior-team', key: 'failures' } as const, {})
const written = atom({ plugin: 'junior-team', key: 'written' } as const, {})
const architect = atom({ plugin: 'junior-team', key: 'architect' } as const, { code: 0, bash: 0, solo: 0, noticed: 0 })
const context = atom({ plugin: 'junior-team', key: 'context' } as const, 0)
const passed = atom({ plugin: 'junior-team', key: 'passed' } as const, {})
// The work root when the units are outside the session folder, for example in a worktree.
const workRoot = atom({ plugin: 'junior-team', key: 'root' } as const, '')
// The worktrees of the isolated units, by unit id.
const isolates = atom({ plugin: 'junior-team', key: 'isolates' } as const, {} as Record<string, string>)

const projectRoot = async ($: Engine): Promise<string> => (await read($, workRoot)) || $.session.root()

// Units with absolute paths: the root is the git repository that contains them, even inside the session
// (a session opened in the home folder with the units in ~/progetto must not index the home folder).
// Outside the session and without git, their common folder. Relative paths: the session.
const rootFor = async ($: Engine, paths: readonly string[], session: string): Promise<string> => {
  const base = normalize(session, session)
  if (paths.length === 0 || !paths.every(path => path.startsWith('/'))) return ''
  const outside = paths.filter(path => !isInside(normalize(path, base), [base]))
  const split = paths.map(path => normalize(path, base).split('/'))
  const common = split.reduce((acc, parts) => {
    const differ = acc.findIndex((part, i) => part !== parts[i])
    return differ < 0 ? acc : acc.slice(0, differ)
  })
  const dir = (split.length === 1 ? common.slice(0, -1) : common).join('/') || '/'
  const git = await $.process.run(['git', '-C', dir, 'rev-parse', '--show-toplevel'], { timeoutMs: 10_000 }).catch(() => undefined)

  const top = git?.exitCode === 0 ? git.stdout.trim() : ''
  if (top !== '' && top !== base && (outside.length > 0 || isInside(top, [base]))) return top

  return outside.length === paths.length ? dir : ''
}

// Files outside the plan named by a junior's failure: a hint, the attempt counts anyway.
// The test file that the unit's command runs appears in every failure: it is not a hint.
const unowned = (cause: { files: string[]; owners: string[] } | undefined, unit: string, test: readonly string[]): string => {
  const files = (cause?.files ?? []).filter(file => !test.some(arg => {
    const given = arg.replace(/^\.\//, '')
    return given === file || given.endsWith(`/${file}`) || file.endsWith(`/${given}`)
  }))
  return cause === undefined || files.length === 0 || cause.owners.includes(unit)
    ? ''
    : `The output names files that no unit owns: ${files.join(', ')}. If the cause is there, do not fix it: report it.\n\n`
}

const mark = ($: Engine, unit: string, ok: boolean): Promise<unknown> =>
  update($, passed, all => ({ ...all, [unit]: ok })).catch(() => undefined)

type Engine = Pick<EngineInterface, 'state' | 'session' | 'agent' | 'process' | 'env' | 'clock'>

const track = ($: Engine, id: string, edit: (row: AgentRow | undefined) => AgentRow | undefined): Promise<unknown> =>
  update($, agents, all => {
    const row = edit(all?.[id])

    return row === undefined ? (all ?? {}) : { ...all, [id]: row }
  })

// The reason a write is refused, or undefined when the write passes.
// The path an isolated junior really touches: the project's, moved into its worktree.
const placed = async ($: Engine, agentId: string | undefined, file: string): Promise<{ view: string; real: string }> => {
  const row = agentId === undefined ? undefined : (await read($, agents))[agentId]
  const dir = row?.role === 'junior' ? (await read($, isolates))[row.unit] : undefined
  if (dir === undefined) return { view: file, real: file }
  const root = await projectRoot($)
  const view = outOfWorktree(normalize(file, dir), root, dir)

  return { view, real: intoWorktree(view, root, dir) }
}

const refusal = async ($: Engine, agentId: string | undefined, file: string): Promise<string | undefined> => {
  if (agentId === undefined) return undefined
  const row = (await read($, agents))[agentId]
  if (row === undefined) {
    // A junior not yet registered does not write: its scope is not known.
    const known = (await $.agent.list()).find(agent => agent.id === agentId)

    return known?.type === JUNIOR ? 'junior-team: unit not registered yet, retry shortly.' : undefined
  }
  if (row.role !== 'junior') return undefined
  const unit = (await read($, units)).find(one => one.id === row.unit)
  const path = normalize(file, await projectRoot($))
  if (unit !== undefined && isInside(path, unit.paths)) return undefined

  return `junior-team: ${path} is outside the unit ${row.unit} (${unit?.paths.join(', ') ?? 'unit removed from the plan'}). Stop and report it.`
}

// Adds to the junior the characters it has just written, the leverage numerator, and notes the file for the unit's outline.
const wrote = async ($: Engine, agentId: string | undefined, text: string, file: string): Promise<void> => {
  if (agentId === undefined) return
  const row = (await read($, agents))[agentId]
  if (row?.role !== 'junior') return
  const path = normalize(file, await projectRoot($))
  await track($, agentId, known => (known === undefined ? undefined : { ...known, code: known.code + text.length }))
  await update($, written, all => {
    const files = all?.[row.unit] ?? []

    return files.includes(path) ? (all ?? {}) : { ...all, [row.unit]: [...files, path] }
  })
}

// Counts the code the main thread writes on its own and, every SOLO_STEP characters, returns a notice for the model.
const wroteAlone = async ($: Engine, chars: number, viaBash: boolean): Promise<string | undefined> => {
  let notice: string | undefined
  await update($, architect, all => {
    const now = all ?? { code: 0, bash: 0, solo: 0, noticed: 0 }
    const solo = now.solo + chars
    const due = Math.floor(solo / SOLO_STEP) > now.noticed
    if (due) {
      notice =
        `junior-team: in this request you have written about ${Math.round(solo / 40)} lines of code yourself. ` +
        'Every call of yours rereads the whole context: a new block over 80 lines costs less to a haiku junior. ' +
        'If the work continues, invoke the skill junior-team:junior-team and declare a plan. The skeleton is made of signatures and types, without bodies.'
    }

    return {
      code: now.code + (viaBash ? 0 : chars),
      bash: now.bash + (viaBash ? chars : 0),
      solo,
      noticed: due ? Math.floor(solo / SOLO_STEP) : now.noticed,
    }
  })

  return notice
}

// Adds the notice to what the model reads after the tool result.
const withNotice = <R extends { deny?: unknown; context?: readonly string[] }>(out: R, notice: string | undefined): R =>
  notice === undefined || out.deny !== undefined ? out : { ...out, context: [...(out.context ?? []), notice] }

const quiet = ($: Engine): Promise<unknown> => update($, architect, all => ({ ...(all ?? { code: 0, bash: 0 }), solo: 0, noticed: 0 }))

// The interface of what a unit has written: for each file, the symbols it exposes, without bodies.
const card = async ($: Engine, unit: string): Promise<string> => {
  const root = await projectRoot($)
  const files = (await read($, written))[unit] ?? []
  if (files.length === 0) return `${unit}: no file written with Edit or Write.`
  const parts: string[] = []
  for (const file of files) {
    const ref = parseRef(file, root)
    if (typeof ref === 'string') continue
    const ran = await codegraph($, nodeArgv(ref, root), LOOKUP_TIMEOUT_MS)
    parts.push(isMiss(ran.exitCode, ran.stdout) ? `**${ref.file ?? file}** (not indexed)` : outline(ran.stdout))
  }

  return `## ${unit}\n${parts.join('\n')}`
}

// The engine gives each hook 10 seconds of its own and stops the clock only during its `$` calls.
// A wait on any promise or on `$.clock.sleep` uses them up: after 10 seconds the hook is absent
// and the call returns with no response (measured on October 17: queued test runs dropped at 10 seconds).
// The mod's waits therefore go through a `sleep` process, which is a `$` call.
const pause = async ($: Engine, ms: number): Promise<void> => {
  const slept = await $.process.run(['sleep', String(ms / 1000)], { timeoutMs: ms + 5_000 }).catch(() => undefined)
  if (slept === undefined || slept.exitCode !== 0) await $.clock.sleep(ms)
}

// Tests run one at a time: two juniors running together on the same test database break each other
// (measured on October 14: tables already existing, duplicate keys).
let testing = false
const QUEUE_STEP_MS = 1_000
// The lead's SendMessage calls to juniors, until the engine raises them as a resume.
const resumes: { to: string; message: string }[] = []

const takeResume = (prompt: string): string | undefined => {
  const at = resumes.findIndex(one => prompt.includes(one.message.slice(0, 200).trim()))
  if (at < 0) return undefined

  return resumes.splice(at, 1)[0]?.to
}

// Juniors paused while waiting: two juniors that break each other do not wait for each other.
const paused = new Set<string>()

// A light test uses no shared resources and skips the queue. An isolated unit tests in its own worktree.
const run = async ($: Engine, label: string, argv: readonly string[], unit?: Unit): Promise<string> => {
  const queued = unit?.light !== true
  if (queued) {
    while (testing) await pause($, QUEUE_STEP_MS)
    testing = true
  }
  let ran: Ran
  try {
    // The root, not the session folder: a lead's `cd` moves that one, and the tests would run elsewhere.
    const own = unit === undefined ? undefined : (await read($, isolates))[unit.id]
    const cwd = own ?? (await projectRoot($))
    ran = await $.process
      .run(argv, { timeoutMs: TEST_TIMEOUT_MS, cwd })
      .catch((error: unknown) => ({ exitCode: -1, stdout: '', stderr: String(error) }))
  } finally {
    if (queued) testing = false
  }
  if (ran.exitCode === 0) return `ok · ${label} · ${argv.join(' ')}`

  return `FAILED (exit ${ran.exitCode}) · ${label} · ${argv.join(' ')}\n${tail(shorten(`${ran.stdout}\n${ran.stderr}`.trim()))}`
}

type Ran = { exitCode: number; stdout: string; stderr: string }

// `codegraph` runs as a process: indexing and resolving a reference costs no model turns.
const codegraph = async ($: Engine, args: readonly string[], timeoutMs: number): Promise<Ran> => {
  const cwd = await projectRoot($)
  const attempt = (bin: string): Promise<Ran | undefined> =>
    $.process.run([bin, ...args], { timeoutMs, cwd }).then(
      ran => (ran.exitCode === 127 ? undefined : ran),
      () => undefined,
    )
  const first = await attempt('codegraph')
  if (first !== undefined) return first
  // Outside a login shell the PATH may lack the user's binaries folder.
  const home = await (async () => $.env.get('HOME'))().catch(() => undefined)
  const second = typeof home === 'string' ? await attempt(`${home}/.local/bin/codegraph`) : undefined

  return second ?? { exitCode: -1, stdout: '', stderr: 'codegraph is not installed or not on PATH.' }
}

// Prepares the project index: creates it if missing, otherwise aligns it with the files. Returns the state to show.
const prepareIndex = async ($: Engine): Promise<string> => {
  const root = await projectRoot($)
  const status = await codegraph($, ['status', '-j', root], LOOKUP_TIMEOUT_MS)
  const fresh = !isInitialized(status.stdout)
  const built = await codegraph($, fresh ? ['init', '-y', root] : ['sync', '-q', root], INDEX_TIMEOUT_MS)
  const state =
    built.exitCode === 0
      ? `${INDEX_READY}${fresh ? ' (created now in .codegraph)' : ''}`
      : `not available: ${tail(`${built.stdout}\n${built.stderr}`.trim())}`
  await update($, index, () => state)
  await update($, cache, () => ({}))

  return state
}

// Resolves a reference for an agent. Text already served to that agent is not returned a second time.
const resolve = async ($: Engine, agentId: string, text: string, withBody: boolean): Promise<string> => {
  const root = await projectRoot($)
  const ref = parseRef(text, root)
  if (typeof ref === 'string') return ref
  const id = `${ref.file ?? ''}#${ref.symbol ?? ''}${withBody ? '+body' : ''}`
  if (((await read($, served))[agentId] ?? []).includes(id)) return `${text}: already served in this run.`

  let answer = (await read($, cache))[id]
  if (answer === undefined) {
    let ran = await codegraph($, nodeArgv(ref, root), LOOKUP_TIMEOUT_MS)
    if (isMiss(ran.exitCode, ran.stdout) && ref.file !== undefined) {
      // The file may have been created in this wave, written by another junior: the index is aligned and the search repeats.
      await codegraph($, ['sync', '-q', root], INDEX_TIMEOUT_MS)
      ran = await codegraph($, nodeArgv(ref, root), LOOKUP_TIMEOUT_MS)
    }
    if (isMiss(ran.exitCode, ran.stdout)) {
      await update($, misses, all => [...(all ?? []), text])

      return `${text}: not found in the index. If you need it, read the file with Read.`
    }
    const shaped = shape(ran.stdout, withBody)
    answer = shaped
    await update($, cache, all => ({ ...all, [id]: shaped }))
  }
  await update($, served, all => ({ ...all, [agentId]: [...(all?.[agentId] ?? []), id] }))

  return answer
}

// Waits for the juniors still working on the given units, skipping those that are themselves waiting. Returns the units waited for.
const waitFor = async ($: Engine, self: string, owners: readonly string[]): Promise<string[]> => {
  const busy = async (): Promise<string[]> => {
    const rows = await read($, agents)
    return [
      ...new Set(
        (await $.agent.list())
          .filter(agent => agent.status === 'running' && agent.id !== self && !paused.has(agent.id))
          .map(agent => rows[agent.id])
          .filter((row): row is AgentRow => row?.role === 'junior' && owners.includes(row.unit))
          .map(row => row.unit),
      ),
    ]
  }
  const first = await busy()
  if (first.length === 0) return []
  paused.add(self)
  try {
    for (let spent = 0; spent < WAIT_MAX_MS && (await busy()).length > 0; spent += WAIT_STEP_MS) {
      await pause($, WAIT_STEP_MS)
    }
  } finally {
    paused.delete(self)
  }

  return first
}

const waiting = async ($: Engine, plan: { units: Unit[]; checks: string[][] }): Promise<string> => {
  const text = describeWaves(plan, await read($, passed))

  return text === '' ? '' : `\n${text}`
}

const board = async ($: Engine): Promise<string> =>
  describeBoard(await read($, notes), await read($, misses), await read($, index))

// An error inside a mod tool returns to the model as a reason, instead of leaving the call without a response.
const safe = async <R,>(handler: () => Promise<R>): Promise<R | { deny: string }> => {
  try {
    return await handler()
  } catch (error) {
    return { deny: `junior-team: internal error: ${String(error)}` }
  }
}

export const register: Register = on => {
  registerView(on)

  on('session.start', async ($, e, next) => {
    await $.agent.register({
      name: 'junior',
      description:
        'Junior of the contract team: implements a single unit of the declared plan with the team tool. ' +
        'The prompt starts with "UNIT: <id>" and contains the full contract of the unit.',
      prompt: JUNIOR_PROMPT,
      // No Bash: the junior tests its unit with the test tool, which runs only the plan's command.
      tools: ['Read', 'Grep', 'Glob', 'Edit', 'Write', LOOKUP, TRIAL],
      model: 'haiku',
      maxTurns: JUNIOR_TURNS_MAX,
      omitClaudeMd: true,
    })
    await $.agent.register({
      name: 'reviewer',
      description:
        'Independent reviewer of the contract team: verdict on a diff. Only for sensitive areas or when tests are missing.',
      prompt: REVIEWER_PROMPT,
      tools: ['Read', 'Grep', 'Glob', 'Bash', LOOKUP],
      model: 'sonnet',
      maxTurns: REVIEWER_TURNS_MAX,
      omitClaudeMd: true,
    })
    await $.command.register({
      name: 'team-panel',
      description: 'Opens the team panel: units, waves, juniors at work and leverage',
      immediate: true,
    })
    await $.command.register({
      name: 'team-status',
      description: 'Shows the contract team plan and the tokens spent by each agent',
    })
    await $.tool.register({
      name: 'team',
      isDeferred: false,
      description:
        'Contract team. Actions: ' +
        'plan (units: [{id, paths, lines, model?, reason?, test?}], checks?: argv[]) declares the units of work, the files each junior may write, ' +
        'the estimate of the lines it writes (at least 80: below that, you write it yourself), the model (haiku; sonnet only for a unit with two verify failures in a row) and the test commands as argv. ' +
        'The contract cap comes from the estimate: 10 characters of prompt per expected line, at most 8000. A longer prompt does not start. ' +
        'verify (unit?) runs the units\' tests and the checks, and returns only the results and the tail of the failed outputs. ' +
        'note (notes: [{key, refs?, text?, unit?}]) writes pointers on the board that juniors resolve only if needed, ' +
        'refs are "path", "symbol" or "path#symbol" references, text is at most 300 characters, unit limits the note to one unit. ' +
        'The contract cites a note as @key. ' +
        'outline (unit?) returns the interface of what the juniors have written: for each file classes, functions, methods and constants with signatures, without bodies. ' +
        'Use it to integrate and to check signatures in place of Read. ' +
        'status returns the plan, tokens per agent, leverage (code written divided into contract and board), lookups and relaunches. ' +
        'Declare the plan before launching the junior-team:junior agents.',
      inputSchema: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['plan', 'note', 'verify', 'outline', 'status'] },
          units: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                id: { type: 'string' },
                paths: {
                  type: 'array',
                  items: { type: 'string' },
                  description: 'Files or folders the junior may write, disjoint from the other units.',
                },
                lines: {
                  type: 'integer',
                  description: 'Estimate of the lines of code the junior writes. Minimum 80.',
                },
                model: { type: 'string', enum: ['haiku', 'sonnet'] },
                after: {
                  type: 'array',
                  items: { type: 'string' },
                  description:
                    'Ids of this plan\'s units whose code this unit uses beyond the skeleton. The junior starts once they have passed the test.',
                },
                reason: {
                  type: 'string',
                  description: 'With sonnet: why the two failed verifies do not depend on the contract.',
                },
                light: {
                  type: 'boolean',
                  description:
                    'The test uses no shared resources (database, containers, ports): it runs right away, in parallel with the other test runs. Examples: php -l, PHPStan on files, vitest on one file, pytest on one module.',
                },
                isolated: {
                  type: 'boolean',
                  description:
                    'The junior works in its own git worktree, from the current state, with the dependencies linked. Needed when the light test compiles the whole project (tsc, cargo check). On hand-back the unit\'s files return to the main folder.',
                },
                test: {
                  type: 'array',
                  items: { type: 'string' },
                  description: 'Test command as argv, without shell: ["php", "tests/lexer.php"].',
                },
              },
              required: ['id', 'paths', 'lines'],
            },
          },
          checks: {
            type: 'array',
            items: { type: 'array', items: { type: 'string' } },
            description: "Commands for the whole project as argv: acceptance tests, lint, build.",
          },
          notes: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                key: { type: 'string' },
                refs: {
                  type: 'array',
                  items: { type: 'string' },
                  description: 'References the mod resolves from the index: "src/a.ts", "parsePlan", "src/a.ts#parsePlan".',
                },
                text: { type: 'string', description: 'A short decision, at most 300 characters.' },
                unit: { type: 'string', description: 'Only this unit sees the note.' },
              },
              required: ['key'],
            },
          },
          unit: { type: 'string', description: 'For verify and outline: a single unit. The checks run only without unit.' },
        },
        required: ['action'],
      },
    })

    await $.tool.register({
      name: 'test',
      isDeferred: false,
      description:
        "Runs the unit's test for the junior that calls it, with the command declared in the plan, and returns the outcome and the tail of the failed output. " +
        'No arguments. At most 3 runs per junior, up to 5 if each one reduces the failing tests.',
      inputSchema: { type: 'object', properties: {} },
    })
    await $.tool.register({
      name: 'lookup',
      isDeferred: false,
      description:
        'Project index for the contract team. keys is a list of board keys (the contract\'s @key) ' +
        'or references: "path" returns the file\'s symbol map, "symbol" and "path#symbol" return ' +
        'location, signature and comment. body: true adds the body. Ask for all keys in a single call, at most 8.',
      inputSchema: {
        type: 'object',
        properties: {
          keys: { type: 'array', items: { type: 'string' } },
          body: { type: 'boolean' },
        },
        required: ['keys'],
      },
    })

    return next(e)
  })

  on('tool.call', { tool: TRIAL }, async ($, e) =>
    safe(async () => {
    const row = e.agentId === undefined ? undefined : (await read($, agents))[e.agentId]
    if (e.agentId === undefined || row?.role !== 'junior') return { deny: 'test is for juniors: you use verify.' }
    const unit = (await read($, units)).find(one => one.id === row.unit)
    if (unit?.test === undefined) return { result: `The unit ${row.unit} has no test in the plan. Report what you wrote.` }
    if (row.tests >= TRIALS_HARD || (row.tests >= TRIALS_MAX && row.gaining !== true)) {
      return { result: `You have already run the test ${row.tests} times. Stop and report the last failure: the lead decides.` }
    }
    const root = await projectRoot($)
    const all = await read($, units)
    const judge = (text: string) => {
      const cause = text.startsWith('FAILED') ? blame(text, root, all) : undefined
      // A failure that originates in files of another unit is not the junior's and does not use up one of its attempts.
      // Files that no unit owns are not enough: a deprecation warning on config/ names them even when the junior's test is wrong.
      return { cause, foreign: cause !== undefined && cause.owners.length > 0 && !cause.owners.includes(unit.id) }
    }
    let outcome = await run($, unit.id, unit.test, unit)
    let { cause, foreign } = judge(outcome)
    let waited = ''
    if (foreign) {
      const awaited = await waitFor($, e.agentId, cause?.owners ?? [])
      if (awaited.length > 0) {
        outcome = await run($, unit.id, unit.test, unit)
        ;({ cause, foreign } = judge(outcome))
        waited = `I waited for ${awaited.join(', ')} to finish and reran the test. `
      }
    }
    if (!foreign) {
      const failing = failedCount(outcome)
      await track($, e.agentId, known =>
        known === undefined
          ? undefined
          : {
              ...known,
              tests: known.tests + 1,
              failing,
              gaining: failing !== undefined && known.failing !== undefined && failing < known.failing,
            },
      )
    }
    if (outcome.startsWith('ok')) {
      const own = (await read($, isolates))[unit.id]
      if (own !== undefined) await syncWorktree($, root, own, unit.paths)
      await mark($, unit.id, true)
    }

    return {
      result: foreign && cause !== undefined
        ? `${waited}The failure comes from files outside your unit: ${cause.files.join(', ')}` +
          `${cause.owners.length > 0 ? ` (unit ${cause.owners.join(', ')})` : ''}. ` +
          `It is not your error and does not use up an attempt. Do not fix it: if you are done, report it.\n\n${outcome}`
        : `${waited}${unowned(cause, unit.id, unit.test)}${outcome}`,
    }
  }))

  on('tool.call', { tool: LOOKUP }, async ($, e) =>
    safe(async () => {
    const keys = parseKeys(e.keys)
    if (typeof keys === 'string') return { deny: keys }
    // The lead looks up the index even before the plan, to decide the boundaries.
    const known = await read($, index)
    const state = known === '' ? await prepareIndex($) : known
    if (!state.startsWith(INDEX_READY)) return { result: `Index ${state}. Use Read.` }

    const caller = e.agentId ?? MAIN
    const row = (await read($, agents))[caller]
    const unit = row?.role === 'junior' ? row.unit : undefined
    const all: Record<string, Note> = await read($, notes)
    const withBody = e.body === true
    const parts: string[] = []
    for (const given of keys) {
      const key = given.replace(/^@/, '')
      const note = all[key]
      if (note === undefined || !isVisible(note, unit)) {
        parts.push(await resolve($, caller, key, withBody))
        continue
      }
      parts.push(`@${note.key}${note.text === undefined ? '' : `: ${note.text}`}`)
      for (const ref of note.refs) parts.push(await resolve($, caller, ref, withBody))
    }
    const result = parts.join('\n\n')
    if (e.agentId !== undefined) {
      await track($, e.agentId, known =>
        known === undefined ? undefined : { ...known, lookups: known.lookups + 1, lookupChars: known.lookupChars + result.length },
      ).catch(() => undefined)
    }

    return { result }
  }))

  on('command.run', { command: 'team-panel' }, async $ => {
    const opened = await openPane($)

    return { text: opened.isPlaced === false ? `The panel is not drawn: ${opened.reason ?? 'no surface'}. Use /team-status.` : 'Team panel opened.' }
  })

  on('command.run', { command: 'team-status' }, async $ => {
    const plan = { units: await read($, units), checks: await read($, checks) }
    if (plan.units.length === 0) return { text: 'No plan declared in this session.' }

    return {
      text: `${describePlan(plan)}\n\n${describeAgents(await read($, agents), noteChars(await read($, notes)), await read($, failures), await read($, architect))}\n${await board($)}${await waiting($, plan)}`,
    }
  })

  on('tool.call', { tool: TOOL }, async ($, e) =>
    safe(async () => {
    if (e.action === 'plan') {
      const session = await $.session.root()
      const given = Array.isArray(e.units) ? (e.units as { paths?: unknown }[]).flatMap(one => (Array.isArray(one.paths) ? one.paths.filter(p => typeof p === 'string') : [])) : []
      const root = await rootFor($, given, session)
      const plan = parsePlan(e as Record<string, unknown>, root || session, await read($, failures))
      if (typeof plan !== 'string') await update($, workRoot, () => root)
      if (typeof plan === 'string') return { deny: plan }
      await update($, units, () => plan.units)
      await update($, checks, () => plan.checks)
      await quiet($)
      const indexed = await prepareIndex($)
      const size = await read($, context)
      const heavy = size > CONTEXT_HEAVY
      const shared = sharedTests(plan.units, root || session)
      await setHeavy($, heavy)
      void openPane($).catch(() => undefined)

      return {
        result:
          `Plan registered:\n${describePlan(plan)}\nindex · ${indexed}\n` +
          (plan.units.some(unit => unit.after !== undefined)
            ? `waves · ${(waves(plan.units) as string[][]).map((round, at) => `${at + 1}: ${round.join(', ')}`).join(' · ')}. ` +
              'Launch only the first wave now; each unit after, when its dependencies come back with the test passed.\n'
            : '') +
          (shared.length > 0
            ? `Shared tests: ${shared.join('; ')}. A test that covers the code of several units sends every failure to a single junior: ` +
              "put it in the checks, run it with verify at the end of the wave and give each unit a test on its own code.\n"
            : '') +
          (heavy
            ? `Your context is ${Math.round(size / 1000)}K tokens and every call of yours rereads it. ` +
              "Before launching, tell the user that a /compact now lowers the cost of the wave.\n"
            : '') +
          `Launch each junior with subagent_type "${JUNIOR}" and the first line of the prompt "UNIT: <id>". ` +
          'The model is the one in the plan. A prompt over the contract cap does not start.',
      }
    }

    const plan = { units: await read($, units), checks: await read($, checks) }
    if (plan.units.length === 0) return { deny: 'No plan: call plan first.' }

    if (e.action === 'status') {
      return {
        result: `${describePlan(plan)}\n\n${describeAgents(await read($, agents), noteChars(await read($, notes)), await read($, failures), await read($, architect))}\n${await board($)}${await waiting($, plan)}`,
      }
    }

    if (e.action === 'note') {
      const written = parseNotes(e.notes, plan.units)
      if (typeof written === 'string') return { deny: written }
      await update($, notes, all => ({ ...all, ...Object.fromEntries(written.map(note => [note.key, note])) }))

      return { result: `Board updated: ${written.map(note => `@${note.key}`).join(', ')}. Cite them that way in the contract.` }
    }

    const only = typeof e.unit === 'string' ? e.unit : undefined
    if (only !== undefined && !plan.units.some(unit => unit.id === only)) {
      return { deny: `No unit ${only} in the plan.` }
    }

    if (e.action === 'outline') {
      // The files have just been written: the index sees them after the alignment.
      const state = await prepareIndex($)
      if (!state.startsWith(INDEX_READY)) return { result: `Index ${state}. Use Read.` }
      const cards: string[] = []
      for (const unit of plan.units) if (only === undefined || unit.id === only) cards.push(await card($, unit.id))

      return { result: cards.join('\n\n') }
    }

    if (e.action === 'verify') {
      const lines: string[] = []
      for (const unit of plan.units) {
        if (only !== undefined && unit.id !== only) continue
        const line = unit.test ? await run($, unit.id, unit.test) : `no test · ${unit.id}`
        lines.push(line)
        if (unit.test !== undefined) await mark($, unit.id, line.startsWith('ok'))
        const cause = line.startsWith('FAILED') ? blame(line, await projectRoot($), plan.units) : undefined
        if (cause !== undefined && cause.files.length > 0 && !cause.owners.includes(unit.id)) {
          lines.push(
            `  likely cause outside ${unit.id}: ${cause.files.join(', ')}` +
              `${cause.owners.length > 0 ? ` (unit ${cause.owners.join(', ')})` : ' (skeleton or existing code)'}`,
          )
        }
        if (unit.test === undefined) continue
        const failed = line.startsWith('FAILED') ? ((await read($, failures))[unit.id] ?? 0) + 1 : 0
        await update($, failures, all => ({ ...all, [unit.id]: failed }))
        if (failed >= FAILURES_TO_STOP) lines.push(`${unit.id}: ${failed} verifies failed in a row. Stop and report to the user what does not converge.`)
      }
      if (only === undefined) for (const argv of plan.checks) lines.push(await run($, 'check', argv))
      // The juniors have written files: the index sees them from the next round.
      await prepareIndex($)
      await quiet($)
      const next = describeWaves(plan, await read($, passed))
      if (next !== '') lines.push(next)

      return { result: lines.join('\n') }
    }

    return { deny: 'unknown action: use plan, note, verify, outline or status.' }
  }))

  on('agent.spawn', async ($, e, next) => {
    if (e.subagentType !== JUNIOR && e.subagentType !== REVIEWER) return next(e)

    if (e.subagentType === REVIEWER) {
      const started = await next({ ...e, model: e.model ?? 'sonnet' })
      const id = started.agentId
      if (id !== undefined) await track($, id, () => emptyRow('-', 'reviewer', started.model))

      return started
    }

    const id = unitOf(e.prompt)
    // A SendMessage to a paused junior resumes it: the engine raises it as a launch, with the message in place of the contract.
    if (id === undefined) {
      const resumed = takeResume(e.prompt)
      if (resumed !== undefined) return next(e)
    }
    const unit = (await read($, units)).find(one => one.id === id)
    if (unit === undefined) {
      return {
        deny:
          id === undefined
            ? 'junior-team: the first line of a junior\'s prompt is "UNIT: <id>".'
            : `junior-team: no unit ${id} in the plan. Declare the plan with mcp__junior-team__team, action plan. ` +
              "If the tool is not in the session, the plugin did not load: ask the user to run /reload-plugins and do not launch the junior with another agent type.",
      }
    }

    // Waves by dependency: a unit starts when the units whose code it uses have passed the test.
    const done = await read($, passed)
    const missing = (unit.after ?? []).filter(dep => done[dep] !== true)
    if (missing.length > 0) {
      return {
        deny:
          `junior-team: ${unit.id} uses the code of ${missing.join(', ')}, which has not passed the test yet. ` +
          'Launch it when those units have come back with a passing test, or after a verify that gives them ok.',
      }
    }

    // After a compaction the lead may not remember a successful launch: two juniors on the same files overwrite each other.
    const rows = await read($, agents)
    const busy = (await $.agent.list()).some(
      agent => agent.status === 'running' && rows[agent.id]?.role === 'junior' && rows[agent.id]?.unit === unit.id,
    )
    if (busy) {
      return { deny: `junior-team: a junior of unit ${unit.id} is still running. Wait for its hand-back: no need to relaunch it.` }
    }

    const budget = contractBudget(unit.lines)
    if (e.prompt.length > budget) {
      return {
        deny:
          `junior-team: the contract of ${unit.id} is ${e.prompt.length} characters, the cap is ${budget} (${unit.lines} expected lines). ` +
          'Remove what the junior reads on its own: cite the code to reuse as path and symbol, ' +
          'put shared signatures and types in a file on disk, do not repeat rules and style.',
      }
    }

    const root = await projectRoot($)
    let cwd = root
    if (unit.isolated === true) {
      const dir = await worktreeDir($, root, unit.id)
      if (dir === undefined) return { deny: `junior-team: ${unit.id} is isolated, but ${root} is not a git repository. Remove isolated from the plan.` }
      const old = (await read($, isolates))[unit.id]
      if (old !== undefined) await closeWorktree($, root, old, unit.paths)
      const failed = await openWorktree($, root, dir)
      if (failed !== undefined) return { deny: `junior-team: the worktree of ${unit.id} was not created: ${failed}` }
      await update($, isolates, all => ({ ...all, [unit.id]: dir }))
      cwd = dir
    }
    const started = await next({ ...e, model: unit.model, cwd })
    const agentId = started.agentId
    if (agentId !== undefined) {
      await track($, agentId, () => ({ ...emptyRow(unit.id, 'junior', started.model), contract: e.prompt.length }))
      await mark($, unit.id, false)
    }

    return started
  }).catch(($, e, next) =>
    next.called || !e.subagentType.startsWith('junior-team:')
      ? next(e)
      : { deny: 'junior-team: the launch check failed.' },
  )

  // A junior reads the files of its unit whole. Outside it, after a certain number of whole files, it goes through the index or reads in slices.
  on('tool.call', { tool: 'Read' }, async ($, e, next) => {
    const row = e.agentId === undefined ? undefined : (await read($, agents))[e.agentId]
    if (e.agentId === undefined || row?.role !== 'junior') return next(e)
    const at = await placed($, e.agentId, e.file_path)
    const go = () => next(at.real === e.file_path ? e : { ...e, file_path: at.real })
    if (e.limit !== undefined) return go()
    const unit = (await read($, units)).find(one => one.id === row.unit)
    if (unit !== undefined && isInside(normalize(at.view, await projectRoot($)), unit.paths)) return go()
    if (row.reads >= WHOLE_READS_MAX) {
      // The refusal already carries the file map: the junior picks the symbol without one more call.
      const map = await resolve($, e.agentId, e.file_path, false).catch(() => '')
      return {
        deny:
          `junior-team: you have already read ${WHOLE_READS_MAX} whole files outside your unit. ` +
          'Ask lookup for the symbol ("path#symbol", body: true for the body), or read a slice with offset and limit.' +
          (map === '' ? '' : `\n\nFile map:\n${map.slice(0, MAP_MAX)}`),
      }
    }
    await track($, e.agentId, known => (known === undefined ? undefined : { ...known, reads: known.reads + 1 }))

    return go()
  }).catch(($, e, next) => next(e))

  // The scope applies to Edit and Write. Juniors have no Bash.
  on('tool.call', { tool: 'Edit' }, async ($, e, next) => {
    const at = await placed($, e.agentId, e.file_path)
    const why = await refusal($, e.agentId, at.view)
    if (why !== undefined) return { deny: why }
    await wrote($, e.agentId, e.new_string, at.view).catch(() => undefined)
    if (e.agentId !== undefined) return next(at.real === e.file_path ? e : { ...e, file_path: at.real })
    if (!isCode(e.file_path)) return next(e)
    const notice = await wroteAlone($, e.new_string.length, false).catch(() => undefined)

    return withNotice(await next(e), notice)
  }).catch(($, e, next) =>
    next.called || e.agentId === undefined ? next(e) : { deny: 'junior-team: the scope check failed.' },
  )

  on('tool.call', { tool: 'Write' }, async ($, e, next) => {
    const at = await placed($, e.agentId, e.file_path)
    const why = await refusal($, e.agentId, at.view)
    if (why !== undefined) return { deny: why }
    await wrote($, e.agentId, e.content, at.view).catch(() => undefined)
    if (e.agentId !== undefined) return next(at.real === e.file_path ? e : { ...e, file_path: at.real })
    if (!isCode(e.file_path)) return next(e)
    const notice = await wroteAlone($, e.content.length, false).catch(() => undefined)

    return withNotice(await next(e), notice)
  }).catch(($, e, next) =>
    next.called || e.agentId === undefined ? next(e) : { deny: 'junior-team: the scope check failed.' },
  )

  // A new user request is a new task: the count of code written alone starts again.
  on('prompt.submit', async ($, e, next) => {
    await quiet($).catch(() => undefined)

    return next(e)
  }).catch(($, e, next) => (next.called ? { text: e.text } : next(e)))

  // A lead's correction to a junior that has come back is a new round: test runs start from zero.
  on('tool.call', { tool: 'SendMessage' }, async ($, e, next) => {
    const to = typeof e.to === 'string' ? e.to : undefined
    if (e.agentId !== undefined || to === undefined) return next(e)
    const target = (await read($, agents))[to]
    if (target?.role === 'junior' && !(await read($, units)).some(unit => unit.id === target.unit)) {
      // A plan re-declared without the unit takes its scope away: the resumed junior would see every write refused.
      return {
        deny:
          `junior-team: unit ${target.unit} is no longer in the plan, the last plan removed it. ` +
          `Re-declare the plan with ${target.unit} together with the new units, then send the correction again.`,
      }
    }
    if (target?.role === 'junior') {
      // The call cap starts over too: without it, a correction to an already long junior finds no calls left to apply it.
      await track($, to, known =>
        known === undefined
          ? undefined
          : { ...known, tests: 0, failing: undefined, gaining: false, done: false, from: known.toolCalls, writesFrom: known.writes ?? 0, nudged: 0 },
      )
      if (typeof e.message === 'string' && e.message.trim() !== '') resumes.push({ to, message: e.message })
    }

    return next(e)
  }).catch(($, e, next) => next(e))

  // The call cap of the juniors.
  on('tool.call', async ($, e, next) => {
    if (e.agentId === undefined) return next(e)
    const row = (await read($, agents))[e.agentId]
    // Handing back the report does not count: a junior at the cap must be able to report.
    if (row?.role !== 'junior') return next(e)
    if ((e.tool as string) === HANDBACK) {
      // On hand-back the worktree returns to the main folder and disappears: later corrections happen there.
      const dir = (await read($, isolates))[row.unit]
      const unit = (await read($, units)).find(one => one.id === row.unit)
      if (dir !== undefined && unit !== undefined) {
        await closeWorktree($, await projectRoot($), dir, unit.paths)
        await update($, isolates, all => Object.fromEntries(Object.entries(all ?? {}).filter(([id]) => id !== row.unit)))
      }

      return next(e)
    }
    const round = row.toolCalls - (row.from ?? 0)
    const spent = round - ((row.writes ?? 0) - (row.writesFrom ?? 0))
    if (round >= JUNIOR_CALLS_HARD || (spent >= JUNIOR_CALLS_MAX && !isWork(e.tool as string))) {
      return {
        deny: `junior-team: you made ${round} calls, ${spent} without writing. Stop and report what you wrote and what is missing.`,
      }
    }
    // A junior that reads and does not write uses up the round: beyond each IDLE_CALLS threshold it is asked to write, once.
    // Parallel calls advance the counter in jumps: the threshold is compared with >=, not with equality.
    // The check sits inside the update: parallel calls do not get the same nudge.
    let idle = false
    let calls = 0
    await track($, e.agentId, known => {
      if (known === undefined) return undefined
      const nudged = known.nudged ?? 0
      const threshold = IDLE_CALLS[nudged]
      calls = known.toolCalls + 1
      idle = known.code === 0 && threshold !== undefined && calls >= threshold && e.tool !== 'Write' && e.tool !== 'Edit'

      return {
        ...known,
        toolCalls: calls,
        writes: (known.writes ?? 0) + (isWork(e.tool as string) ? 1 : 0),
        nudged: idle ? nudged + 1 : known.nudged,
      }
    })

    return withNotice(
      await next(e),
      idle
        ? `junior-team: you made ${calls} calls without writing a file. Stop exploring: write the unit's files now with what you know, ` +
            'then report in your summary the doubts and what you could not verify.'
        : undefined,
    )
  }).catch(($, e, next) => (next.called ? { deny: 'junior-team: the call count failed.' } : next(e)))

  // Bash scripts of the main thread that write files: the mod estimates their code, it does not block them.
  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    if (e.agentId !== undefined || !isBashWrite(e.command)) return next(e)
    const notice = await wroteAlone($, bashCode(e.command), true).catch(() => undefined)

    return withNotice(await next(e), notice)
  }).catch(($, e, next) => (next.called ? { deny: 'junior-team: the count of the lead\'s code failed.' } : next(e)))

  // The context of the main thread's last response: `plan` compares it with CONTEXT_HEAVY.
  // turn.step streams in pieces: the hook forwards all of them and reads the usage from the result.
  on('turn.step', async function* ($, e, next) {
    const step = yield* next(e)
    const usage = step.usage
    if (usage !== null && (e as { agentId?: string }).agentId === undefined) {
      const size = usage.input_tokens + usage.cache_read_input_tokens + usage.cache_creation_input_tokens
      await update($, context, () => size).catch(() => undefined)
      // The notice stays while the context is heavy: below the threshold it is removed.
      if (size <= CONTEXT_HEAVY) await setHeavy($, false).catch(() => undefined)
    }

    return step
  })

  // After a compaction of the main thread the context starts again: the notice disappears at once, without waiting for the next response.
  on('session.compact', async ($, e, next) => {
    const out = await next(e)
    if (e.agentId === undefined && e.trigger !== 'precompute' && out.skip === undefined) {
      await setHeavy($, false).catch(() => undefined)
      await update($, context, () => out.tokensAfter ?? 0).catch(() => undefined)
    }

    return out
  }).catch(($, e, next) => (next.called ? { skip: 'junior-team: error after compaction' } : next(e)))

  // The activation rule goes into the system prompt of whoever can launch agents: juniors do not receive it.
  on('prompt.compose', async ($, e, next) => {
    const composed = await next(e)
    if (!e.tools.includes('Agent')) return composed

    return { sections: [...composed.sections, { id: 'junior-team:rule', text: ARCHITECT_RULE, scope: 'session' }] }
  })

  on('turn.complete', async ($, e, next) => {
    const usage = e.usage
    if (usage !== undefined && (await read($, units)).length > 0) {
      const role: Role = 'lead'
      // Outside the plan only the lead is measured: other subagents are not part of the team.
      await track($, e.agentId ?? MAIN, row =>
        row !== undefined ? addUsage(row, usage) : e.agentId === undefined ? addUsage(emptyRow('-', role, usage.model), usage) : undefined,
      ).catch(() => undefined)
    }
    // A subagent closes only one turn: at the end of the turn it has come back, and the panel and the band take it off the work.
    if (e.agentId !== undefined) {
      await track($, e.agentId, row => (row === undefined ? undefined : { ...row, done: true })).catch(() => undefined)
    }

    return next(e)
  })
}
