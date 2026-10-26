import type { Note, Unit } from '../types'

const KEY = /^[\w-]{1,40}$/
const NOTES_MAX = 40
const REFS_MAX = 12
// The note is a pointer: a long text brings back into the contract the cost that the cap removed.
const TEXT_MAX = 300
export const KEYS_MAX = 8

const strings = (value: unknown): string[] | undefined =>
  Array.isArray(value) && value.every(part => typeof part === 'string' && part.trim() !== '')
    ? (value as string[]).map(part => part.trim())
    : undefined

// The input comes from the model: an invalid note returns as a reason and no note is written.
export const parseNotes = (input: unknown, units: readonly Unit[]): Note[] | string => {
  if (!Array.isArray(input) || input.length === 0) return 'note requires notes with at least one note.'
  if (input.length > NOTES_MAX) return `note accepts at most ${NOTES_MAX} notes per call.`

  const notes: Note[] = []
  for (const one of input as unknown[]) {
    if (typeof one !== 'object' || one === null) return 'each note is an object with key and refs.'
    const { key, refs, text, unit } = one as Record<string, unknown>
    if (typeof key !== 'string' || !KEY.test(key)) return `invalid key: ${String(key)}. Use letters, digits, _ and -.`
    const listed = refs === undefined ? [] : strings(refs)
    if (listed === undefined || listed.length > REFS_MAX) return `refs of note ${key} is a list of at most ${REFS_MAX} references.`
    if (text !== undefined && typeof text !== 'string') return `text of note ${key} must be a string.`
    const said = typeof text === 'string' ? text.trim() : ''
    if (said.length > TEXT_MAX) {
      return (
        `text of note ${key} has ${said.length} characters, the maximum is ${TEXT_MAX}. No note from this call was saved. ` +
        'Shorten it, or put data and lists in a project file and cite it in refs.'
      )
    }
    if (listed.length === 0 && said === '') return `note ${key} requires refs or text.`
    if (unit !== undefined && !units.some(known => known.id === unit)) return `note ${key} names a unit the plan does not have: ${String(unit)}.`

    notes.push({ key, refs: listed, ...(said === '' ? {} : { text: said }), ...(typeof unit === 'string' ? { unit } : {}) })
  }

  return notes
}

// A junior sees the notes of all units and those of its own unit. The lead, without a unit, sees all of them.
export const isVisible = (note: Note, unit: string | undefined): boolean =>
  unit === undefined || note.unit === undefined || note.unit === unit

export const noteChars = (notes: Record<string, Note>): number =>
  Object.values(notes).reduce(
    (sum, note) => sum + note.key.length + (note.text?.length ?? 0) + note.refs.reduce((all, ref) => all + ref.length, 0),
    0,
  )

export const parseKeys = (input: unknown): string[] | string => {
  const keys = strings(input)
  if (keys === undefined || keys.length === 0) return 'lookup requires keys: board keys or references.'
  if (keys.length > KEYS_MAX) return `lookup accepts at most ${KEYS_MAX} keys per call.`

  return keys
}

export const describeBoard = (notes: Record<string, Note>, misses: readonly string[], index: string): string =>
  [
    `index · ${index === '' ? 'not yet prepared' : index}`,
    `board · ${Object.keys(notes).length} notes · ${noteChars(notes)} characters${
      Object.keys(notes).length === 0
        ? ''
        : ` · ${Object.values(notes)
            .map(note => (note.unit === undefined ? note.key : `${note.key} (${note.unit})`))
            .join(', ')}`
    }`,
    `not found · ${misses.length === 0 ? 'none' : [...new Set(misses)].join(', ')}`,
  ].join('\n')
