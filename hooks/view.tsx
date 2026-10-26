import { atom, read, update } from 'claude-code'
import type { Color, EngineInterface, On } from 'claude-code'

import { noteChars } from './board'
import { k, waves } from './plan'
import { PHASE_LABEL, overview } from './overview'
import type { Phase } from './overview'

// Team panel and band. The same tree serves the terminal and the desktop app.
export const PANE = 'junior-team'
const TITLE = 'Team'

const units = atom({ plugin: 'junior-team', key: 'units' } as const, [])
const agents = atom({ plugin: 'junior-team', key: 'agents' } as const, {})
const notes = atom({ plugin: 'junior-team', key: 'notes' } as const, {})
const passed = atom({ plugin: 'junior-team', key: 'passed' } as const, {})
const failures = atom({ plugin: 'junior-team', key: 'failures' } as const, {})
const architect = atom({ plugin: 'junior-team', key: 'architect' } as const, { code: 0, bash: 0, solo: 0, noticed: 0 })
const index = atom({ plugin: 'junior-team', key: 'index' } as const, '')
const context = atom({ plugin: 'junior-team', key: 'context' } as const, 0)
const heavy = atom({ plugin: 'junior-team', key: 'heavy' } as const, false)

const PHASE_COLOR: Record<Phase, Color> = {
  lavoro: 'claude',
  ok: 'success',
  fallita: 'error',
  rientrata: 'warning',
  attesa: 'subtle',
  pronta: 'text',
}

type Engine = EngineInterface

export function openPane($: Engine) {
  return $.ui.open({ id: PANE, title: TITLE })
}

const snapshot = async ($: Engine) => {
  const plan = await read($, units)
  const rounds = waves(plan)
  const own = await read($, architect)
  const spent = noteChars(await read($, notes)) + own.code + own.bash

  return {
    plan,
    rounds: typeof rounds === 'string' ? [plan.map(unit => unit.id)] : rounds,
    view: overview(plan, typeof rounds === 'string' ? [] : rounds, await read($, agents), await read($, passed), await read($, failures), spent),
  }
}

const compactHint = (size: number): string => `context ${Math.round(size / 1000)}K: compacting before the next wave reduces the cost`

// The button runs /compact as if the user typed it: the engine queues it until the session is free.
// `$.session.compact` is not available in desktop app sessions, which run without a terminal.
const runCompact = async ($: EngineInterface): Promise<void> => {
  try {
    await $.command.run({ command: 'compact' })
    await setHeavy($, false)
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    $.ui.toast(`Compaction failed: ${reason}`)
  }
}

export const registerView = (on: On): void => {
  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Button, Text } = $.ui.resolve(e)
    const { plan, rounds, view } = await snapshot($)
    if (plan.length === 0) {
      return (
        <Box flexDirection="column">
          <Text dimColor>No plan in this session. The panel fills when the lead declares a plan.</Text>
        </Box>
      )
    }
    const own = await read($, architect)
    const isHeavy = await read($, heavy)

    return (
      <Box flexDirection="column" gap={1}>
        <Box flexDirection="column">
          <Text bold>
            {view.working} working · {view.units.filter(one => one.phase === 'ok').length}/{view.units.length} passed · leverage {view.leverage}
          </Text>
          <Text dimColor>
            junior code {k(view.juniorCode)} · written by the lead {k(own.code + own.bash)} · index {(await read($, index)) || 'not prepared'}
          </Text>
          {isHeavy && (
            <Box flexDirection="row" gap={1}>
              <Text color="warning">{compactHint(await read($, context))}</Text>
              <Button key="compatta" label="/compact" onPress={() => runCompact($)} />
            </Box>
          )}
        </Box>
        {rounds.map((round, at) => (
          <Box key={`ondata-${at + 1}`} flexDirection="column">
            {rounds.length > 1 && <Text dimColor>Wave {at + 1}</Text>}
            {view.units
              .filter(one => round.includes(one.id))
              .map(one => (
                <Box key={one.id} flexDirection="row" gap={1}>
                  <Text bold>{one.id}</Text>
                  <Text dimColor>{one.model}</Text>
                  <Text color={PHASE_COLOR[one.phase]}>{PHASE_LABEL[one.phase]}</Text>
                  <Text dimColor wrap="truncate-end">
                    {one.detail}
                  </Text>
                </Box>
              ))}
          </Box>
        ))}
      </Box>
    )
  })

  // The band appears only when there is something to know: juniors working or heavy context at the start of a wave.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)
    const isHeavy = await read($, heavy)
    const { plan, view } = await snapshot($)
    if (!isHeavy && (plan.length === 0 || view.working === 0)) return next(e)
    const { Box, Button, Text } = $.ui.resolve(e)
    const parts = [
      view.working > 0 ? `${view.working} working` : '',
      view.waiting > 0 ? `${view.waiting} waiting` : '',
      plan.length > 0 ? `leverage ${view.leverage}` : '',
    ].filter(part => part !== '')

    return (
      <Box flexDirection="row" gap={1}>
        <Text bold>team</Text>
        {parts.length > 0 && <Text dimColor>{parts.join(' · ')}</Text>}
        {isHeavy && <Text color="warning">{compactHint(await read($, context))}</Text>}
        {isHeavy && <Button key="compatta" label="/compact" onPress={() => runCompact($)} />}
        {plan.length > 0 && <Button key="apri" plain label="Panel" onPress={() => openPane($)} />}
      </Box>
    )
  })
}

export function setHeavy($: Engine, value: boolean): Promise<unknown> {
  return update($, heavy, () => value)
}
