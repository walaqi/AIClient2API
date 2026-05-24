# Git Hooks

Repo-local git hooks. Activate once per clone:

```bash
chmod +x .githooks/pre-commit
git config core.hooksPath .githooks
```

## `pre-commit`

Auto-increments the last segment of the version (`vX.Y.Z.W` → `vX.Y.Z.W+1`) in
`VERSION` and `package.json`, then stages those files into the in-progress
commit. `VERSION` is the source of truth.

### Skipped automatically when

- A merge, rebase, or cherry-pick is in progress
- The commit is a `--amend` (detected via `/proc/$PPID/cmdline`)
- All staged files match `*.md` (pure docs change)

### Skip manually

```bash
NO_BUMP=1 git commit -m "..."
```

### Caveats

- `git commit <pathspec>` uses a temporary index; the hook's `git add` of the
  bumped files won't make it into that commit. Stage normally or use
  `NO_BUMP=1` and bump by hand.
- Detection relies on `/proc/$PPID/cmdline` (Linux/WSL). On macOS the amend
  guard becomes a no-op; use `NO_BUMP=1` if needed.
