import { expect, test } from 'claude-code/testing'
import type { On } from 'claude-code'

import { isMiss, outline, parseRef } from '../hooks/code-index'
import { blame, contractBudget, failedCount, isBashWrite, isInside, normalize, sharedTests, shorten, waves } from '../hooks/plan'
import { overview } from '../hooks/overview'

const TOOL = 'mcp__junior-team__team'
const UNITS = [
  { id: 'lexer', paths: ['src/lexer'], lines: 100, test: ['php', 'src/lexer/test.php'] },
  { id: 'core', paths: ['src/core'], lines: 200 },
]

// Under the mod there is no session: the test answers per project, agents and processes.
const NODE = [
  '**parsePlan** (function)',
  '',
  '**Location:** src/core/plan.ts:50',
  '**Signature:** `(input: Record<string, unknown>): Plan`',
  '',
  '```typescript',
  '50\texport const parsePlan = () => body',
  '```',
  '**Trail — codegraph_node any of these to follow it (no Read needed)**',
  '**Called by ←** register (src/core/register.ts:75)',
].join('\n')

// `codegraph` answers like a never-indexed project that knows a single symbol.
const indexer = (args: readonly string[]): string => {
  if (args[0] === 'status') return '{"initialized":false}'
  if (args[0] !== 'node') return ''
  if (args.includes('--symbols-only')) {
    return [
      `**${args[args.indexOf('-f') + 1]}** — 1 symbols, used by 1 file: src/other.ts`,
      '',
      '**Symbols**',
      '- `Lexer` (class) — :10',
      '- `state` (property) state: string — :11',
      '- `read` (method) (text: string): Token[] — :14',
    ].join('\n')
  }

  return args.at(-1) === 'parsePlan' ? NODE : `Symbol "${args.at(-1)}" not found in the codebase`
}

const world = (on: On) => {
  const seen = {
    models: [] as string[], indexed: [] as string[][], running: [] as string[], cwds: [] as (string | undefined)[], outputs: [] as string[],
    scripts: [] as string[][], testCwds: [] as (string | undefined)[],
  }
  on('session.root', () => ({ value: '/progetto' }))
  on('agent.list', () => ({
    value: seen.running.map(id => ({ id, description: 'unit', type: 'junior-team:junior', status: 'running' as const })),
  }))
  on('agent.spawn', ($, e) => {
    seen.models.push(e.model ?? '')
    seen.cwds.push(e.cwd)

    return { model: e.model ?? '', agentId: `agente-${seen.models.length}` }
  })
  on('process.run', ($, e) => {
    if (e.argv[0] === 'sh') {
      seen.scripts.push(e.argv.slice(4))
      const out = String(e.argv[2]).includes('git-common-dir') ? '/progetto/.git\n' : ''
      return { value: { exitCode: 0, stdout: out, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
    }
    if (e.argv[0] === 'php') seen.testCwds.push(e.init?.cwd)
    const isIndexer = e.argv[0] === 'codegraph'
    if (isIndexer) seen.indexed.push(e.argv.slice(1))
    if (e.argv[0] === 'git') {
      const top = String(e.argv[2] ?? '').startsWith('/progetto/repo') ? '/progetto/repo' : '/wt'
      return { value: { exitCode: 0, stdout: `${top}\n`, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
    }

    return {
      value: {
        exitCode: e.argv[0] === 'php' ? 1 : 0,
        stdout: isIndexer ? indexer(e.argv.slice(1)) : (e.argv[0] === 'php' ? seen.outputs.shift() : undefined) ?? 'output line',
        stderr: isIndexer ? '' : 'expected 3, got 4',
        isStdoutTruncated: false,
        isStderrTruncated: false,
      },
    }
  })

  return seen
}

// The fields the engine adds to every launch.
const junior = (prompt: string, model?: string) => ({
  subagentType: 'junior-team:junior',
  prompt,
  description: 'unit',
  tool_use_id: 'lancio',
  provider: { plugin: 'junior-team', tier: 'user' } as const,
  parentModel: 'opus',
  background: false,
  fork: false,
  ...(model === undefined ? {} : { model }),
})

const PANE_PROPS = { title: 'Team', isFocused: false, bodyColumns: 80, placement: 'dock' as const, scroll: { offset: 0, bodyRows: 20 }, view: {} }
const BAND_PROPS = { hasSurvey: false, isWorking: true, maxRows: 10, bodyColumns: 80, scroll: { offset: 0, bodyRows: 10 }, view: {} }

test('the scope is computed on the resolved path', () => {
  const paths = [normalize('src/lexer', '/progetto')]
  expect(isInside(normalize('src/lexer/Lexer.php', '/progetto'), paths)).toBe(true)
  expect(isInside(normalize('src/lexer/../core/Core.php', '/progetto'), paths)).toBe(false)
  expect(isInside(normalize('/progetto/src/lexer2/a.php', '/progetto'), paths)).toBe(false)
})

test('the scope also holds for Windows paths', () => {
  const root = 'C:\\Users\\io\\progetto'
  const paths = [normalize('src\\lexer', root)]
  expect(paths).toEqual(['c:/users/io/progetto/src/lexer'])
  expect(isInside(normalize('c:\\users\\io\\progetto\\src\\Lexer\\Lexer.php', root), paths)).toBe(true)
  expect(isInside(normalize('C:/Users/io/progetto/src/lexer/../core/Core.php', root), paths)).toBe(false)
  expect(isInside(normalize('D:\\Users\\io\\progetto\\src\\lexer\\a.php', root), paths)).toBe(false)
})

test('the plan rejects units with shared files', async ($, on) => {
  world(on)
  const shared = await $.tool.call({
    tool: TOOL,
    action: 'plan',
    units: [
      { id: 'a', paths: ['src'], lines: 100 },
      { id: 'b', paths: ['src/core/Core.php'], lines: 100 },
    ],
  })
  expect(shared.deny).toContain('share files')

  const whole = await $.tool.call({ tool: TOOL, action: 'plan', units: [{ id: 'a', paths: ['.'], lines: 100 }] })
  expect(whole.deny).toContain('whole project')
})

test("a junior starts only with a unit of the plan and with the plan's model", async ($, on) => {
  const seen = world(on)
  const early = await $.agent.spawn(junior('UNIT: lexer'))
  expect(early.deny).toContain('no unit lexer')

  await $.tool.call({ tool: TOOL, action: 'plan', units: UNITS })
  const unnamed = await $.agent.spawn(junior('Write the lexer'))
  expect(unnamed.deny).toContain('UNIT: <id>')

  await $.agent.spawn(junior('UNIT: lexer\ncontract', 'sonnet'))
  // The Italian spelling UNITÀ is still accepted.
  await $.agent.spawn(junior('UNITÀ: core\ncontract'))
  expect(seen.models).toEqual(['haiku', 'haiku'])

  const state = await $.tool.call({ tool: TOOL, action: 'status' })
  expect(state.result).toContain('junior · lexer · haiku')
  expect(state.result).toContain('junior · core · haiku')
})

test('verify returns the outcomes and the tail of the failures only', async ($, on) => {
  world(on)
  await $.tool.call({ tool: TOOL, action: 'plan', units: UNITS, checks: [['composer', 'lint']] })
  const checked = await $.tool.call({ tool: TOOL, action: 'verify' })
  expect(checked.result).toBe(
    'FAILED (exit 1) · lexer · php src/lexer/test.php\noutput line\nexpected 3, got 4\n' +
      'no test · core\n' +
      'ok · check · composer lint',
  )
})

test('the plan rejects small units and sonnet without a reason', async ($, on) => {
  world(on)
  const small = await $.tool.call({ tool: TOOL, action: 'plan', units: [{ id: 'a', paths: ['src/a'], lines: 40 }] })
  expect(small.deny).toContain('write it yourself')

  const unsized = await $.tool.call({ tool: TOOL, action: 'plan', units: [{ id: 'a', paths: ['src/a'] }] })
  expect(unsized.deny).toContain('lines')

  const bare = await $.tool.call({
    tool: TOOL,
    action: 'plan',
    units: [{ id: 'a', paths: ['src/a'], lines: 100, model: 'sonnet' }],
  })
  expect(bare.deny).toContain('after 2 failed verifies')

  const opus = await $.tool.call({
    tool: TOOL,
    action: 'plan',
    units: [{ id: 'a', paths: ['src/a'], lines: 100, model: 'opus' }],
  })
  expect(opus.deny).toContain('haiku or sonnet')
})

test('a contract over the cap does not start', async ($, on) => {
  const seen = world(on)
  await $.tool.call({ tool: TOOL, action: 'plan', units: UNITS })
  expect(contractBudget(100)).toBe(1000)
  expect(contractBudget(5000)).toBe(8000)

  const long = await $.agent.spawn(junior(`UNIT: lexer\n${'x'.repeat(1000)}`))
  expect(long.deny).toContain('the cap is 1000')
  expect(seen.models).toEqual([])

  const short = await $.agent.spawn(junior(`UNIT: lexer\n${'x'.repeat(900)}`))
  expect(short.deny).toBeUndefined()
})

test('status measures the leverage and keeps relaunches across two plans', async ($, on) => {
  world(on)
  on('tool.call', { tool: 'Write' }, () => ({ result: 'written' }))
  await $.tool.call({ tool: TOOL, action: 'plan', units: UNITS })
  await $.agent.spawn(junior(`UNIT: lexer\n${'x'.repeat(487)}`))
  const out = await $.tool.call({ tool: 'Write', agentId: 'agente-1', file_path: 'docs/a.md', content: 'x' })
  expect(out.deny).toContain('is outside the unit')
  await $.tool.call({ tool: 'Write', agentId: 'agente-1', file_path: 'src/lexer/Lexer.php', content: 'x'.repeat(2500) })

  await $.tool.call({ tool: TOOL, action: 'plan', units: UNITS })
  await $.agent.spawn(junior(`UNIT: lexer\n${'x'.repeat(487)}`))
  const state = await $.tool.call({ tool: TOOL, action: 'status' })
  expect(state.result).toContain('junior · lexer · haiku · 0 · 0 · 0 · 0 · 0 · 499 · 2.5K · 5.0 · 0 (0)')
  expect(state.result).toContain(
    'leverage · contracts 998 chars · board 0 chars · lead\'s code 0 chars · juniors\' code 2.5K chars · ratio 2.5',
  )
  expect(state.result).toContain('relaunches · lexer 1')
})

test('the activation rule enters only where the Agent tool exists', async ($, on) => {
  on('prompt.compose', () => ({ sections: [{ id: 'intro', text: 'base', scope: 'shared' }] }))
  const base = { model: 'opus', promptModel: 'opus', surfaces: [], outputStyle: null, traits: [] } as const
  const lead = await $.prompt.compose({ ...base, tools: ['Agent', 'Edit'] })
  expect(lead.sections.some(section => section.id === 'junior-team:rule')).toBe(true)
  const worker = await $.prompt.compose({ ...base, tools: ['Edit'] })
  expect(worker.sections.some(section => section.id === 'junior-team:rule')).toBe(false)
})

const LOOKUP = 'mcp__junior-team__lookup'

test('the plan creates the index when missing and aligns it after verify', async ($, on) => {
  const seen = world(on)
  const planned = await $.tool.call({ tool: TOOL, action: 'plan', units: UNITS })
  expect(planned.result).toContain('index · ready (created now in .codegraph)')
  expect(seen.indexed).toEqual([
    ['status', '-j', '/progetto'],
    ['init', '-y', '/progetto'],
  ])

  await $.tool.call({ tool: TOOL, action: 'verify' })
  expect(seen.indexed.at(-1)).toEqual(['init', '-y', '/progetto'])
})

test('the board accepts pointers and rejects prose', async ($, on) => {
  world(on)
  await $.tool.call({ tool: TOOL, action: 'plan', units: UNITS })
  const long = await $.tool.call({ tool: TOOL, action: 'note', notes: [{ key: 'a', text: 'x'.repeat(301) }] })
  expect(long.deny).toContain('the maximum is 300')
  const stray = await $.tool.call({ tool: TOOL, action: 'note', notes: [{ key: 'a', refs: ['parsePlan'], unit: 'other' }] })
  expect(stray.deny).toContain('other')
  const empty = await $.tool.call({ tool: TOOL, action: 'note', notes: [{ key: 'a' }] })
  expect(empty.deny).toContain('requires refs or text')
})

test('a junior reads its notes, in slices, and only once', async ($, on) => {
  const seen = world(on)
  await $.tool.call({ tool: TOOL, action: 'plan', units: UNITS })
  await $.tool.call({
    tool: TOOL,
    action: 'note',
    notes: [
      { key: 'plan', refs: ['src/core/plan.ts#parsePlan'], text: 'An invalid plan comes back as a string.' },
      { key: 'secret', text: 'For core only.', unit: 'core' },
    ],
  })
  await $.agent.spawn(junior('UNIT: lexer\nsee @plan'))
  seen.indexed.length = 0

  const first = await $.tool.call({ tool: LOOKUP, agentId: 'agente-1', keys: ['@plan', 'secret', '../outside.ts'] })
  expect(first.result).toBe(
    '@plan: An invalid plan comes back as a string.\n\n' +
      '**parsePlan** (function)\n\n**Location:** src/core/plan.ts:50\n**Signature:** `(input: Record<string, unknown>): Plan`\n' +
      '(body omitted: request it with body: true)\n\n' +
      'secret: not found in the index. If you need it, read the file with Read.\n\n' +
      '../outside.ts is outside the project.',
  )
  expect(seen.indexed).toEqual([
    ['node', '-p', '/progetto', '-f', 'src/core/plan.ts', 'parsePlan'],
    ['node', '-p', '/progetto', 'secret'],
  ])

  // A file the index does not know yet makes it align, once, before giving up.
  seen.indexed.length = 0
  const fresh = await $.tool.call({ tool: LOOKUP, agentId: 'agente-1', keys: ['src/new.ts#absent'] })
  expect(fresh.result).toContain('not found')
  expect(seen.indexed.map(args => args[0])).toEqual(['node', 'sync', 'node'])

  const again = await $.tool.call({ tool: LOOKUP, agentId: 'agente-1', keys: ['plan'] })
  expect(again.result).toContain('already served in this run')
  const body = await $.tool.call({ tool: LOOKUP, agentId: 'agente-1', keys: ['src/core/plan.ts#parsePlan'], body: true })
  expect(body.result).toContain('=> body')
  expect(body.result).not.toContain('Trail')

  // A second agent gets the same slice from the cache, without another process.
  await $.agent.spawn(junior('UNIT: core\nsee @plan'))
  const ran = seen.indexed.length
  const other = await $.tool.call({ tool: LOOKUP, agentId: 'agente-2', keys: ['plan', 'secret'] })
  expect(other.result).toContain('**Signature:**')
  expect(other.result).toContain('@secret: For core only.')
  expect(seen.indexed.length).toBe(ran)

  const state = await $.tool.call({ tool: TOOL, action: 'status' })
  expect(state.result).toContain('board · 2 notes')
  expect(state.result).toContain('not found · secret, src/new.ts#absent')
  expect(state.result).toContain('junior · lexer · haiku · 0 · 0 · 0 · 0 · 0 · 21 · 0 · 0.0 · 4 (')
})

test("a reference stays inside the project and does not become an option", () => {
  expect(parseRef('src/a.ts#parsePlan', '/progetto')).toEqual({ file: 'src/a.ts', symbol: 'parsePlan' })
  expect(parseRef('Renderer#renderHtml', '/progetto')).toEqual({ file: 'Renderer', symbol: 'renderHtml' })
  expect(parseRef('parsePlan', '/progetto')).toEqual({ symbol: 'parsePlan' })
  expect(parseRef('/progetto/src/a.ts', '/progetto')).toEqual({ file: 'src/a.ts' })
  expect(parseRef('/etc/passwd', '/progetto')).toContain('outside the project')
  expect(parseRef('--force', '/progetto')).toContain('invalid')
  expect(isMiss(0, 'No indexed file matches "src/x.ts". Codegraph indexes source files')).toBe(true)
  expect(isMiss(0, '**parsePlan** (function)')).toBe(false)
  expect(outline('**a.php** — 2 symbols\n\n**Symbols**\n- `A` (class) — :3\n- `x` (property) — :4\n\n> Drop `symbolsOnly` to read the source.')).toBe(
    '**a.php**\n- `A` (class) — :3',
  )
})

test('lookup prepares the index even without a plan', async ($, on) => {
  const seen = world(on)
  const map = await $.tool.call({ tool: LOOKUP, keys: ['src/core/plan.ts'] })
  expect(map.result).toContain('1 symbols')
  expect(seen.indexed[1]).toEqual(['init', '-y', '/progetto'])
})

const TRIAL = 'mcp__junior-team__test'
const four = (models: (string | undefined)[]) =>
  models.map((model, at) => ({
    id: `u${at}`,
    paths: [`src/u${at}`],
    lines: 100,
    test: ['php', `src/u${at}/test.php`],
    ...(model === undefined ? {} : { model, reason: 'shared cache' }),
  }))

test("sonnet is assigned only to a unit with two failed verifies in a row", async ($, on) => {
  world(on)
  const early = await $.tool.call({ tool: TOOL, action: 'plan', units: four(['sonnet', undefined, undefined, undefined]) })
  expect(early.deny).toContain('u0 asks for sonnet')

  await $.tool.call({ tool: TOOL, action: 'plan', units: four([undefined, undefined, undefined, undefined]) })
  await $.tool.call({ tool: TOOL, action: 'verify' })
  const once = await $.tool.call({ tool: TOOL, action: 'plan', units: four([undefined, 'sonnet', undefined, undefined]) })
  expect(once.deny).toContain('u1 asks for sonnet')

  const second = await $.tool.call({ tool: TOOL, action: 'verify', unit: 'u1' })
  expect(second.result).not.toContain('Stop and report')
  const raised = await $.tool.call({ tool: TOOL, action: 'plan', units: four([undefined, 'sonnet', undefined, undefined]) })
  expect(raised.deny).toBeUndefined()

  const third = await $.tool.call({ tool: TOOL, action: 'verify', unit: 'u1' })
  expect(third.result).toContain('u1: 3 verifies failed in a row')
  const state = await $.tool.call({ tool: TOOL, action: 'status' })
  expect(state.result).toContain('failed verifies in a row · u0 1, u1 3, u2 1, u3 1')
})

test('a junior tests its unit three times and no more', async ($, on) => {
  world(on)
  await $.tool.call({ tool: TOOL, action: 'plan', units: UNITS })
  const lead = await $.tool.call({ tool: TRIAL })
  expect(lead.deny).toContain('verify')

  await $.agent.spawn(junior('UNIT: lexer'))
  const first = await $.tool.call({ tool: TRIAL, agentId: 'agente-1' })
  expect(first.result).toContain('FAILED (exit 1) · lexer · php src/lexer/test.php')
  await $.tool.call({ tool: TRIAL, agentId: 'agente-1' })
  await $.tool.call({ tool: TRIAL, agentId: 'agente-1' })
  const fourth = await $.tool.call({ tool: TRIAL, agentId: 'agente-1' })
  expect(fourth.result).toContain('You have already run the test 3 times')

  await $.agent.spawn(junior('UNIT: core'))
  const bare = await $.tool.call({ tool: TRIAL, agentId: 'agente-2' })
  expect(bare.result).toContain('has no test')
})

test('after eight whole files outside the unit a junior reads in slices', async ($, on) => {
  world(on)
  on('tool.call', { tool: 'Read' }, () => ({ result: 'content' }))
  await $.tool.call({ tool: TOOL, action: 'plan', units: UNITS })
  await $.agent.spawn(junior('UNIT: lexer'))
  for (let at = 0; at < 8; at += 1) {
    const read = await $.tool.call({ tool: 'Read', agentId: 'agente-1', file_path: `app/Models/M${at}.php` })
    expect(read.deny).toBeUndefined()
  }
  const ninth = await $.tool.call({ tool: 'Read', agentId: 'agente-1', file_path: 'app/Models/M9.php' })
  expect(ninth.deny).toContain('lookup')
  expect(ninth.deny).toContain('File map')
  expect(ninth.deny).toContain('`read` (method)')
  const slice = await $.tool.call({ tool: 'Read', agentId: 'agente-1', file_path: 'app/Models/M9.php', offset: 1, limit: 40 })
  expect(slice.deny).toBeUndefined()
  const own = await $.tool.call({ tool: 'Read', agentId: 'agente-1', file_path: 'src/lexer/Lexer.php' })
  expect(own.deny).toBeUndefined()
  const lead = await $.tool.call({ tool: 'Read', file_path: 'app/Models/M9.php' })
  expect(lead.deny).toBeUndefined()
})

test("the outline shows the interface of the files written by each unit", async ($, on) => {
  const seen = world(on)
  on('tool.call', { tool: 'Write' }, () => ({ result: 'written' }))
  await $.tool.call({ tool: TOOL, action: 'plan', units: UNITS })
  await $.agent.spawn(junior('UNIT: lexer'))
  await $.tool.call({ tool: 'Write', agentId: 'agente-1', file_path: 'src/lexer/Lexer.php', content: 'a' })
  await $.tool.call({ tool: 'Write', agentId: 'agente-1', file_path: '/progetto/src/lexer/Lexer.php', content: 'b' })
  seen.indexed.length = 0

  const cards = await $.tool.call({ tool: TOOL, action: 'outline' })
  expect(cards.result).toBe(
    '## lexer\n**src/lexer/Lexer.php**\n- `Lexer` (class) — :10\n- `read` (method) (text: string): Token[] — :14\n\n' +
      'core: no file written with Edit or Write.',
  )
  expect(seen.indexed.map(args => args[0])).toEqual(['status', 'init', 'node'])
  const one = await $.tool.call({ tool: TOOL, action: 'outline', unit: 'core' })
  expect(one.result).toBe('core: no file written with Edit or Write.')
})

test('a unit has only one junior running', async ($, on) => {
  const seen = world(on)
  await $.tool.call({ tool: TOOL, action: 'plan', units: UNITS })
  await $.agent.spawn(junior('UNIT: lexer'))
  seen.running.push('agente-1')
  const twin = await $.agent.spawn(junior('UNIT: lexer'))
  expect(twin.deny).toContain('is still running')
  const other = await $.agent.spawn(junior('UNIT: core'))
  expect(other.deny).toBeUndefined()

  seen.running.length = 0
  const relaunch = await $.agent.spawn(junior('UNIT: lexer'))
  expect(relaunch.deny).toBeUndefined()
})

test('the code the lead writes itself enters the leverage and raises a notice every 200 lines', async ($, on) => {
  world(on)
  on('tool.call', { tool: 'Write' }, () => ({ result: 'written' }))
  on('tool.call', { tool: 'Bash' }, () => ({ result: 'executed' }))
  on('prompt.submit', ($, e) => ({ text: e.text }))
  on('ui.status', () => ({ value: undefined }))
  await $.tool.call({ tool: TOOL, action: 'plan', units: UNITS })

  const small = await $.tool.call({ tool: 'Write', file_path: 'src/core/Shape.php', content: 'x'.repeat(5000) })
  expect(small.context).toBeUndefined()
  const docs = await $.tool.call({ tool: 'Write', file_path: 'docs/STATUS.md', content: 'x'.repeat(9000) })
  expect(docs.context).toBeUndefined()
  const big = await $.tool.call({ tool: 'Write', file_path: 'src/core/Engine.php', content: 'x'.repeat(4000) })
  expect(big.context?.[0]).toContain('in this request you have written about 225 lines of code yourself')
  const again = await $.tool.call({ tool: 'Write', file_path: 'src/core/Other.php', content: 'x'.repeat(100) })
  expect(again.context).toBeUndefined()

  const script = await $.tool.call({ tool: 'Bash', command: `python3 - <<'EOF'\n${'x'.repeat(14000)}\nEOF` })
  expect(script.context?.[0]).toContain('junior-team:junior-team')
  const plain = await $.tool.call({ tool: 'Bash', command: 'ls -la' })
  expect(plain.context).toBeUndefined()

  const state = await $.tool.call({ tool: TOOL, action: 'status' })
  expect(state.result).toContain('lead · written by the lead 9.1K chars with Edit and Write, about 7.0K with Bash')

  // After a verify, or on a new request from the user, the count starts again.
  await $.tool.call({ tool: TOOL, action: 'verify' })
  const fresh = await $.tool.call({ tool: 'Write', file_path: 'src/core/New.php', content: 'x'.repeat(7000) })
  expect(fresh.context).toBeUndefined()
  await $.prompt.submit({ text: 'another task' } as never)
  const after = await $.tool.call({ tool: 'Write', file_path: 'src/core/Newer.php', content: 'x'.repeat(7000) })
  expect(after.context).toBeUndefined()
})

test('Bash commands that write files are recognized', () => {
  expect(isBashWrite("python3 - <<'EOF'\nprint(1)\nEOF")).toBe(true)
  expect(isBashWrite('cat > src/a.php <<EOF\nx\nEOF')).toBe(true)
  expect(isBashWrite('echo x >> log.txt')).toBe(true)
  expect(isBashWrite("sed -i '' 's/a/b/' src/a.php")).toBe(true)
  expect(isBashWrite('npm test 2>&1 | tail -5')).toBe(false)
  expect(isBashWrite('ls -la')).toBe(false)
  expect(isBashWrite('git commit -m "x"')).toBe(false)
})

test("the context notice shows in the band with a heavy context and disappears after the /compact button", async ($, on) => {
  world(on)
  // When the band has nothing to say it passes to the engine: here the engine draws an empty box.
  on('ui.render', ($, e) => h($.ui.resolve(e).Box, {}))
  const band = async (): Promise<boolean> => {
    const drawn = await $.ui.mount({ plugin: 'junior-team', surface: 'desktop', component: 'AbovePrompt', props: BAND_PROPS })
    const found = (await drawn.find({ type: 'Text', text: /context 165K/ })) !== undefined
    await drawn.unmount()
    return found
  }
  let light = false
  on('turn.step', async function* () {
    return { answer: '', toolUses: [], stopReason: 'end_turn' as const, usage: { model: 'opus', input_tokens: 10, output_tokens: 1, cache_read_input_tokens: light ? 20_000 : 160_000, cache_creation_input_tokens: 5_000 } }
  })
  // In the desktop app the button runs /compact: the engine raises it as a command.
  let compacted = 0
  on('command.run', ($, e) => {
    expect(e.command).toBe('compact')
    compacted++
    return { text: '' }
  })

  for await (const _ of $.turn.step({ model: 'opus' } as never)) void _
  const planned = await $.tool.call({ tool: TOOL, action: 'plan', units: UNITS })
  expect(planned.result).toContain('Your context is 165K tokens')
  expect(await band()).toBe(true)

  // The button next to the notice runs the compaction.
  const drawn = await $.ui.mount({ plugin: 'junior-team', surface: 'desktop', component: 'AbovePrompt', props: BAND_PROPS })
  await drawn.press({ key: 'compatta' })
  await drawn.unmount()
  expect(compacted).toBe(1)
  expect(await band()).toBe(false)
  // After the compaction the next answer rereads a light context.
  light = true
  for await (const _ of $.turn.step({ model: 'opus' } as never)) void _
  const again = await $.tool.call({ tool: TOOL, action: 'plan', units: UNITS })
  expect(again.result).not.toContain('Your context is')
})

test('a junior stops after 40 calls', async ($, on) => {
  world(on)
  on('tool.call', { tool: 'SubagentHandback' }, () => ({ result: 'handed back' }))
  on('tool.call', { tool: 'Grep' }, () => ({ result: 'nothing' }))
  await $.tool.call({ tool: TOOL, action: 'plan', units: UNITS })
  await $.agent.spawn(junior('UNIT: lexer'))
  for (let at = 0; at < 40; at += 1) {
    const one = await $.tool.call({ tool: 'Grep', agentId: 'agente-1', pattern: 'x' })
    expect(one.deny).toBeUndefined()
  }
  const last = await $.tool.call({ tool: 'Grep', agentId: 'agente-1', pattern: 'x' })
  expect(last.deny).toContain('40 calls')
  // At the cap the junior still hands back the report.
  const handback = await $.tool.call({ tool: 'SubagentHandback', agentId: 'agente-1', message: 'report' } as never)
  expect(handback.deny).toBeUndefined()
  const lead = await $.tool.call({ tool: 'Grep', pattern: 'x' })
  expect(lead.deny).toBeUndefined()
})

test('writes do not use up the call cap, up to 60 in total', async ($, on) => {
  world(on)
  on('tool.call', { tool: 'Grep' }, () => ({ result: 'nothing' }))
  on('tool.call', { tool: 'Edit' }, () => ({ result: 'edited' }))
  await $.tool.call({ tool: TOOL, action: 'plan', units: UNITS })
  await $.agent.spawn(junior('UNIT: lexer'))
  for (let at = 0; at < 20; at += 1) await $.tool.call({ tool: 'Grep', agentId: 'agente-1', pattern: 'x' })
  for (let at = 0; at < 25; at += 1) {
    const edit = await $.tool.call({ tool: 'Edit', agentId: 'agente-1', file_path: 'src/lexer/A.php', old_string: 'a', new_string: 'b' } as never)
    expect(edit.deny).toBeUndefined()
  }
  // 45 calls, 20 without writing: the junior still reads.
  expect((await $.tool.call({ tool: 'Grep', agentId: 'agente-1', pattern: 'x' })).deny).toBeUndefined()
  for (let at = 0; at < 14; at += 1) await $.tool.call({ tool: 'Edit', agentId: 'agente-1', file_path: 'src/lexer/A.php', old_string: 'a', new_string: 'b' } as never)
  const over = await $.tool.call({ tool: 'Edit', agentId: 'agente-1', file_path: 'src/lexer/A.php', old_string: 'a', new_string: 'b' } as never)
  expect(over.deny).toContain('60 calls')
})

test('tests run one at a time even when two juniors test together', async ($, on) => {
  let running = 0
  let peak = 0
  on('session.root', () => ({ value: '/progetto' }))
  on('agent.list', () => ({ value: [] }))
  on('agent.spawn', ($, e) => ({ model: e.model ?? '', agentId: e.prompt.includes('lexer') ? 'a1' : 'a2' }))
  on('process.run', async ($, e) => {
    if (e.argv[0] === 'codegraph' || e.argv[0] === 'sleep') {
      if (e.argv[0] === 'sleep') await new Promise(done => setTimeout(done, 5))
      return { value: { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
    }
    running += 1
    peak = Math.max(peak, running)
    await new Promise(done => setTimeout(done, 20))
    running -= 1

    return { value: { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  const units = [
    { id: 'lexer', paths: ['src/lexer'], lines: 100, test: ['php', 'a.php'] },
    { id: 'core', paths: ['src/core'], lines: 100, test: ['php', 'b.php'] },
  ]
  await $.tool.call({ tool: TOOL, action: 'plan', units })
  await $.agent.spawn(junior('UNIT: lexer'))
  await $.agent.spawn(junior('UNIT: core'))
  const both = await Promise.all([
    $.tool.call({ tool: TRIAL, agentId: 'a1' }),
    $.tool.call({ tool: TRIAL, agentId: 'a2' }),
  ])
  expect(both.map(one => one.result)).toEqual(['ok · lexer · php a.php', 'ok · core · php b.php'])
  expect(peak).toBe(1)
})

test("a failure is attributed to the unit that owns the named files", () => {
  const units = [
    { id: 'link', paths: ['/progetto/Sources/Core/LinkMonitor.swift'], model: 'haiku' as const, lines: 100 },
    { id: 'ie', paths: ['/progetto/Sources/Core/IE'], model: 'haiku' as const, lines: 100 },
  ]
  const output =
    "/progetto/Sources/Core/IE/Parser.swift:41:12: error: type 'CWSecurity' has no member 'owe'\n" +
    '/progetto/.build/debug/x.swiftmodule: note\n' +
    'Sources/Core/Shared.swift:3: warning'
  expect(blame(output, '/progetto', units)).toEqual({ files: ['Sources/Core/IE/Parser.swift', 'Sources/Core/Shared.swift'], owners: ['ie'] })
  expect(blame('output line', '/progetto', units)).toEqual({ files: [], owners: [] })
  // Rust dependency sources, even with the path cut by the tail of the output.
  expect(blame('ta/.cargo/registry/src/rmcp-3.5.1/src/never.rs:51:1\n/progetto/target/debug/build/x.rs:1', '/progetto', units)).toEqual({ files: [], owners: [] })

  // Test in a container: container paths, relative to the app/ subfolder, colors and vendor/ frames.
  const php = [{ id: 'creation', paths: ['/progetto/app/tests/Invoicing', '/progetto/app/app/Services/Creator.php'], model: 'haiku' as const, lines: 100 }]
  const docker =
    '\x1b[31mFAILED\x1b[39m \x1b[32mtests/Invoicing/CreatorTest.php\x1b[39m:12\n' +
    '/var/www/html/app/Services/Creator.php:40\n' +
    '/var/www/html/vendor/laravel/framework/src/Foundation/Application.php:9'
  expect(blame(docker, '/progetto', php)).toEqual({ files: ['app/tests/Invoicing/CreatorTest.php', 'app/app/Services/Creator.php'], owners: ['creation'] })
})

const chain = [
  { id: 'types', paths: ['src/types'], lines: 100, test: ['sh', 'ok.sh'] },
  { id: 'engine', paths: ['src/engine'], lines: 100, test: ['sh', 'ok.sh'], after: ['types'] },
  { id: 'ui', paths: ['src/ui'], lines: 100, test: ['sh', 'ok.sh'], after: ['engine'] },
  { id: 'log', paths: ['src/log'], lines: 100 },
]

test('waves follow the dependencies and reject cycles', async ($, on) => {
  world(on)
  const unit = (id: string, after?: string[]) => ({ id, paths: [`/p/${id}`], model: 'haiku' as const, lines: 100, ...(after ? { after } : {}) })
  expect(waves([unit('ui', ['engine']), unit('types'), unit('engine', ['types']), unit('log')])).toEqual([['types', 'log'], ['engine'], ['ui']])
  expect(waves([unit('a', ['b']), unit('b', ['a'])])).toContain('cycle')

  const loop = await $.tool.call({ tool: TOOL, action: 'plan', units: [{ ...chain[0], after: ['ui'] }, ...chain.slice(1)] })
  expect(loop.deny).toContain('cycle')
  const stranger = await $.tool.call({ tool: TOOL, action: 'plan', units: [{ ...chain[0], after: ['other'] }] })
  expect(stranger.deny).toContain('after names other units')
  const planned = await $.tool.call({ tool: TOOL, action: 'plan', units: chain })
  expect(planned.result).toContain('waves · 1: types, log · 2: engine · 3: ui.')
})

test('a junior starts only when the units it depends on have passed the test', async ($, on) => {
  world(on)
  await $.tool.call({ tool: TOOL, action: 'plan', units: chain })
  const early = await $.agent.spawn(junior('UNIT: engine'))
  expect(early.deny).toContain('uses the code of types')

  await $.agent.spawn(junior('UNIT: types'))
  const still = await $.agent.spawn(junior('UNIT: engine'))
  expect(still.deny).toContain('types')
  const tried = await $.tool.call({ tool: TRIAL, agentId: 'agente-1' })
  expect(tried.result).toContain('ok · types')
  const now = await $.agent.spawn(junior('UNIT: engine'))
  expect(now.deny).toBeUndefined()

  const state = await $.tool.call({ tool: TOOL, action: 'status' })
  expect(state.result).toContain('ready · types, engine, log')
  expect(state.result).toContain('waiting · ui (after engine)')

  // A verify that gives ok to engine unblocks ui, even without the junior's test.
  const checked = await $.tool.call({ tool: TOOL, action: 'verify' })
  expect(checked.result).toContain('waiting · none')
  const last = await $.agent.spawn(junior('UNIT: ui'))
  expect(last.deny).toBeUndefined()
})

test('a test broken by code halfway through another junior waits for it to finish and retries', async ($, on) => {
  let uiRunning = true
  let runs = 0
  let slept = 0
  on('session.root', () => ({ value: '/progetto' }))
  on('agent.list', () => ({
    value: [
      { id: 'a1', description: 'unit', type: 'junior-team:junior', status: 'running' as const },
      ...(uiRunning ? [{ id: 'a2', description: 'unit', type: 'junior-team:junior', status: 'running' as const }] : []),
    ],
  }))
  on('agent.spawn', ($, e) => ({ model: e.model ?? '', agentId: e.prompt.includes('core') ? 'a1' : 'a2' }))
  on('process.run', ($, e) => {
    const done = { stdout: '', isStdoutTruncated: false, isStderrTruncated: false }
    if (e.argv[0] === 'codegraph') return { value: { ...done, exitCode: 0, stderr: '' } }
    // The wait goes through a sleep process: the engine does not count its time in the hook's budget.
    if (e.argv[0] === 'sleep') {
      slept += 1
      uiRunning = false
      return { value: { ...done, exitCode: 0, stderr: '' } }
    }
    runs += 1
    return runs === 1
      ? { value: { ...done, exitCode: 1, stderr: '/progetto/src/ui/View.swift:4:1: error: expected }' } }
      : { value: { ...done, exitCode: 0, stderr: '' } }
  })
  const units = [
    { id: 'core', paths: ['src/core'], lines: 100, test: ['swift', 'test'] },
    { id: 'ui', paths: ['src/ui'], lines: 100, test: ['swift', 'test'] },
  ]
  await $.tool.call({ tool: TOOL, action: 'plan', units })
  await $.agent.spawn(junior('UNIT: core'))
  await $.agent.spawn(junior('UNIT: ui'))
  const tried = await $.tool.call({ tool: TRIAL, agentId: 'a1' })
  expect(tried.result).toContain('I waited for ui to finish')
  expect(tried.result).toContain('ok · core')
  expect(slept).toBe(1)
  expect(runs).toBe(2)
})

test("a correction from the lead gives the tests back to the junior", async ($, on) => {
  world(on)
  on('tool.call', { tool: 'SendMessage' }, () => ({ result: 'sent' }))
  await $.tool.call({ tool: TOOL, action: 'plan', units: UNITS })
  await $.agent.spawn(junior('UNIT: lexer'))
  for (let i = 0; i < 3; i += 1) await $.tool.call({ tool: TRIAL, agentId: 'agente-1' })
  const spent = await $.tool.call({ tool: TRIAL, agentId: 'agente-1' })
  expect(spent.result).toContain('already run the test')
  await $.tool.call({ tool: 'SendMessage', to: 'agente-1', message: 'fix the rule' })
  const again = await $.tool.call({ tool: TRIAL, agentId: 'agente-1' })
  expect(again.result).toContain('FAILED')
})

test('a SendMessage resumes a stopped junior without the contract check', async ($, on) => {
  world(on)
  on('tool.call', { tool: 'SendMessage' }, () => ({ result: 'sent' }))
  await $.tool.call({ tool: TOOL, action: 'plan', units: UNITS })
  await $.agent.spawn(junior('UNIT: lexer'))
  await $.tool.call({ tool: 'SendMessage', to: 'agente-1', message: 'The files are in the worktree: fix the path.' })
  const resumed = await $.agent.spawn(junior('The files are in the worktree: fix the path.'))
  expect(resumed.deny).toBeUndefined()
  const stranger = await $.agent.spawn(junior('A task without a unit'))
  expect(stranger.deny).toContain('UNIT: <id>')
})

test("a junior that reads without writing gets the invitation to write", async ($, on) => {
  world(on)
  on('tool.call', { tool: 'Grep' }, () => ({ result: 'no result' }))
  await $.tool.call({ tool: TOOL, action: 'plan', units: UNITS })
  await $.agent.spawn(junior('UNIT: lexer'))
  const answers = []
  for (let i = 0; i < 15; i += 1) answers.push(await $.tool.call({ tool: 'Grep', pattern: 'x', agentId: 'agente-1' }))
  expect(answers[13].context ?? []).toEqual([])
  expect(answers[14].context?.join(' ')).toContain('15 calls without writing')
})

test("the invitation to write also reaches those who launch calls in parallel, once per threshold", async ($, on) => {
  world(on)
  on('tool.call', { tool: 'Grep' }, () => ({ result: 'no result' }))
  await $.tool.call({ tool: TOOL, action: 'plan', units: UNITS })
  await $.agent.spawn(junior('UNIT: lexer'))
  const batch = () => Promise.all(Array.from({ length: 4 }, () => $.tool.call({ tool: 'Grep', pattern: 'x', agentId: 'agente-1' })))
  const answers = []
  for (let i = 0; i < 5; i += 1) answers.push(...(await batch()))
  const nudges = answers.filter(one => (one.context ?? []).join(' ').includes('without writing'))
  expect(nudges.length).toBe(1)
})

test("a unit's status follows the junior, the tests and the dependencies", () => {
  const units = [
    { id: 'a', paths: ['/p/a'], model: 'haiku' as const, lines: 100 },
    { id: 'b', paths: ['/p/b'], model: 'haiku' as const, lines: 100, after: ['a'] },
    { id: 'c', paths: ['/p/c'], model: 'haiku' as const, lines: 100 },
  ]
  const row = { unit: 'a', role: 'junior' as const, model: 'claude-haiku-5-5', turns: 1, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, contract: 1000, code: 9000, lookups: 0, lookupChars: 0, tests: 1, reads: 0, toolCalls: 7 }
  const busy = overview(units, [['a', 'c'], ['b']], { x: row }, {}, {}, 0)
  expect(busy.units.map(one => one.phase)).toEqual(['lavoro', 'attesa', 'pronta'])
  expect(busy.units[0]?.model).toBe('haiku-5-5')
  expect(busy.leverage).toBe('9.0')

  const back = overview(units, [['a', 'c'], ['b']], { x: { ...row, done: true } }, { a: true }, { c: 2 }, 0)
  expect(back.units.map(one => one.phase)).toEqual(['ok', 'pronta', 'fallita'])
  expect(back.working).toBe(0)
})

test('panel and band are drawn on terminal and desktop', async ($, on) => {
  const seen = world(on)
  for (const surface of ['terminal', 'desktop'] as const) {
    const empty = await $.ui.mount({ plugin: 'junior-team', surface, component: 'Pane', requestId: 'junior-team', props: PANE_PROPS })
    expect(await empty.find({ type: 'Text', text: /No plan/ })).toBeDefined()
    await empty.unmount()
  }

  await $.tool.call({ tool: TOOL, action: 'plan', units: UNITS })
  await $.agent.spawn(junior('UNIT: lexer\ncontract'))
  seen.running.push('agente-1')

  for (const surface of ['terminal', 'desktop'] as const) {
    const pane = await $.ui.mount({ plugin: 'junior-team', surface, component: 'Pane', requestId: 'junior-team', props: PANE_PROPS })
    expect(await pane.find({ type: 'Text', text: 'working' })).toBeDefined()
    expect(await pane.find({ type: 'Text', text: 'ready to launch' })).toBeDefined()
    await pane.unmount()

    const band = await $.ui.mount({ plugin: 'junior-team', surface, component: 'AbovePrompt', props: BAND_PROPS })
    expect(await band.find({ type: 'Text', text: /1 working/ })).toBeDefined()
    expect(await band.find({ key: 'apri' })).toBeDefined()
    await band.unmount()
  }
})

test('a plan inside a worktree launches juniors and tests from the worktree root', async ($, on) => {
  const seen = world(on)
  on('tool.call', { tool: 'Write' }, () => ({ result: 'written' }))
  const units = [{ id: 'lexer', paths: ['/wt/src/lexer'], lines: 100 }]
  const plan = await $.tool.call({ tool: TOOL, action: 'plan', units })
  expect(plan.deny).toBeUndefined()
  await $.agent.spawn(junior('UNIT: lexer'))
  expect(seen.cwds.at(-1)).toBe('/wt')
  const write = await $.tool.call({ tool: 'Write', agentId: 'agente-1', file_path: '/wt/src/lexer/a.ts', content: 'x' })
  expect(write.deny).toBeUndefined()
  const outside = await $.tool.call({ tool: 'Write', agentId: 'agente-1', file_path: '/progetto/src/lexer/a.ts', content: 'x' })
  expect(outside.deny).toBeDefined()
})

test('units in a repository inside the session: tests and juniors start from the repository', async ($, on) => {
  const seen = world(on)
  const plan = await $.tool.call({ tool: TOOL, action: 'plan', units: [{ id: 'lexer', paths: ['/progetto/repo/src/a.ts'], lines: 100 }] })
  expect(plan.deny).toBeUndefined()
  await $.agent.spawn(junior('UNIT: lexer'))
  expect(seen.cwds.at(-1)).toBe('/progetto/repo')
})

test("a resume with SendMessage reopens the junior's call cap", async ($, on) => {
  world(on)
  on('tool.call', { tool: 'Grep' }, () => ({ result: 'nothing' }))
  on('tool.call', { tool: 'SendMessage' }, () => ({ result: 'sent' }))
  await $.tool.call({ tool: TOOL, action: 'plan', units: UNITS })
  await $.agent.spawn(junior('UNIT: lexer'))
  for (let at = 0; at < 40; at += 1) await $.tool.call({ tool: 'Grep', agentId: 'agente-1', pattern: 'x' })
  expect((await $.tool.call({ tool: 'Grep', agentId: 'agente-1', pattern: 'x' })).deny).toContain('40 without writing')
  await $.tool.call({ tool: 'SendMessage', to: 'agente-1', message: 'fix the empty branch' } as never)
  expect((await $.tool.call({ tool: 'Grep', agentId: 'agente-1', pattern: 'x' })).deny).toBeUndefined()
})

test('a failure that names only files outside the plan uses up the attempt', async ($, on) => {
  const seen = world(on)
  seen.outputs.push('Constant PDO::MYSQL_ATTR_SSL_CA is deprecated in config/database.php:61\nTests:    1 failed, 2 passed')
  await $.tool.call({ tool: TOOL, action: 'plan', units: UNITS })
  await $.agent.spawn(junior('UNIT: lexer'))
  const out = String((await $.tool.call({ tool: TRIAL, agentId: 'agente-1' })).result)
  expect(out).toContain('no unit owns: config/database.php')
  expect(out).not.toContain('does not use up')
})

test("the test file of the unit's command is not a clue to an external cause", async ($, on) => {
  const seen = world(on)
  seen.outputs.push('at src/lexer/test.php:12\nTests:    1 failed, 2 passed')
  await $.tool.call({ tool: TOOL, action: 'plan', units: [{ ...UNITS[0], paths: ['src/lexer/Lexer.php'] }, UNITS[1]] })
  await $.agent.spawn(junior('UNIT: lexer'))
  const out = String((await $.tool.call({ tool: TRIAL, agentId: 'agente-1' })).result)
  expect(out).toContain('FAILED')
  expect(out).not.toContain('no unit owns')
})

test("attribution holds on the real Pest output in Docker, with colors", () => {
  const output = "FAILED (exit 1) \u00b7 manual \u00b7 docker compose exec -T app php artisan test tests/Invoicing/Manual\n\u20262;1m\u2713\u001b[39;22m\u001b[90m \u001b[39m\u001b[90mnumero imposto gi\u00e0 usato: rifiuto con il motivo, nessuna riga scrit\u001b[39m\u001b[90m\u2026\u001b[39m \u001b[90m0.61s\u001b[39m  \n  \u001b[32;1m\u2713\u001b[39;22m\u001b[90m \u001b[39m\u001b[90mnumero libero: il successivo del sezionale\u001b[39m\u001b[90m                          \u001b[39m \u001b[90m0.64s\u001b[39m  \n  \u001b[31m\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u001b[39m  \n  \u001b[41;1m FAILED \u001b[49;22m \u001b[1mTests\\Invoicing\\Manual\\ManualInvoiceCreatorTest\u001b[22m \u001b[90m>\u001b[39m due aliquote: u\u2026   \n\u001b[39;1m  Failed asserting that 72.03999999999999 is identical to 72.04.\u001b[39;22m\n\n  at \u001b[32mtests/Invoicing/Manual/ManualInvoiceCreatorTest.php\u001b[39m:\u001b[32m91\u001b[39m\n     87\u2595         ->and((float) $fattura->vat_amount)->toBe(72.04)\n     88\u2595         ->and((float) $fattura->total_amount)->toBe(454.04)\n     89\u2595         ->and($righe->map(fn ($riga) => (float) $riga->vat_rate)->all())->toBe([22.0, 10.0])\n     90\u2595         ->and((float) $righe->sum('taxable_amount'))->toBe((float) $fattura->taxable_amount)\n  \u279c  91\u2595         ->and((float) $righe->sum('vat_amount'))->toBe((float) $fattura->vat_amount);\n     92\u2595 });\n     93\u2595 \n     94\u2595 test('IVA con imponibile a tre decimali: 33.33 \u00d7 3 al 22% d\u00e0 imponibile 99.99 e IVA 22.00', function () {\n     95\u2595     travasoCasoManuale();\n\n  \u001b[33m1   \u001b[39m\u001b[39;1mtests/Invoicing/Manual/ManualInvoiceCreatorTest.php\u001b[39;22m:\u001b[39;1m91\u001b[39;22m\n\n\n  \u001b[90mTests:\u001b[39m    \u001b[31;1m1 failed\u001b[39;22m\u001b[90m,\u001b[39m\u001b[39m \u001b[39m\u001b[32;1m10 passed\u001b[39;22m\u001b[90m (57 assertions)\u001b[39m\n  \u001b[90mDuration:\u001b[39m \u001b[39m8.81s\u001b[39m"
  const root = '/home/dev/billing'
  const units = [{ id: 'manual', paths: [`${root}/app/app/Invoicing/Manual/ManualInvoiceCreator.php`, `${root}/app/tests/Invoicing/Manual`], lines: 250, model: 'haiku' as const }]
  expect(blame(output, root, units).owners).toEqual(['manual'])
})

test('the failed-test count reads the summaries of the runners', () => {
  expect(failedCount('FAILED · x\n  Tests:    \x1b[31;1m3 failed\x1b[39;22m, 20 passed')).toBe(3)
  expect(failedCount('FAILED · x\n===== 1 failed, 61 passed in 2.1s =====')).toBe(1)
  expect(failedCount('FAILED · x\ntest result: FAILED. 4 passed; 2 failed; 0 ignored')).toBe(2)
  expect(failedCount('ok · x')).toBe(0)
  expect(failedCount('FAILED · x\nsegmentation fault')).toBeUndefined()
})

test('a junior that reduces the failing tests gets runs beyond the third, up to five', async ($, on) => {
  const seen = world(on)
  await $.tool.call({ tool: TOOL, action: 'plan', units: UNITS })
  await $.agent.spawn(junior('UNIT: lexer'))
  seen.outputs.push('Tests: 9 failed', 'Tests: 42 failed', 'Tests: 5 failed', 'Tests: 2 failed', 'Tests: 1 failed', 'Tests: 1 failed')
  for (let i = 0; i < 5; i++) expect((await $.tool.call({ tool: TRIAL, agentId: 'agente-1' })).result).toContain('FAILED')
  const sixth = await $.tool.call({ tool: TRIAL, agentId: 'agente-1' })
  expect(sixth.result).toContain('You have already run the test 5 times')

  await $.agent.spawn(junior('UNIT: lexer'))
  seen.outputs.push('Tests: 1 failed', 'Tests: 1 failed', 'Tests: 1 failed')
  for (let i = 0; i < 3; i++) await $.tool.call({ tool: TRIAL, agentId: 'agente-2' })
  const stuck = await $.tool.call({ tool: TRIAL, agentId: 'agente-2' })
  expect(stuck.result).toContain('You have already run the test 3 times')
})

test('a diff of long records shows only the part that changes', () => {
  const record = (state: string) => `-    3 => '{"Matricola":"","CodStato":"${state}",${'"Campo":"valore",'.repeat(200)}"Fine":"1"}',`
  const minus = record('S')
  const plus = `+${record('A').slice(1)}`
  const out = shorten(`Failed asserting that two arrays are identical.\n\x1b[31m${minus}\x1b[39m\n${plus}\nTests:    1 failed`)
  expect(out).toContain('"CodStato":"S"')
  expect(out).toContain('"CodStato":"A"')
  expect(out.length).toBeLessThan(500)
  expect(out).not.toContain('\x1b')
  expect(shorten('x'.repeat(1000))).toContain('(+760 characters)')
})

test("the plan flags a test run by several units or owned by another unit", async ($, on) => {
  world(on)
  const golden = ['php', 'artisan', 'test', 'tests/Golden/GoldenTest.php', '--filter=closing']
  const units = [
    { id: 'closing', paths: ['app/Closing'], lines: 100, test: golden },
    { id: 'reopen', paths: ['app/Reopen'], lines: 100, test: golden },
    { id: 'lexer', paths: ['src/lexer'], lines: 100, test: ['php', 'src/core/test.php'] },
    { id: 'core', paths: ['src/core'], lines: 100, test: ['php', 'src/core/test.php'] },
  ]
  const notes = sharedTests(units, '/progetto')
  expect(notes).toContain('tests/Golden/GoldenTest.php is the test of closing, reopen')
  expect(notes).toContain('the test of lexer runs src/core/test.php, which sits in unit core')
  expect(sharedTests(UNITS, '/progetto')).toEqual([])
  const runner = (file: string) => ['tools/lxc_test.sh', file]
  const sail = (file: string) => ['./vendor/bin/sail', 'exec', 'laravel.test', 'php', 'artisan', 'test', file]
  expect(sharedTests([
    { id: 'a', paths: ['app/A'], lines: 100, test: runner('tests/ATest.php') },
    { id: 'b', paths: ['app/B'], lines: 100, test: runner('tests/BTest.php') },
    { id: 'c', paths: ['app/C'], lines: 100, test: sail('tests/CTest.php') },
    { id: 'd', paths: ['app/D'], lines: 100, test: sail('tests/DTest.php') },
  ], '/progetto')).toEqual([])
  const out = String((await $.tool.call({ tool: TOOL, action: 'plan', units })).result)
  expect(out).toContain('Shared tests')
  expect(out).toContain('checks')
})

test("a correction to a junior whose unit the plan removed is refused with the reason", async ($, on) => {
  world(on)
  on('tool.call', { tool: 'SendMessage' }, () => ({ result: 'sent' }))
  await $.tool.call({ tool: TOOL, action: 'plan', units: UNITS })
  await $.agent.spawn(junior('UNIT: lexer'))
  await $.tool.call({ tool: TOOL, action: 'plan', units: [UNITS[1]] })
  const sent = await $.tool.call({ tool: 'SendMessage', to: 'agente-1', message: 'fix the lexer' })
  expect(sent.deny).toContain('unit lexer is no longer in the plan')
  await $.tool.call({ tool: TOOL, action: 'plan', units: UNITS })
  const again = await $.tool.call({ tool: 'SendMessage', to: 'agente-1', message: 'fix the lexer' })
  expect(again.deny).toBeUndefined()
})

test("an isolated unit works and tests in its worktree and on hand-back returns to the main folder", async ($, on) => {
  const seen = world(on)
  const writes: string[] = []
  on('tool.call', { tool: 'Write' }, ($, e) => (writes.push(e.file_path), { result: 'written' }))
  const units = [{ ...UNITS[0], isolated: true, light: true }, UNITS[1]]
  await $.tool.call({ tool: TOOL, action: 'plan', units })
  await $.agent.spawn(junior('UNIT: lexer'))
  const dir = '/progetto/.git/junior-team-wt/lexer'
  expect(seen.cwds.at(-1)).toBe(dir)
  expect(seen.scripts.some(args => args[0] === '/progetto' && args[1] === dir)).toBe(true)

  const ok = await $.tool.call({ tool: 'Write', agentId: 'agente-1', file_path: '/progetto/src/lexer/Lexer.php', content: 'x' })
  expect(ok.deny).toBeUndefined()
  expect(writes.at(-1)).toBe(`${dir}/src/lexer/Lexer.php`)
  const inside = await $.tool.call({ tool: 'Write', agentId: 'agente-1', file_path: `${dir}/src/lexer/Other.php`, content: 'x' })
  expect(inside.deny).toBeUndefined()
  const out = await $.tool.call({ tool: 'Write', agentId: 'agente-1', file_path: '/progetto/src/core/Core.php', content: 'x' })
  expect(out.deny).toContain('outside the unit lexer')

  await $.tool.call({ tool: TRIAL, agentId: 'agente-1' })
  expect(seen.testCwds.at(-1)).toBe(dir)

  const before = seen.scripts.length
  await $.tool.call({ tool: 'SubagentHandback', agentId: 'agente-1', message: 'done' } as never)
  const after = seen.scripts.slice(before)
  expect(after.some(args => args.includes('src/lexer'))).toBe(true)
  expect(after.length).toBeGreaterThanOrEqual(2)
})

test('light requires a test and isolated is boolean', async ($, on) => {
  world(on)
  const light = await $.tool.call({ tool: TOOL, action: 'plan', units: [{ id: 'x', paths: ['src/x'], lines: 100, light: true }] })
  expect(light.deny).toContain('light without a test')
  const bad = await $.tool.call({ tool: TOOL, action: 'plan', units: [{ id: 'x', paths: ['src/x'], lines: 100, isolated: 'yes' }] })
  expect(bad.deny).toContain('booleans')
})
