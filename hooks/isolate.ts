import type { EngineInterface } from 'claude-code'

type Engine = Pick<EngineInterface, 'process'>

const GIT_TIMEOUT_MS = 120_000

async function sh($: Engine, script: string, args: readonly string[]): Promise<{ ok: boolean; out: string }> {
  const ran = await $.process
    .run(['sh', '-c', script, 'junior-team', ...args], { timeoutMs: GIT_TIMEOUT_MS })
    .catch((error: unknown) => ({ exitCode: -1, stdout: '', stderr: String(error) }))

  return { ok: ran.exitCode === 0, out: `${ran.stdout}\n${ran.stderr}`.trim() }
}

// The worktree starts from the current state, not from the last commit: `git stash create` snapshots the modified tracked files
// without touching the folder or the history, and the new untracked files (the skeleton) are copied.
// Dependencies (vendor, node_modules, venv) and .env files are linked: nothing to reinstall.
const OPEN = `
set -e
root="$1"; dir="$2"
base=$(git -C "$root" stash create); [ -n "$base" ] || base=HEAD
mkdir -p "$(dirname "$dir")"
git -C "$root" worktree add --detach "$dir" "$base" >/dev/null
cd "$root"
git ls-files --others --exclude-standard -z | rsync -a --from0 --files-from=- ./ "$dir"/
find . -maxdepth 3 \\( -name .git -prune \\) -o \\( -type d \\( -name vendor -o -name node_modules -o -name .venv -o -name venv \\) -prune -print \\) -o \\( -name '.env' -type f -print \\) |
while read -r dep; do rel=\${dep#./}; [ -e "$dir/$rel" ] || { mkdir -p "$(dirname "$dir/$rel")" && ln -s "$root/$rel" "$dir/$rel"; } || true; done
`

// The scopes are disjoint: only the unit's files return to the main folder, without git merges.
const COPY = `
root="$1"; dir="$2"; shift 2
for rel in "$@"; do
  if [ -d "$dir/$rel" ]; then mkdir -p "$root/$rel" && rsync -a "$dir/$rel/" "$root/$rel/"
  elif [ -e "$dir/$rel" ]; then mkdir -p "$(dirname "$root/$rel")" && cp -p "$dir/$rel" "$root/$rel"; fi
done
`

const REMOVE = `
git -C "$1" worktree remove --force "$2" >/dev/null 2>&1 || rm -rf "$2"
git -C "$1" worktree prune
`

export async function worktreeDir($: Engine, root: string, unit: string): Promise<string | undefined> {
  const common = await sh($, 'cd "$1" && git rev-parse --path-format=absolute --git-common-dir', [root])

  return common.ok ? `${common.out.split('\n')[0]}/junior-team-wt/${unit}` : undefined
}

export async function openWorktree($: Engine, root: string, dir: string): Promise<string | undefined> {
  const opened = await sh($, OPEN, [root, dir])

  return opened.ok ? undefined : opened.out.slice(-400)
}

// After each successful test run the unit's code returns to the main folder: verify and the units after it see it.
export async function syncWorktree($: Engine, root: string, dir: string, paths: readonly string[]): Promise<void> {
  const rels = paths.filter(path => path.startsWith(`${root}/`)).map(path => path.slice(root.length + 1))
  await sh($, COPY, [root, dir, ...rels])
}

export async function closeWorktree($: Engine, root: string, dir: string, paths: readonly string[]): Promise<void> {
  await syncWorktree($, root, dir, paths)
  await sh($, REMOVE, [root, dir])
}

// An isolated junior uses the project's paths: the mod carries them into its worktree, and the reverse for the scope.
export const intoWorktree = (path: string, root: string, dir: string): string =>
  path.startsWith(`${root}/`) && !path.startsWith(`${dir}/`) ? `${dir}${path.slice(root.length)}` : path

export const outOfWorktree = (path: string, root: string, dir: string): string =>
  path.startsWith(`${dir}/`) ? `${root}${path.slice(dir.length)}` : path
