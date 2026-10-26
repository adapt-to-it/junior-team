import type { AgentRow, Tier, Unit } from '../types'

const TIERS: readonly Tier[] = ['haiku', 'sonnet']
const ID = /^[\w-]{1,40}$/
// Input validity limit, not the team's.
const UNITS_MAX = 200
const TAIL_MAX = 1500
// Below this estimate the contract costs the lead as much as the code: the unit is not delegated.
const LINES_MIN = 80
const LINES_MAX = 3000
const CHARS_PER_LINE = 40
// The expected code is worth at least four times the contract.
const LEVERAGE_MIN = 4
const CONTRACT_MAX = 8000
// Sonnet costs 1.6 times haiku per character and did not pass more tests on the first try: it is assigned only after two failed verifies.
export const FAILURES_TO_ESCALATE = 2
export const FAILURES_TO_STOP = 3

export type Plan = { units: Unit[]; checks: string[][] }

export const isTier = (value: unknown): value is Tier => TIERS.some(tier => tier === value)

// Resolves `.` and `..` without touching the disk: a symbolic link is not followed.
// A Windows path (`C:\project\src`) becomes `c:/project/src`: there the drive is case-insensitive.
export const normalize = (path: string, root: string): string => {
  const given = path.replaceAll('\\', '/')
  const full = given.startsWith('/') || /^[A-Za-z]:\//.test(given) ? given : `${root.replaceAll('\\', '/')}/${given}`
  const drive = /^[A-Za-z]:/.exec(full)?.[0] ?? ''
  const kept: string[] = []
  for (const part of full.slice(drive.length).split('/')) {
    if (part === '' || part === '.') continue
    if (part === '..') kept.pop()
    else kept.push(part)
  }
  const joined = `/${kept.join('/')}`

  return drive === '' ? joined : `${drive}${joined}`.toLowerCase()
}

// The ceiling, in characters, of a junior's launch prompt.
export const contractBudget = (lines: number): number =>
  Math.min(CONTRACT_MAX, Math.floor((lines * CHARS_PER_LINE) / LEVERAGE_MIN))

// A Bash command that writes files: here-doc, redirection, tee, in-place edit.
export const isBashWrite = (command: string): boolean =>
  /<<\s*['"]?\w+|(^|[^0-9&>])>{1,2}\s*[\w~./'"$]|\btee\b|\bsed\s+-i|\bperl\s+-[a-z]*i/.test(command) &&
  !/^\s*(git|grep|rg|ls|cat\s+[^>]*$)\b/.test(command)

// Edit scripts also carry the text they replace: of the command, about half counts.
export const bashCode = (command: string): number => Math.round(command.length / 2)

// Project code: documentation and Claude's files do not count.
export const isCode = (path: string): boolean => !/\.(md|txt)$/i.test(path) && !path.includes('/.claude/')

const PATH = /(?:\/[\w.@+-]+)+\.\w{1,8}|[\w.@+-]+(?:\/[\w.@+-]+)+\.\w{1,8}/g

// Terminal colors: without ESC, `[32m` stays attached to the path.
const ANSI = /\x1b\[[0-9;]*[A-Za-z]|\[[0-9;]*m/g

// Dependencies and toolchain caches: PHP, Node, Swift, Rust, Python, Laravel's compiled views.
const isDependency = (path: string): boolean =>
  /(^|\/)(vendor|node_modules|\.build|\.cargo|\.rustup|target|site-packages|\.venv|storage\/framework)\//.test(path)

// A path inside a container (`/var/www/html/tests/A.php`) or relative to a subfolder (`tests/A.php`)
// is recognized from its tail: it matches the final part, of at least two segments, of a unit's path.
const fromTail = (path: string, base: string, units: readonly Unit[]): string | undefined => {
  const segments = path.split('/').filter(part => part !== '')
  for (let i = 0; i < segments.length - 1; i++) {
    const tail = segments.slice(i).join('/')
    for (const unit of units) {
      for (const owned of unit.paths) {
        const rel = owned.slice(base.length + 1).split('/')
        for (let k = 0; k < rel.length; k++) {
          const end = rel.slice(k).join('/')
          if (rel.length - k < 2 && k > 0) break
          if (tail === end || tail.startsWith(`${end}/`)) return `${base}/${[...rel.slice(0, k), tail].join('/')}`
        }
      }
    }
  }

  return undefined
}

// The project files that a test output names, and the units that own them.
// The failed tests the runner declares in the summary ("3 failed", "1 failed;"): undefined if it does not declare it.
export const failedCount = (output: string): number | undefined => {
  if (output.startsWith('ok')) return 0
  const found = [...output.replace(ANSI, '').matchAll(/(\d+)\s+failed/gi)]

  return found.length === 0 ? undefined : Number(found[found.length - 1]?.[1])
}

export const blame = (output: string, root: string, units: readonly Unit[]): { files: string[]; owners: string[] } => {
  const base = normalize(root, root)
  const owned = (file: string): boolean => units.some(unit => isInside(file, unit.paths))
  const resolve = (path: string): string | undefined => {
    if (isDependency(path)) return undefined
    const full = normalize(path, root)
    if (isInside(full, [base]) && owned(full)) return full

    return fromTail(path, base, units) ?? (isInside(full, [base]) ? full : undefined)
  }
  // The first line repeats the command, which often names the unit's test: it is not the cause.
  const body = output.replace(/^FAILED[^\n]*\n?/, '').replace(ANSI, '')
  const files = [...new Set((body.match(PATH) ?? []).flatMap(path => resolve(path) ?? []))]
  const owners = [...new Set(files.flatMap(file => units.filter(unit => isInside(file, unit.paths)).map(unit => unit.id)))]

  return { files: files.map(file => file.slice(base.length + 1)), owners }
}

export const isInside = (file: string, paths: readonly string[]): boolean =>
  paths.some(path => file === path || file.startsWith(`${path}/`))

const parseArgv = (value: unknown): string[] | undefined =>
  Array.isArray(value) && value.length > 0 && value.every(part => typeof part === 'string' && part !== '')
    ? (value as string[])
    : undefined

// The input of the tool comes from the model: an invalid plan returns as a reason, not as a partial plan.
export const parsePlan = (
  input: Record<string, unknown>,
  root: string,
  failures: Record<string, number> = {},
): Plan | string => {
  if (!Array.isArray(input.units) || input.units.length === 0) return 'plan requires units with at least one unit.'
  if (input.units.length > UNITS_MAX) return `plan accepts at most ${UNITS_MAX} units.`

  const units: Unit[] = []
  for (const one of input.units as unknown[]) {
    if (typeof one !== 'object' || one === null) return 'each unit is an object with id and paths.'
    const { id, paths, model, test, lines, reason, after, light, isolated } = one as Record<string, unknown>
    if (typeof id !== 'string' || !ID.test(id)) return `invalid id: ${String(id)}. Use letters, digits, _ and -.`
    if (units.some(unit => unit.id === id)) return `repeated id: ${id}.`
    const listed = parseArgv(paths)
    if (listed === undefined) return `unit ${id} requires paths with at least one path.`
    if (model !== undefined && !isTier(model)) return `unit ${id} has an invalid model: use haiku or sonnet.`
    if (typeof lines !== 'number' || !Number.isInteger(lines) || lines > LINES_MAX) {
      return `unit ${id} requires lines: the integer estimate of the lines the junior writes, at most ${LINES_MAX}.`
    }
    if (lines < LINES_MIN) {
      return `unit ${id} estimates ${lines} lines: below ${LINES_MIN} write it yourself, or merge it into another unit.`
    }
    const why = typeof reason === 'string' ? reason.trim() : ''
    if (model === 'sonnet' && (failures[id] ?? 0) < FAILURES_TO_ESCALATE) {
      return (
        `unit ${id} asks for sonnet, but sonnet is assigned only after ${FAILURES_TO_ESCALATE} failed verifies in a row. ` +
        'Assign it to haiku: if the part is delicate, put the detail in the contract or in a note, or write it yourself.'
      )
    }
    const argv = test === undefined ? undefined : parseArgv(test)
    if (after !== undefined && (!Array.isArray(after) || !after.every(dep => typeof dep === 'string'))) {
      return `after of unit ${id} is a list of unit ids.`
    }
    if (test !== undefined && argv === undefined) return `test of unit ${id} is an argv: an array of strings.`
    if ((light !== undefined && typeof light !== 'boolean') || (isolated !== undefined && typeof isolated !== 'boolean')) {
      return `light and isolated of unit ${id} are booleans.`
    }
    if (light === true && argv === undefined) return `unit ${id} declares light without a test.`

    const own = listed.map(path => normalize(path, root))
    if (own.some(path => isInside(normalize(root, root), [path]))) {
      return `unit ${id} owns the whole project: assign precise files or folders.`
    }
    const rival = units.find(
      unit => own.some(path => isInside(path, unit.paths)) || unit.paths.some(path => isInside(path, own)),
    )
    if (rival !== undefined) return `units ${rival.id} and ${id} share files: parallel units have disjoint files.`

    units.push({
      id,
      paths: own,
      model: isTier(model) ? model : 'haiku',
      lines,
      ...(why === '' ? {} : { reason: why }),
      ...(argv ? { test: argv } : {}),
      ...(Array.isArray(after) && after.length > 0 ? { after: after.map(String) } : {}),
      ...(light === true ? { light } : {}),
      ...(isolated === true ? { isolated } : {}),
    })
  }

  for (const unit of units) {
    const unknown = (unit.after ?? []).find(dep => dep === unit.id || !units.some(other => other.id === dep))
    if (unknown !== undefined) return `unit ${unit.id} declares after ${unknown}: after names other units of the same plan.`
  }
  const order = waves(units)
  if (typeof order === 'string') return order

  const checks: string[][] = []
  for (const one of Array.isArray(input.checks) ? (input.checks as unknown[]) : []) {
    const argv = parseArgv(one)
    if (argv === undefined) return 'each checks entry is an argv: an array of strings.'
    checks.push(argv)
  }

  return { units, checks }
}

// The first useful line of a junior's prompt names its unit.
export const unitOf = (prompt: string): string | undefined =>
  /^\s*UNIT[AÀ]?:\s*([\w-]+)/im.exec(prompt)?.[1]

// A line longer than this threshold: a junior reads only its useful part.
const LINE_MAX = 240
// Context characters around the difference between the expected and the obtained line.
const DIFF_CONTEXT = 50
const DIFF_LINE = /^(\s*(?:E\s+)?)([-+])(.*)$/

const clip = (line: string): string =>
  line.length <= LINE_MAX ? line : `${line.slice(0, LINE_MAX)}… (+${line.length - LINE_MAX} characters)`

// From an expected/obtained pair of lines, only the part that changes is kept, with some context.
const narrow = (minus: string, plus: string): [string, string] => {
  const a = DIFF_LINE.exec(minus)
  const b = DIFF_LINE.exec(plus)
  if (a === null || b === null) return [clip(minus), clip(plus)]
  const [x, y] = [a[3] ?? '', b[3] ?? '']
  let head = 0
  while (head < x.length && head < y.length && x[head] === y[head]) head += 1
  let back = 0
  while (back < x.length - head && back < y.length - head && x[x.length - 1 - back] === y[y.length - 1 - back]) back += 1
  const cut = (text: string): string => {
    const from = Math.max(0, head - DIFF_CONTEXT)
    const to = Math.min(text.length, text.length - back + DIFF_CONTEXT)
    return `${from > 0 ? '…' : ''}${text.slice(from, to)}${to < text.length ? '…' : ''}`
  }

  return [clip(`${a[1]}-${cut(x)}`), clip(`${b[1]}+${cut(y)}`)]
}

// The output of a failed test without colors, with long lines shortened. In the expected/obtained pairs
// of a diff (PHPUnit, Pest, Jest, pytest) only the differing part remains: a comparison of whole records
// takes thousands of characters per field.
export const shorten = (text: string): string => {
  const lines = text.replace(ANSI, '').split('\n')
  const out: string[] = []
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? ''
    const next = lines[i + 1]
    const isPair = next !== undefined && /^\s*(?:E\s+)?-(?!--)/.test(line) && /^\s*(?:E\s+)?\+(?!\+\+)/.test(next)
    if (isPair && (line.length > LINE_MAX || next.length > LINE_MAX)) {
      out.push(...narrow(line, next))
      i += 1
      continue
    }
    out.push(clip(line))
  }

  return out.join('\n')
}

export const tail = (text: string): string =>
  text.length <= TAIL_MAX ? text : `…${text.slice(-TAIL_MAX)}`

export const emptyRow = (unit: string, role: AgentRow['role'], model: string): AgentRow => ({
  unit,
  role,
  model,
  turns: 0,
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  contract: 0,
  code: 0,
  lookups: 0,
  lookupChars: 0,
  tests: 0,
  reads: 0,
  toolCalls: 0,
})

type Usage = {
  model: string
  input_tokens: number
  output_tokens: number
  cache_read_input_tokens: number
  cache_creation_input_tokens: number
}

export const addUsage = (row: AgentRow, usage: Usage): AgentRow => ({
  ...row,
  model: usage.model,
  turns: row.turns + 1,
  input: row.input + usage.input_tokens,
  output: row.output + usage.output_tokens,
  cacheRead: row.cacheRead + usage.cache_read_input_tokens,
  cacheWrite: row.cacheWrite + usage.cache_creation_input_tokens,
})

export const k = (tokens: number): string => (tokens < 1000 ? String(tokens) : `${(tokens / 1000).toFixed(1)}K`)

export const leverage = (code: number, contract: number): string => (contract === 0 ? '-' : (code / contract).toFixed(1))

// The waves of the plan: each unit sits in the first wave after all its dependencies. A cycle returns as a reason.
export const waves = (units: readonly Unit[]): string[][] | string => {
  const placed = new Map<string, number>()
  for (let round = 0; placed.size < units.length; round += 1) {
    const ready = units.filter(unit => !placed.has(unit.id) && (unit.after ?? []).every(dep => (placed.get(dep) ?? round) < round))
    if (ready.length === 0) {
      const stuck = units.filter(unit => !placed.has(unit.id)).map(unit => unit.id)

      return `dependencies of ${stuck.join(', ')} form a cycle: a unit cannot wait for itself.`
    }
    for (const unit of ready) placed.set(unit.id, round)
  }
  const rounds: string[][] = []
  for (const [id, round] of placed) (rounds[round] ??= []).push(id)

  return rounds
}

// The units the plan lets run now and those still waiting, with the units they wait for.
export const describeWaves = (plan: Plan, passed: Record<string, boolean>): string => {
  const waiting = plan.units
    .map(unit => ({ unit, missing: (unit.after ?? []).filter(dep => passed[dep] !== true) }))
    .filter(one => one.missing.length > 0)
  if (!plan.units.some(unit => (unit.after ?? []).length > 0)) return ''

  return [
    `ready · ${plan.units.filter(unit => !waiting.some(one => one.unit.id === unit.id)).map(unit => unit.id).join(', ') || 'none'}`,
    `waiting · ${waiting.map(one => `${one.unit.id} (after ${one.missing.join(', ')})`).join(', ') || 'none'}`,
  ].join('\n')
}

export const describePlan = (plan: Plan): string =>
  [
    ...plan.units.map(
      unit =>
        `${unit.id} [${unit.model}] ${unit.lines} lines · contract up to ${contractBudget(unit.lines)} chars · ` +
        `${unit.paths.join(', ')}${unit.test ? ` · test: ${unit.test.join(' ')}` : ''}` +
        `${unit.after ? ` · after: ${unit.after.join(', ')}` : ''}`,
    ),
    ...plan.checks.map(argv => `check: ${argv.join(' ')}`),
  ].join('\n')

// The leverage is the code written by the juniors divided by the contract written by the lead, in characters.
// The denominator also includes the board notes and the code the lead writes itself. It counts Edit and Write:
// what a junior writes with Bash does not enter the measure.
export const describeAgents = (
  agents: Record<string, AgentRow>,
  boardChars = 0,
  failures: Record<string, number> = {},
  architect: { code: number; bash: number } = { code: 0, bash: 0 },
): string => {
  const rows = Object.values(agents)
  const failed = `failed verifies in a row · ${
    Object.entries(failures)
      .filter(([, count]) => count > 0)
      .map(([unit, count]) => `${unit} ${count}`)
      .join(', ') || 'none'
  }`
  const alone = `lead · written by the lead ${k(architect.code)} chars with Edit and Write, about ${k(architect.bash)} with Bash`
  if (rows.length === 0) return `No agent measured.\n${alone}\n${failed}`
  const total = (pick: (row: AgentRow) => number, among: readonly AgentRow[] = rows): number =>
    among.reduce((sum, row) => sum + pick(row), 0)
  const juniors = rows.filter(row => row.role === 'junior')
  const relaunched = [...new Set(juniors.map(row => row.unit))]
    .map(unit => ({ unit, extra: juniors.filter(row => row.unit === unit).length - 1 }))
    .filter(one => one.extra > 0)

  return [
    'role · unit · model · turns · input · cache write · cache read · output · contract · code · leverage · lookups · tests · reads',
    ...rows.map(row =>
      [
        row.role,
        row.unit,
        row.model,
        row.turns,
        k(row.input),
        k(row.cacheWrite),
        k(row.cacheRead),
        k(row.output),
        ...(row.role === 'junior'
          ? [k(row.contract), k(row.code), leverage(row.code, row.contract), `${row.lookups} (${k(row.lookupChars)})`, row.tests, row.reads]
          : ['-', '-', '-', '-', '-', '-']),
      ].join(' · '),
    ),
    `total · ${rows.length} agents · input ${k(total(row => row.input))} · cache write ${k(total(row => row.cacheWrite))} · cache read ${k(total(row => row.cacheRead))} · output ${k(total(row => row.output))}`,
    `leverage · contracts ${k(total(row => row.contract, juniors))} chars · board ${k(boardChars)} chars · ` +
      `lead's code ${k(architect.code + architect.bash)} chars · juniors' code ${k(total(row => row.code, juniors))} chars · ` +
      `ratio ${leverage(total(row => row.code, juniors), total(row => row.contract, juniors) + boardChars + architect.code + architect.bash)}`,
    alone,
    `relaunches · ${relaunched.length === 0 ? 'none' : relaunched.map(one => `${one.unit} ${one.extra}`).join(', ')}`,
    failed,
  ].join('\n')
}

// A test file that the plan runs for several units, or that sits in another unit's scope, covers the code of several juniors:
// each failure reaches only one. That test goes in the checks, and each unit keeps a test on its own code.
// Extensions of the test files a runner runs.
const TEST_SOURCE = /\.(php|[cm]?[jt]sx?|py|rb|rs|go|java|kt|cs|swift|exs?|c|cc|cpp)$/

export const sharedTests = (units: readonly Unit[], root: string): string[] => {
  const users = new Map<string, string[]>()
  const notes: string[] = []
  for (const unit of units) {
    // The first argument is the runner (tools/lxc_test.sh), and a service such as laravel.test is not a code file.
    for (const arg of (unit.test ?? []).slice(1)) {
      const file = arg.replace(/^\.\//, '')
      if (file.startsWith('-') || !/test|spec/i.test(file) || !TEST_SOURCE.test(file)) continue
      users.set(file, [...(users.get(file) ?? []), unit.id])
      const owner = units.find(other => other.id !== unit.id && isInside(normalize(file, root), other.paths.map(path => normalize(path, root))))
      if (owner !== undefined) notes.push(`the test of ${unit.id} runs ${file}, which sits in unit ${owner.id}`)
    }
  }
  for (const [file, ids] of users) if (ids.length > 1) notes.push(`${file} is the test of ${ids.join(', ')}`)

  return notes
}
