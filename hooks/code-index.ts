import { isInside, normalize } from './plan'

// A reference names a file, a symbol, or a symbol inside a file: `src/a.ts`, `parsePlan`, `src/a.ts#parsePlan`.
export type Ref = { file?: string; symbol?: string }

const REF_MAX = 200
const SLICE_MAX = 3000
const FENCE = '```'

// The reason for rejection, when the text is not a reference inside the project.
export const parseRef = (text: string, root: string): Ref | string => {
  const given = text.trim()
  if (given === '' || given.length > REF_MAX) return `invalid reference: ${given.slice(0, 40)}`
  const cut = given.indexOf('#')
  const left = cut === -1 ? given : given.slice(0, cut)
  const right = cut === -1 ? '' : given.slice(cut + 1)
  const isFile = cut !== -1 || left.includes('/') || /\.\w{1,5}$/.test(left)
  const file = isFile ? left : ''
  const symbol = isFile ? right : left
  // A name starting with `-` would reach codegraph as an option.
  if (file.startsWith('-') || symbol.startsWith('-')) return `invalid reference: ${given}`
  if (file === '' && symbol === '') return `invalid reference: ${given}`
  if (file === '') return { symbol }

  const base = normalize(root, root)
  const full = normalize(file, root)
  if (full === base || !isInside(full, [base])) return `${file} is outside the project.`

  return { file: full.slice(base.length + 1), ...(symbol === '' ? {} : { symbol }) }
}

// The arguments of `codegraph`: a file without a symbol returns only the symbol map.
export const nodeArgv = (ref: Ref, root: string): string[] => [
  'node',
  '-p',
  root,
  ...(ref.file === undefined ? [] : ['-f', ref.file]),
  ...(ref.symbol === undefined ? ['--symbols-only'] : [ref.symbol]),
]

export const isMiss = (exitCode: number, output: string): boolean =>
  exitCode !== 0 || output.trim() === '' || /not found in the codebase|^No indexed file matches/i.test(output)

// Reduces codegraph's response to what the junior needs: without body, location, signature and comment remain.
export const shape = (output: string, withBody: boolean): string => {
  const kept = output
    .split('\n')
    .filter(line => !line.startsWith('**Trail'))
    .join('\n')
    .trim()
  const fence = kept.indexOf(FENCE)
  const text =
    withBody || fence === -1 ? kept : `${kept.slice(0, fence).trim()}\n(body omitted: request it with body: true)`

  return text.length <= SLICE_MAX ? text : `${text.slice(0, SLICE_MAX)}…`
}

const OUTLINE_MAX = 1500
// The entries that do not say how a module is called from outside.
const INNER = /^- `[^`]+` \((property|import|variable|parameter)\)/

// The symbol map of a file reduced to its interface: classes, functions, methods, constants, types.
// The signature appears where codegraph exposes it for that language: in PHP only name and line remain.
export const outline = (output: string): string => {
  const text = output
    .split('\n')
    .filter(line => line.trim() !== '' && line !== '**Symbols**' && !line.startsWith('>') && !INNER.test(line))
    .map(line => (line.startsWith('**') ? line.replace(/, used by .*$| — \d+ symbols.*$/, '') : line))
    .join('\n')

  return text.length <= OUTLINE_MAX ? text : `${text.slice(0, OUTLINE_MAX)}…`
}

export const isInitialized = (statusJson: string): boolean => {
  try {
    const parsed: unknown = JSON.parse(statusJson)

    return typeof parsed === 'object' && parsed !== null && (parsed as { initialized?: unknown }).initialized === true
  } catch {
    return false
  }
}
