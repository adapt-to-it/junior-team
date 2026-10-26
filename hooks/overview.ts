import { k, leverage } from './plan'
import type { AgentRow, Unit } from '../types'

// The state of a unit as shown by the panel and the band.
export type Phase = 'lavoro' | 'ok' | 'fallita' | 'rientrata' | 'attesa' | 'pronta'

export type UnitView = {
  id: string
  model: string
  wave: number
  phase: Phase
  // One detail line: who is waiting, calls and tests, code written.
  detail: string
}

export type Overview = {
  units: UnitView[]
  working: number
  waiting: number
  leverage: string
  juniorCode: number
}

const rowsOf = (agents: Record<string, AgentRow>, unit: string): AgentRow[] =>
  Object.values(agents).filter(row => row.role === 'junior' && row.unit === unit)

export const overview = (
  units: readonly Unit[],
  rounds: readonly string[][],
  agents: Record<string, AgentRow>,
  passed: Record<string, boolean>,
  failures: Record<string, number>,
  spent: number,
): Overview => {
  const waveOf = (id: string): number => rounds.findIndex(round => round.includes(id)) + 1
  const views = units.map((unit): UnitView => {
    const rows = rowsOf(agents, unit.id)
    const last = rows[rows.length - 1]
    const code = rows.reduce((sum, row) => sum + row.code, 0)
    const runs = rows.length > 1 ? ` · ${rows.length} runs` : ''
    const missing = (unit.after ?? []).filter(dep => passed[dep] !== true)
    const base = { id: unit.id, model: last?.model.replace(/^claude-/, '') ?? unit.model, wave: waveOf(unit.id) }
    if (last !== undefined && last.done !== true) {
      return { ...base, phase: 'lavoro', detail: `${last.toolCalls} calls · tests ${last.tests} · code ${k(code)}${runs}` }
    }
    if (passed[unit.id] === true) return { ...base, phase: 'ok', detail: `code ${k(code)}${runs}` }
    if ((failures[unit.id] ?? 0) > 0) return { ...base, phase: 'fallita', detail: `${failures[unit.id]} verifications failed in a row${runs}` }
    if (last !== undefined) return { ...base, phase: 'rientrata', detail: `test not passed · code ${k(code)}${runs}` }
    if (missing.length > 0) return { ...base, phase: 'attesa', detail: `after ${missing.join(', ')}` }

    return { ...base, phase: 'pronta', detail: `${unit.lines} lines expected` }
  })
  const juniors = Object.values(agents).filter(row => row.role === 'junior')
  const juniorCode = juniors.reduce((sum, row) => sum + row.code, 0)
  const contracts = juniors.reduce((sum, row) => sum + row.contract, 0)

  return {
    units: views,
    working: views.filter(view => view.phase === 'lavoro').length,
    waiting: views.filter(view => view.phase === 'attesa').length,
    leverage: leverage(juniorCode, contracts + spent),
    juniorCode,
  }
}

export const PHASE_LABEL: Record<Phase, string> = {
  lavoro: 'working',
  ok: 'test passed',
  fallita: 'verification failed',
  rientrata: 'handed back',
  attesa: 'waiting',
  pronta: 'ready to launch',
}
