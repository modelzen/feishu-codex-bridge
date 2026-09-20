# Conditional Luna context briefing

Each project's web settings, Feishu DM project settings card and group
`/settings` card expose **上下文策略（Luna 简报）**. The switch is saved as
`Project.contextBriefing` (default `true`). Turning it off keeps raw new messages
with sender names and IDs but never starts Luna for that project. Turning it on
restores the existing thresholds, subject to the global feature setting. Changes
apply when the next input is prepared, including queued inputs; no session is
evicted and no restart is needed. The existing authenticated admin write path is
used (`POST /api/project/:name/context-briefing`, body `{ "on": boolean }`).

`preferences.contextBriefing` enables current-group context for ordinary group
turns, including new topics, queued turns and steering. It does not change the
selected main model or the existing admin/guest session boundaries. Commands and
autonomous goal objectives are not summarized.

The gate is **(at least 800 characters AND at least 10 messages) OR at least
2000 characters** since the previous successfully accepted input in this session.
Count Unicode code points in message bodies, excluding whitespace and metadata;
include the current question. Below the gate, no Luna process is started. All
available new messages are sent verbatim with `user_name`, `user_id`, message ID,
sender type, timestamp and topic. The current question retains the existing
sender envelope, quotation and attachment handling.

The gate is evaluated before the 100-message model window is selected. A first
conversation uses the past 24 hours; an existing checkpoint also permits reading
an older gap to count and deliver its new messages. Initial model context keeps
the current question and prioritizes up to 29 messages from the current topic,
then fills the remaining slots with the newest group messages. Luna may request
up to three older-history reads (70, 70, 60 messages), always restricted by the
bridge to the same group. Existing SQLite archives are opened read-only and
searched with parameterized queries. Missing or partially expanded history is
identified in the supplied context.

```json
{
  "preferences": {
    "contextBriefing": {
      "enabled": true,
      "model": "gpt-5.6-luna",
      "timeoutMs": 30000,
      "archivePath": "/path/to/feishu.sqlite3",
      "pythonCommand": "python3"
    },
    "memoryContext": {
      "inject": false
    }
  }
}
```

Merge this into the existing configuration; preserve `memoryContext.command`,
`args`, `syncArgs` and the sync interval. The optional archive adapter requires
Python 3. Without it, live group/topic reads still work. Luna uses the installed
Codex binary and existing file-based login, in a temporary home without user
plugins, MCP servers or skills. It has no shell, browser or task-execution tools.
Unsupported login/model configurations fall back to raw context, never another
model. Reasoning effort is `low` and at most two auxiliary models run at once.

Preparation is limited to 30 seconds. On timeout, invalid citations, model errors
or capacity exhaustion, the latest valid partial briefing or recent raw excerpts
are used and the limitation is marked. Missing current-group context never
reenables global/cross-chat memory injection. Setting `enabled: false` keeps the
current-group raw-history path and disables Luna; background archiving continues.

Checkpoints live next to the bot's sessions file as `sessions.json.context.json`.
They contain timestamps, IDs and host-session identity, not message bodies. They
advance on host `turn_started` or successful steering, not when preparation ends
or a message is queued. Same-time messages are distinguished by ID and observed
receive order. Preparation/delivery is ordered per session; other sessions are
independent. Clear, stop and shutdown cancel pending preparation generations.

`intake.context-briefing` logs mode, body character/message counts, lookup rounds,
elapsed time and gap count without logging briefing contents. Tests cover gate
boundaries, checkpoint persistence/failure, references, scope, ordering and late
cancellation. Optional live tests:

```sh
BRIEFING_LIVE=1 npx vitest run test/briefing-live.test.ts
BRIEFING_HISTORY_CONFIG=/path/to/config.json \
BRIEFING_HISTORY_CHAT=oc_example \
npx vitest run test/briefing-live.test.ts
```

The live history test only reads; it does not send messages. `BRIEFING_HISTORY_DAYS`
changes its probe window only, not production defaults.

### Project model and Fast

Project settings expose `contextBriefing` (enabled), `contextBriefingModel` (default `gpt-5.6-luna`) and `contextBriefingFast` (default false). Group settings and the DM project card provide a model selector and Fast switch; Web accepts a model ID and has the same switches. Partial writes preserve all other options. These settings also control Discuss's continuous message summary independently of its reply judge. Disabling summary keeps raw history available.

When `contextBriefing.enabled` is explicitly `false`, separately configured `memoryContext` injection remains enabled unless its own `inject` flag is false. Background memory sync has an independent `syncTimeoutMs` (default 60 seconds, range 100 ms–10 minutes). A timed-out child is killed and logged; the next interval retries after the child closes.
