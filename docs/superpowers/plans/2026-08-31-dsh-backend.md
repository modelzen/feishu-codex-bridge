# DeepSeek Harness Backend Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:executing-plans` to implement this plan task-by-task.

**Goal:** Add an opt-in DeepSeek Harness backend that can be installed from the Bridge admin surface, stream multi-provider DSH sessions into Feishu, and safely resume the same persisted DSH session after process restart.

**Architecture:** Register a full-only `dsh-sdk` backend in the existing catalog and lazy registry. Install an exact `0.1.1-rc.2` DSH package set into the Bridge private backend directory, generate a secret-free Cordis profile, and run one detached `dsh-jsonrpc-agent` process per live Bridge thread. A small newline-delimited JSON-RPC transport owns request correlation and process-group cleanup; a stateful mapper converts DSH session events into the existing `AgentEvent` stream without replaying committed text.

**Tech Stack:** TypeScript, Node.js child processes and streams, DSH SDK JSON-RPC 2.0 over stdio, Cordis YAML, Vitest.

**Spec:** [`docs/design/dsh-backend-design.md`](../../design/dsh-backend-design.md)

## Global Constraints

- Keep Codex and Claude behavior unchanged; DSH is visible but never the default.
- Pin every directly used DSH package to `0.1.1-rc.2`; do not use floating prerelease tags.
- Accept only Bridge `full` mode and fail before spawning for `qa` or `write`.
- Expose only native tools, set approval policy to `never`, disable workspace pre-scan, skills, background jobs, Code/PTC, telemetry, and network listeners.
- Never read, copy, log, or persist provider key values. DSH resolves credential references from the inherited environment and `$DSH_HOME/.credentials.yaml`.
- Spawn the JSON-RPC runtime detached and always use `killProcessGroup` for abort, failed startup, protocol failure, and shutdown timeout.
- Reject images before `session/prompt`; do not silently discard them.
- Keep one active run per DSH thread and filter every notification by `sessionId`.
- Do not parse or mutate DSH JSONL persistence files.

---

### Task 1: Add atomic multi-package backend installation

**Files:**
- Modify: `src/agent/catalog.ts`
- Modify: `src/agent/installer.ts`
- Modify: `src/admin/service.ts`
- Modify: `test/backend-catalog.test.ts`
- Modify: `test/backend-install-api.test.ts`

**Step 1: Write failing catalog and installer tests**

Add coverage proving:

```ts
expect(buildInstallCommand(['a@1', 'b@1'], opts).args.slice(0, 3))
  .toEqual(['install', 'a@1', 'b@1']);
```

Extend the admin API mock assertions so a bundled backend passes the whole package list and `dsh-jsonrpc-agent` verification name to the installer, while existing single-package calls remain unchanged.

**Step 2: Run the narrow tests and observe the expected failure**

Run: `npx vitest run test/backend-catalog.test.ts test/backend-install-api.test.ts`

Expected: failures because `installSpecs` and array install commands do not exist.

**Step 3: Implement the smallest compatible installer extension**

Add to `BackendDep`:

```ts
installSpecs?: readonly string[];
```

Change `buildInstallCommand`, `installBackendDep`, and `uninstallBackendDep` to accept `string | readonly string[]`. Normalize immediately to an array, verify every package plus the declared bin, and roll back every direct package on failure. Preserve existing behavior for a single string.

Teach `AdminService` to use `entry.dep.installSpecs ?? [entry.dep.pkg@version]` and to uninstall the same declared set. For an explicit update, replace each exact spec with the requested common version/tag while retaining package names.

**Step 4: Re-run the narrow tests**

Run: `npx vitest run test/backend-catalog.test.ts test/backend-install-api.test.ts`

Expected: pass.

**Step 5: Commit**

```bash
git add src/agent/catalog.ts src/agent/installer.ts src/admin/service.ts test/backend-catalog.test.ts test/backend-install-api.test.ts
git commit -m "feat(agent): support bundled backend installs"
```

---

### Task 2: Define DSH metadata, models, and generated profile

**Files:**
- Create: `src/agent/dsh/constants.ts`
- Create: `src/agent/dsh/models.ts`
- Create: `src/agent/dsh/profile.ts`
- Create: `test/dsh-profile.test.ts`
- Modify: `src/config/paths.ts`

**Step 1: Write failing model and profile tests**

Assert the exact package set, model IDs, per-model effort lists, one default model, and generated profile invariants:

```ts
expect(DSH_MODELS.find((m) => m.id === 'minimax/MiniMax-M3')?.supportedEfforts)
  .toEqual(['none', 'high']);
expect(profile).toContain("name: '@deepseek-ai/dsh-sdk-jsonrpc-server'");
expect(profile).toContain("name: '@deepseek-ai/dsh-llm-pi-ai'");
expect(profile).toContain("policy: never");
expect(profile).not.toMatch(/run_code|code-mode|DSH_TOOLS_MODE:\s*code/i);
expect(profile).not.toMatch(/[A-Za-z0-9_-]{20,}\.(?:key|token)/i);
```

Also assert all plugins referenced by the profile appear in the exact package set directly or are guaranteed by the pinned `@deepseek-ai/dsh` bundle.

**Step 2: Run the profile test and observe the expected import failure**

Run: `npx vitest run test/dsh-profile.test.ts`

Expected: failure because the DSH modules do not exist.

**Step 3: Implement constants and model routing**

Define `DSH_VERSION = '0.1.1-rc.2'`, `DSH_BIN_NAME = 'dsh-jsonrpc-agent'`, and exact specs for the DSH bundle, JSON-RPC demo/server, agent spine, and pi-ai adapter. Define the eight reviewed model routes and map Bridge effort IDs to pi-ai profile levels (`none -> off`; supported non-off levels remain unchanged).

**Step 4: Implement a deterministic secret-free Cordis profile**

The profile must mount:

- SDK JSON-RPC server
- local credentials provider
- `dsh-llm-pi-ai` routes for Moonshot China, Z.AI Coding China, MiniMax, and DeepSeek
- local sandbox provider and `danger-full-access` policy rooted at `DSH_CWD`
- subprocess runtime, sandboxed bash, and approval policy `never`
- agent spine with Bridge instructions, no workspace context, no skills, no background jobs
- sandboxed filesystem, observation policy, native filesystem and todo tools
- JSONL persistence, checkpoint policy, token meter, and basic compaction

Write the profile only when content differs. Add per-bot `dshSessionsDir` and shared generated profile paths under existing Bridge state roots.

**Step 5: Re-run profile tests**

Run: `npx vitest run test/dsh-profile.test.ts`

Expected: pass.

**Step 6: Commit**

```bash
git add src/agent/dsh/constants.ts src/agent/dsh/models.ts src/agent/dsh/profile.ts src/config/paths.ts test/dsh-profile.test.ts
git commit -m "feat(dsh): define runtime profile and models"
```

---

### Task 3: Build the process-safe JSON-RPC transport

**Files:**
- Create: `src/agent/dsh/protocol.ts`
- Create: `src/agent/dsh/transport.ts`
- Create: `test/fixtures/fake-dsh-agent.mjs`
- Create: `test/dsh-transport.test.ts`

**Step 1: Create a deterministic fake DSH runtime**

The fixture accepts line-delimited `initialize`, `session/prompt`, and `shutdown` requests. Environment switches make it emit an early event, malformed JSON, a JSON-RPC error, a delayed response, or an unexpected exit. It records only non-secret request metadata to an optional observation file.

**Step 2: Write failing transport tests**

Cover request correlation, notifications arriving before a prompt response, foreign-session filtering at the consumer boundary, malformed stdout, bounded stderr, exit rejection, graceful shutdown, and forceful process-group cleanup through an injected kill function.

**Step 3: Run the transport tests and observe the expected import failure**

Run: `npx vitest run test/dsh-transport.test.ts`

Expected: failure because `DshJsonRpcTransport` does not exist.

**Step 4: Implement the transport**

Provide this narrow API:

```ts
class DshJsonRpcTransport {
  static spawn(options: DshTransportOptions): DshJsonRpcTransport;
  request<T>(method: DshRequestMethod, params?: unknown, timeoutMs?: number): Promise<T>;
  notifications(): AsyncIterable<DshNotification>;
  lastActivity(): number;
  isAlive(): boolean;
  close(): Promise<void>;
  terminate(): Promise<void>;
}
```

Use `spawnProcess(..., { detached: true, stdio: ['pipe', 'pipe', 'pipe'] })`, parse stdout by complete lines, cap buffered line/stderr sizes, correlate monotonically increasing numeric IDs, refresh activity for every frame, reject all pending requests on protocol/process failure, and call `killProcessGroup` for forced cleanup.

**Step 5: Re-run the transport tests**

Run: `npx vitest run test/dsh-transport.test.ts`

Expected: pass.

**Step 6: Commit**

```bash
git add src/agent/dsh/protocol.ts src/agent/dsh/transport.ts test/fixtures/fake-dsh-agent.mjs test/dsh-transport.test.ts
git commit -m "feat(dsh): add JSON-RPC process transport"
```

---

### Task 4: Normalize DSH session events without duplication

**Files:**
- Create: `src/agent/dsh/event-map.ts`
- Create: `test/dsh-event-map.test.ts`

**Step 1: Write failing mapper tests from rc.2 wire fixtures**

Cover:

- `turn/start` to stable `turn_started`
- text and reasoning deltas with stable item IDs
- `tool/call` and `tool/result` with safe, bounded detail/output
- usage from streamed chunks with no duplicate committed-message usage
- committed `assistant/message` fallback only when its block had no streamed deltas
- failed/interrupted `turn/end` mapping
- unknown events ignored without throwing

**Step 2: Run the mapper test and observe the expected import failure**

Run: `npx vitest run test/dsh-event-map.test.ts`

Expected: failure because `DshEventMapper` does not exist.

**Step 3: Implement a per-run stateful mapper**

Track turn/step/block IDs, streamed content blocks, emitted usage keys, and tool calls. Accept unknown JSON structures defensively and never echo credential-shaped values from tool arguments or errors.

**Step 4: Re-run the mapper test**

Run: `npx vitest run test/dsh-event-map.test.ts`

Expected: pass.

**Step 5: Commit**

```bash
git add src/agent/dsh/event-map.ts test/dsh-event-map.test.ts
git commit -m "feat(dsh): map Harness streaming events"
```

---

### Task 5: Implement DSH thread and backend lifecycle

**Files:**
- Create: `src/agent/dsh/thread.ts`
- Create: `src/agent/dsh/backend.ts`
- Create: `src/agent/dsh/index.ts`
- Create: `test/dsh-backend.test.ts`
- Modify: `src/agent/catalog.ts`
- Modify: `src/agent/index.ts`

**Step 1: Write failing lifecycle tests against the fake runtime**

Prove:

- `startThread` creates a UUID and `resumeThread` preserves a supplied ID
- `full` starts, while `qa` and `write` fail before spawn
- initialize splits `<provider>/<model>` and preserves cwd
- two turns reuse the process and session ID
- model or effort changes restart the runtime but preserve session ID
- one active run is enforced
- images fail before prompt transmission
- abort makes the runtime dead and closes the current stream
- close is idempotent
- unsupported goal, steer, compact, and history methods match declared capabilities

**Step 2: Run the lifecycle test and observe the expected import/registry failures**

Run: `npx vitest run test/dsh-backend.test.ts test/backend-registry.test.ts`

Expected: failure because the backend and registry entry do not exist.

**Step 3: Implement the thread**

Create a runtime lazily on the first turn, call `initialize`, submit text as one DSH content block, map only notifications for this thread's `sessionId`, and finish after the matching `turn/end` plus idle status. Start event consumption before `session/prompt` to preserve early notifications. On abort/protocol failure, terminate the whole process group and leave the persistent session ID untouched.

**Step 4: Implement the backend**

Declare:

```ts
capabilities = { goal: false, steer: false, compact: false, resume: false, approvals: false };
supportedModes = ['full'] as const;
```

`doctor()` checks the exact main package version, executable, and generated profile without reading provider keys. `listModels()` returns the static reviewed catalog; list/history return empty values; unsupported thread operations throw explicit errors.

**Step 5: Add the catalog entry, register the lazy factory, and re-run lifecycle tests**

The catalog entry uses the exact `DSH_INSTALL_SPECS`, `dsh-jsonrpc-agent`, `access: 'jsonrpc'`, and `supportedModes: ['full']`. Add catalog and registry in the same step so the existing ID-set invariant never has a half-registered state.

Run: `npx vitest run test/dsh-backend.test.ts test/backend-registry.test.ts test/backend-catalog.test.ts`

Expected: pass.

**Step 6: Commit**

```bash
git add src/agent/dsh/thread.ts src/agent/dsh/backend.ts src/agent/dsh/index.ts src/agent/index.ts test/dsh-backend.test.ts test/backend-registry.test.ts test/backend-catalog.test.ts
git commit -m "feat(dsh): add Harness agent backend"
```

---

### Task 6: Validate the real package/profile boundary and document operations

**Files:**
- Create: `scripts/check-dsh-profile.mjs`
- Modify: `docs/design/dsh-backend-design.md`
- Modify: `docs/design/dsh-backend-research.md`
- Modify: `docs/DEVLOG.md`
- Modify: `README.md`

**Step 1: Add a keyless profile smoke harness**

The script accepts an installed backend directory, verifies exact package versions and the bin, writes the generated profile into a temporary state root, starts `dsh-jsonrpc-agent`, completes `initialize` without a model request, sends `shutdown`, and confirms no listener was opened. It must not inspect key values.

**Step 2: Run the smoke harness against the isolated npm probe**

Run: `node scripts/check-dsh-profile.mjs /tmp/dsh-bridge-probe-rc2`

Expected: exact `0.1.1-rc.2` package checks, initialize success, shutdown success.

**Step 3: Update documentation**

Record the final rc.2 ruling, multi-provider env names, full-only boundary, native-tools-only posture, persistence location, install/doctor behavior, and the fact that DSH remains developer preview and non-default.

**Step 4: Run focused and full verification**

Run:

```bash
npx vitest run test/dsh-profile.test.ts test/dsh-transport.test.ts test/dsh-event-map.test.ts test/dsh-backend.test.ts test/backend-catalog.test.ts test/backend-install-api.test.ts
npm run typecheck
npm run build
npm test
git diff --check
```

Expected: all tests, typecheck, build, and whitespace checks pass. Existing audit findings remain unchanged and are not part of this feature.

**Step 5: Review, commit, push, and open a Draft PR**

```bash
git add scripts/check-dsh-profile.mjs docs/design/dsh-backend-design.md docs/design/dsh-backend-research.md docs/DEVLOG.md README.md
git commit -m "docs(dsh): document experimental backend"
git push -u wetlink codex/add-dsh-backend
gh pr create --repo modelzen/feishu-codex-bridge --base main --head wetlink:codex/add-dsh-backend --draft
```

The PR body must lead with user-visible behavior, list the exact safety boundary, summarize the protocol and package-version evidence, include the verification commands and results, and call out that no real provider key was used in CI.
