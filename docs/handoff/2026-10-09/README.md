# Local source snapshots

These patches preserve historical local source for development on another device.
They do not change the current application or Core runtime.
The original worktrees remain untouched.

Use `codex/device-handoff` to continue current development. Its source baseline is
`codex/m1-desktop-capabilities`. The patches are recovery material, not approved changes to apply
to the current development branch.

`manifest.json` records each patch digest, original base commit, remote base branch,
result tree, and changed files. Each patch was replayed against its original base
in a temporary Git index. The resulting tree matched the captured source tree.
This check establishes recovery fidelity. It does not establish that an old draft
builds, passes tests, or remains suitable for the current product.

To recover one draft, copy its patch outside the checkout. Fetch its `baseRef` from
the manifest and create a separate worktree from that ref. Run `git apply --check`
on the copied patch, then run `git apply` in that recovery worktree. Review and test
the recovered source before moving any change into current development.

The snapshots include changed tracked source and named untracked source files.
Dependencies, build output, audit logs, document drafts, configuration, and account
credentials are not part of this archive.
