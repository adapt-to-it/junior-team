# junior-team

A Claude Code plugin that splits a code change into units under contract and hands each unit to a junior agent (Haiku by default). Each junior gets a short contract, a fixed file scope and a test command. The plugin runs the tests, enforces the file scope and measures tokens and leverage.

## What it does

- The architect (the main session, guided by the `junior-team` skill) writes signatures, shared types and short contracts, then launches one junior per unit.
- Each junior writes only the files of its unit and checks them with the `test` tool.
- Shared context lives on a board of notes that point to symbols in a project index, not in the contract.
- `verify` runs the unit tests and the project-wide checks without model turns.
- The architect integrates the results from an outline and reports the leverage: code written by juniors versus tokens spent by the architect.

Small tasks, and scattered edits across many files, stay with the architect: there the contract would cost as much as the code.

## Install

```
claude plugin marketplace add adapt-to-it/junior-team
claude plugin install junior-team@junior-team
```

## Requirements

- The `codegraph` CLI, used to build and update the project index. `plan` creates the index in `.codegraph/` if it is missing; the first run on a large project takes a few minutes.
- `git`, for `isolated` units, which work in their own worktree.

## Plan fields

The architect declares the plan with `action: "plan"` on the `team` tool:

- `units`: a list where each entry has
  - `id`: the unit name, used in `UNIT: <id>`;
  - `paths`: files or folders the unit may write; they must be disjoint across units, and should include the registration files (route tables, registries, providers);
  - `lines`: expected lines, at least 80;
  - `model`: `haiku` (default); `sonnet` only after two consecutive failed verifications;
  - `test`: argv of the unit's test, covering only that unit's code;
  - `light` (optional): the test uses no shared resources and runs in parallel without the queue;
  - `isolated` (optional): the junior works in its own git worktree.
- `checks`: acceptance tests, lint and build, as argv; run only by `verify`.
- `after` (optional): the ids of the units whose code this unit uses beyond the skeleton.

`plan` rejects units under 80 lines, flags tests shared by several units, and returns the waves.

## Workflow

1. `plan`: declare the units, the checks and the dependencies. Write shared types and signatures to disk first.
2. `note`: add board notes that point to symbols (`refs`) or record single decisions (`text`).
3. Launch: one `junior-team:junior` per unit, all in one message, with the contract as the prompt. When units declare `after`, launch only the first wave.
4. `verify`: at the end of each wave, runs the tests and the checks. Failed units go back to their junior.
5. `outline` and `lookup` to integrate and inspect the boundaries; `status` for the final report.

The `/team-panel` command reopens the progress panel. Nothing is committed automatically.

## License

MIT. See [LICENSE](LICENSE).
