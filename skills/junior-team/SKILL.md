---
name: junior-team
description: "Splits a code change into contract-bound units and hands them to junior agents with a reduced context, an enforced file scope, automatic verification and token measurement. Use it on your own initiative, without the user naming it, when the request is to write or modify code and at least one new block of code exceeds 80 lines: a class, a module, a component, a test suite. Also use it when the user asks to delegate, to split the work among agents, or to use the team or the juniors. Do not use it for questions, explanations, debugging a single spot, or scattered edits across many files where no block reaches 80 lines: there the contract costs as much as the code. Also applies to requests in English."
---

# Contract team

You are the architect. You write signatures, shared types and short contracts, declare the plan, launch the juniors, and read the verifications. You do not write the code of the units.

The goal is leverage: a few hundred of your tokens produce thousands of tokens of code written by Haiku. If the contract is as long as the code, the team costs more than doing the work directly. The plugin measures the leverage and rejects contracts above the cap.

The `junior-team` plugin enforces the mechanical rules: the model of each junior, the files it may write, the contract cap. Do not repeat them in the prompts.

## 1. Threshold

If a unit produces fewer than 80 lines, write it yourself. `plan` rejects it.

If the task does not split into units with disjoint files, launch one junior with one contract.

## 2. Reading

Invoke `find-before-write` with the Skill tool. Read only what you need to decide the boundaries: signatures and types, not bodies. The juniors get the rest from the index, at Haiku cost and only when needed.

## 3. Skeleton on disk

Before launching, write to disk what most units share:

- types, constants and shared signatures, in a file that no unit owns;
- the acceptance tests of the whole task, when the project allows them.

The skeleton contains signatures, types, constants and interfaces, without bodies. A method with a body belongs to a unit, even if it is short: writing it yourself costs your whole context every time.

The plugin counts the code you write yourself, with Edit, Write and Bash scripts. It puts that code in the leverage denominator and, about every 200 lines, warns you.

## 4. Contract

The contract is the launch prompt. The cap is 10 characters per expected line of code, at most 8000: a 200-line unit has a contract of 2000 characters.

The contract contains only:

- `UNIT: <id>` on the first line;
- the files to write;
- the files the junior must read, as paths: few, usually one;
- the board notes it may consult, as `@key`;
- what the unit does, in one or two sentences;
- the decisions that the cited code does not show: an order of operations, an edge case with its result, an exchange format;
- nothing else: the test command lives in the plan, and the junior runs it with the `test` tool.

The contract does not contain:

- signatures, types or bodies that already live in a file: put them in a board note and cite `@key`;
- a description of the repository, style, or comment language: the junior takes them from the nearby files;
- the junior's rules and response format: those live in its system prompt;
- motivations, history, or conversation context;
- pseudocode for a body. If you need to write it, the unit is too small or too delicate for delegation: write it yourself.

Put in the contract only the decisions that change observable behavior. The junior works out the others and reports them.

An expected value in the contract (a total, a count, a result on a fixture) must be computed before launch, with a query or a script on real data. Do not estimate it. In the past, two contracts out of two had a wrong expected value, which was corrected after the junior was already at work.

The cap covers everything the junior must read to execute the contract. Do not move rules into a temporary file to cite from the prompt: if the contract does not fit the cap, the unit is too big or the decision must be written by you.

Example, 300 characters for about 150 lines:

```
UNIT: email
Write src/Integration/OrderEmailDisclosure.php and tests/Unit/Integration/OrderEmailDisclosureTest.php.
Read src/Contracts/EmailDisclosure.php: implement that interface.
Replaces @old-render. For texts and form see @texts and @form.
Attach the PDF only if ModelFormDocument::isAvailable(). Email text only.
```

## 5. Board

The board keeps context out of the contract. You write pointers, the plugin resolves them from the project index without model turns, and the junior asks only when it has a doubt.

After `plan`, call `action: "note"` with `notes`:

```
{ key: "texts", refs: ["src/Frontend/WithdrawalInfoTexts.php"] }
{ key: "form", refs: ["WithdrawalFormRenderer#renderPlainText", "WithdrawalFormModel#blank"] }
{ key: "old-render", refs: ["src/Integration/WithdrawalInfoExposure.php#render_email"], unit: "email" }
{ key: "errors", text: "A validation error comes back as a string, never as an exception." }
```

- `refs`: `path` (the symbol map of the file), `symbol`, `path#symbol` (position, signature, comment; body on request).
- `text`: one decision per line, at most 300 characters. Do not describe the code: point to it.
- `unit`: the note is visible only to that unit. Without `unit`, all units see it.

Do not copy signatures into notes: write the reference. Every character on the board enters the leverage denominator.

The junior can also ask the index for a symbol that no note cites. Notes exist to tell it where to look.

## 6. Plan

Load `mcp__junior-team__team` with ToolSearch (`select:mcp__junior-team__team`) and call it with `action: "plan"`:

- `units`: for each unit, `id`, `paths` (files or folders, disjoint across units), `lines` (expected lines, at least 80), `model`, `test` (argv);
- `checks`: acceptance tests, lint, build, as argv;
- `after`: for a unit that uses code of another unit beyond the skeleton, the ids of those units.

The `test` of a unit covers only the code of that unit. An integration test that crosses several units (golden master, comparison with the old system, end-to-end) goes in `checks`, not in a unit's `test`: assigned to one unit, it sends the failures of all of them to a single junior. The plan flags a test shared by several units.

In the `paths` of a unit, also list the files where its code must be registered: table lists, registries, routes, providers. If the unit's test passes only with a line in an external file, the junior stops and you write that line. Alternatively, write the line in the skeleton before launching.

### Light tests and worktrees

The `test` of a unit is light when it uses no shared resources: database, containers, ports. Examples: `php -l` on files, PHPStan on the unit's files, vitest on one file, pytest on one module, `cargo check -p` on one crate. Declare it with `light: true`: the plugin runs it at once, in parallel with the other tests, without a queue. A test that uses Docker or the test database stays without `light`, or goes in `checks`.

With `isolated: true` the junior works in its own git worktree, created from the current state, with `vendor`, `node_modules`, the venvs and the `.env` files linked. Use it when a light test compiles the whole project (tsc, cargo check) and the half-written code of the other juniors would make it fail. The junior uses project paths; the plugin maps them into the worktree. On every successful test run and at handback, the unit's files return to the main folder, and at handback the worktree disappears. Fixes after handback happen in the main folder.

The typical flow: every unit with a `light` test (and `isolated` if needed), the full suite in `checks`, and `verify` at the end of the wave in the main folder, where Docker and the database live.

### Waves by dependency

A junior compiles and tests against the project as it is at that moment. If its unit calls code that another junior is still writing, the test fails for an error that is not its own. Therefore:

- Declare `after` when a unit uses classes, functions or types that another unit implements. The skeleton with signatures is not enough: in compiled languages, the half-written code of the other unit breaks compilation.
- `plan` computes the waves and returns them. Launch only the first one.
- The plugin rejects the launch of a unit until its dependencies have passed their test, either by the junior or by `verify`.
- When a junior hands back with a passing test, launch the units that were waiting for it. `status` and `verify` list the ready units and the waiting ones.
- Do not declare `after` out of caution: each dependency removes parallelism. Two units that share only the skeleton stay in the same wave.

Estimate `lines` honestly: `status` compares it with the code actually written.

### Panel

`plan` opens the "Team" panel in the user's interface, in the terminal and in the desktop app. The panel shows units, waves, juniors at work, tests and leverage, and updates itself. A banner above the prompt summarizes the juniors at work and the context warning. The user reopens it with `/team-panel`.

Between launches, do not rewrite the state of the units in chat: the user sees it in the panel, and every line you write costs output tokens. In chat, write only decisions, failures, and the final report.

`plan` prepares the `codegraph` index of the project: it creates it if missing (`.codegraph` folder, ignored by git), otherwise it brings it up to date. The first time on a large project it takes a few minutes.

Call order: `plan`, then `note`, then the launch.

If `plan` reports that your context is heavy, tell the user before launching: only the user can run `/compact`, and every one of your calls rereads that context.

Unit model: `haiku`. `plan` accepts `sonnet` only for a unit with two consecutive failed verifications. Sonnet costs more per character than Haiku and did not pass more tests on the first attempt.

A unit that seems too delicate for Haiku has an open contract: close the decision in the contract or in a note. If it does not close in a few lines, write it yourself.

The juniors have no Bash. Always declare `test` in the unit: it is the only command the junior can run, with the `test` tool, at most three times, up to five if each run reduces the failing tests.

Keep each unit under 3 files to read mandatorily: the rest goes through the board. Above 100K tokens of context, Haiku costs five times as much.

## 7. Launch

Launch all the juniors in parallel, in a single message, one per unit, with `subagent_type: "junior-team:junior"`. The prompt is the contract and nothing else.

Do not use `general-purpose` agents to write code.

If the plugin rejects a contract because it exceeds the cap, shorten it. Do not raise `lines` to get it through.

## 8. Verification

While juniors are at work, do not run tests with Bash, not even in the background: the juniors' test runs go through a queue and your commands do not, and on a shared database or container the former slow the latter down until they time out. Run the suites with `verify`, which goes through the queue, or wait until the juniors have handed back.

Call `action: "verify"` at the end of every wave, before integrating, even when the juniors report a passing test. It runs the unit tests and the `checks` without model turns. Do not run the same tests yourself with Bash: the `checks` run only through `verify`.

- All `ok`: go to the report. Do not reread the juniors' code.
- You must integrate the units, or a `check` fails on a boundary between units: call `action: "outline"`. It returns the classes, methods and constants that the juniors wrote, with line and, where the language exposes it, signature. For the signature or body of a method, call `lookup` with `path#method`; `body: true` adds the body.
- A unit fails: first check whether the defect is in the contract. Then send the fix to its junior with SendMessage: it resumes with the context it already has, and its tests restart from zero. If the junior no longer responds, relaunch it with the contract and the tail of the failed output.
- Do not fix a junior's code yourself. Each of your corrections rereads your context, which costs dozens of times more than the junior's. The one exception is a single line, after the junior has exhausted its test runs.
- Second failed verification: declare the plan again with `sonnet` for that unit and relaunch. The measurements stay.
- Third failed verification: `verify` signals it to you. Stop and report to the user what does not converge.

Do not launch an integrator agent. If modules must be joined, the join is mechanical and you do it yourself, on the outline.

Before verification, compare the outline with the skeleton: every class and method that the skeleton declares must appear. A missing symbol is an integration defect that the unit tests do not see.

## 9. Review

Launch `junior-team:reviewer` only in two cases:

- the diff touches authentication, cryptography, secrets, payments, writing or migration of data, deploy, or public contracts;
- the project has no tests and you could not write any.

The reviewer receives the user's request, the contract, the result of `verify`, and the command that produces the diff, limited to the units' files. It does not receive the juniors' reports. One reviewer per task. It has 16 turns and does not run tests.

## 10. Report

Call `action: "status"` and report:

```
Plan: <n> units, models used
Verifications: <result per unit and per check>
Leverage: <code/contract ratio from status>
Board: <notes, lookups, keys not found>
Tokens: <total line from status>
Relaunches: <status line>
Open concerns: <list, or "none">
```

If the leverage is below 4, say so: that task cost less without the team.

A key not found indicates a wrong reference or missing context: fix the note before relaunching.

No automatic commits.
