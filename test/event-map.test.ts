import { describe, expect, it } from 'vitest';
import { mapNotification } from '../src/agent/codex-appserver/event-map';
import type { ServerNotification, ThreadItem } from '../src/agent/codex-appserver/protocol';

function notification(method: string, params: unknown): ServerNotification {
  return { method, params } as ServerNotification;
}

function itemStarted(item: ThreadItem): ServerNotification {
  return { method: 'item/started', params: { item, threadId: 'thread-1', turnId: 'turn-1', startedAtMs: 1 } };
}

function itemCompleted(item: ThreadItem): ServerNotification {
  return { method: 'item/completed', params: { item, threadId: 'thread-1', turnId: 'turn-1', completedAtMs: 2 } };
}

describe('mapNotification', () => {
  it('maps thread and turn lifecycle notifications', () => {
    expect(mapNotification(notification('thread/started', { thread: { id: 'thread-1' } }))).toEqual({
      type: 'system',
      threadId: 'thread-1',
    });
    expect(mapNotification(notification('turn/started', { turn: { id: 'turn-1' } }))).toEqual({
      type: 'turn_started',
      turnId: 'turn-1',
    });
    expect(mapNotification(notification('turn/completed', { turn: { id: 'turn-1' } }))).toEqual({
      type: 'done',
      turnId: 'turn-1',
    });
    expect(
      mapNotification(notification('error', {
        error: { message: 'network failed' },
        willRetry: true,
        threadId: 'thread-1',
        turnId: 'turn-1',
      })),
    ).toEqual({ type: 'error', message: 'network failed', willRetry: true });
  });

  it('maps thread/goal/updated to goal_update and ignores thread/goal/cleared', () => {
    const goal = {
      threadId: 'thread-1',
      objective: 'migrate services/ to pydantic v2',
      status: 'usageLimited', // a runtime status NOT in the vendored 4-value enum
      tokenBudget: null,
      tokensUsed: 290497,
      timeUsedSeconds: 461,
      createdAt: 1,
      updatedAt: 2,
    };
    expect(
      mapNotification(notification('thread/goal/updated', { threadId: 'thread-1', turnId: null, goal })),
    ).toEqual({
      type: 'goal_update',
      status: 'usageLimited',
      objective: 'migrate services/ to pydantic v2',
      tokensUsed: 290497,
      timeUsedSeconds: 461,
      tokenBudget: null,
    });
    expect(mapNotification(notification('thread/goal/cleared', { threadId: 'thread-1' }))).toBeNull();
  });

  it('maps agent message deltas and completed text', () => {
    expect(
      mapNotification(notification('item/agentMessage/delta', {
        itemId: 'msg-1',
        delta: 'hello',
        threadId: 'thread-1',
        turnId: 'turn-1',
      })),
    ).toEqual({ type: 'text_delta', itemId: 'msg-1', delta: 'hello' });

    expect(mapNotification(itemCompleted({ type: 'agentMessage', id: 'msg-1', text: 'hello world' } as ThreadItem))).toEqual({
      type: 'text',
      itemId: 'msg-1',
      text: 'hello world',
    });
  });

  it('maps reasoning deltas and completed reasoning text', () => {
    expect(
      mapNotification(notification('item/reasoning/textDelta', {
        itemId: 'reason-1',
        delta: 'thinking',
        threadId: 'thread-1',
        turnId: 'turn-1',
      })),
    ).toEqual({ type: 'thinking_delta', itemId: 'reason-1', delta: 'thinking' });

    expect(
      mapNotification(
        itemCompleted({ type: 'reasoning', id: 'reason-1', content: ['step 1', 'step 2'], summary: [] } as ThreadItem),
      ),
    ).toEqual({ type: 'thinking', itemId: 'reason-1', text: 'step 1\nstep 2' });

    expect(
      mapNotification(itemCompleted({ type: 'reasoning', id: 'reason-2', content: [], summary: ['summary'] } as ThreadItem)),
    ).toEqual({ type: 'thinking', itemId: 'reason-2', text: 'summary' });
  });

  it('maps command execution start and completion', () => {
    expect(
      mapNotification(itemStarted({ type: 'commandExecution', id: 'cmd-1', command: 'npm test', cwd: '/repo' } as ThreadItem)),
    ).toEqual({ type: 'tool_use', itemId: 'cmd-1', title: 'npm test', detail: '/repo', kind: 'command' });

    expect(
      mapNotification(
        itemCompleted({
          type: 'commandExecution',
          id: 'cmd-1',
          aggregatedOutput: 'ok',
          exitCode: 0,
        } as ThreadItem),
      ),
    ).toEqual({ type: 'tool_result', itemId: 'cmd-1', output: 'ok', exitCode: 0 });

    expect(
      mapNotification(
        itemCompleted({ type: 'commandExecution', id: 'cmd-2', aggregatedOutput: null, exitCode: 1 } as ThreadItem),
      ),
    ).toEqual({ type: 'tool_result', itemId: 'cmd-2', output: undefined, exitCode: 1 });
  });

  it('maps fileChange to a titled diff tool (path + add/del counts, fenced diff output)', () => {
    const changes = [{ path: 'src/foo.ts', kind: 'update', diff: '@@ -1,2 +1,3 @@\n-old\n+new\n+more\n context' }];
    expect(mapNotification(itemStarted({ type: 'fileChange', id: 'file-1', changes } as unknown as ThreadItem))).toEqual({
      type: 'tool_use',
      itemId: 'file-1',
      title: '编辑 src/foo.ts (+2 −1)',
      kind: 'file',
    });
    expect(mapNotification(itemCompleted({ type: 'fileChange', id: 'file-1', changes } as unknown as ThreadItem))).toEqual({
      type: 'tool_result',
      itemId: 'file-1',
      output: '```diff\n@@ -1,2 +1,3 @@\n-old\n+new\n+more\n context\n```',
    });
  });

  // codex v0.139 协议（item_builders.rs format_file_change_diff）：add/delete 的
  // diff 字段是裸文件内容（无 +/- 前缀），只有 update 是 unified diff——按 kind 分流。
  it('add（新建文件）：标题「新建 path (+N)」，裸内容合成 + 前缀进 ```diff', () => {
    const changes = [{ path: '/proj/e2e-scratch.md', kind: { type: 'add' }, diff: 'hello world\n' }];
    expect(mapNotification(itemStarted({ type: 'fileChange', id: 'f-add', changes } as unknown as ThreadItem))).toEqual({
      type: 'tool_use',
      itemId: 'f-add',
      title: '新建 /proj/e2e-scratch.md (+1)',
      kind: 'file',
    });
    expect(mapNotification(itemCompleted({ type: 'fileChange', id: 'f-add', changes } as unknown as ThreadItem))).toEqual({
      type: 'tool_result',
      itemId: 'f-add',
      output: '```diff\n+hello world\n```',
    });
  });

  it('delete（删除文件）：标题「删除 path」不报行数，裸内容合成 - 前缀进 ```diff', () => {
    const changes = [{ path: 'old.md', kind: { type: 'delete' }, diff: 'line a\nline b\n' }];
    expect(mapNotification(itemStarted({ type: 'fileChange', id: 'f-del', changes } as unknown as ThreadItem))).toEqual({
      type: 'tool_use',
      itemId: 'f-del',
      title: '删除 old.md',
      kind: 'file',
    });
    expect(mapNotification(itemCompleted({ type: 'fileChange', id: 'f-del', changes } as unknown as ThreadItem))).toEqual({
      type: 'tool_result',
      itemId: 'f-del',
      output: '```diff\n-line a\n-line b\n```',
    });
  });

  it('新建空文件：(+0) 且无可渲染 diff（output undefined）', () => {
    const changes = [{ path: 'empty.md', kind: { type: 'add' }, diff: '' }];
    expect(mapNotification(itemStarted({ type: 'fileChange', id: 'f-empty', changes } as unknown as ThreadItem))).toEqual({
      type: 'tool_use',
      itemId: 'f-empty',
      title: '新建 empty.md (+0)',
      kind: 'file',
    });
    expect(mapNotification(itemCompleted({ type: 'fileChange', id: 'f-empty', changes } as unknown as ThreadItem))).toEqual({
      type: 'tool_result',
      itemId: 'f-empty',
      output: undefined,
    });
  });

  it('混合 add+update：动词回退「编辑」，行数按 kind 聚合（add 整文件算 +）', () => {
    const changes = [
      { path: 'new.md', kind: { type: 'add' }, diff: 'a\nb\n' },
      { path: 'mod.ts', kind: { type: 'update', move_path: null }, diff: '@@\n+x\n-y\n-z' },
    ];
    const evt = mapNotification(itemStarted({ type: 'fileChange', id: 'f-mix', changes } as unknown as ThreadItem));
    expect(evt).toEqual({ type: 'tool_use', itemId: 'f-mix', title: '编辑 new.md、mod.ts (+3 −2)', kind: 'file' });
  });

  it('带 cwd 上下文：项目内路径相对化，项目外保持绝对（看得出越界）', () => {
    const inside = [{ path: '/proj/src/a.ts', kind: { type: 'add' }, diff: 'x\n' }];
    expect(
      mapNotification(itemStarted({ type: 'fileChange', id: 'f-in', changes: inside } as unknown as ThreadItem), {
        cwd: '/proj',
      }),
    ).toEqual({ type: 'tool_use', itemId: 'f-in', title: '新建 src/a.ts (+1)', kind: 'file' });

    const outside = [{ path: '/etc/hosts', kind: { type: 'update', move_path: null }, diff: '+x' }];
    expect(
      mapNotification(itemStarted({ type: 'fileChange', id: 'f-out', changes: outside } as unknown as ThreadItem), {
        cwd: '/proj',
      }),
    ).toEqual({ type: 'tool_use', itemId: 'f-out', title: '编辑 /etc/hosts (+1 −0)', kind: 'file' });
  });

  it('无 cwd 时超长绝对路径只保留末段（…/ 前缀），控制标题单行长度', () => {
    const changes = [
      { path: '/Users/clay/devlop/src/ClayCheung/feishu-codex-bridge/e2e-scratch.md', kind: { type: 'add' }, diff: 'x\n' },
    ];
    const evt = mapNotification(itemStarted({ type: 'fileChange', id: 'f-long', changes } as unknown as ThreadItem));
    expect(evt).toEqual({ type: 'tool_use', itemId: 'f-long', title: '新建 …/feishu-codex-bridge/e2e-scratch.md (+1)', kind: 'file' });
  });

  it('lists the first files + a count for a multi-file fileChange, ignoring ---/+++ headers', () => {
    const changes = [
      { path: 'a.ts', kind: 'update', diff: '--- a/a.ts\n+++ b/a.ts\n+x' },
      { path: 'b.ts', kind: 'update', diff: '+y\n-z' },
      { path: 'c.ts', kind: 'update', diff: '+w' },
    ];
    const evt = mapNotification(itemStarted({ type: 'fileChange', id: 'file-2', changes } as unknown as ThreadItem));
    expect(evt).toEqual({ type: 'tool_use', itemId: 'file-2', title: '编辑 a.ts、b.ts 等 3 个文件 (+3 −1)', kind: 'file' });

    const done = mapNotification(itemCompleted({ type: 'fileChange', id: 'file-2', changes } as unknown as ThreadItem));
    const output = (done as { output: string }).output;
    // multi-file: each chunk keyed by a diff-native header, all in ONE ```diff fence
    expect(output.startsWith('```diff\n')).toBe(true);
    expect(output).toContain('diff --git a/a.ts b/a.ts');
    expect(output).toContain('diff --git a/c.ts b/c.ts');
    expect(output.endsWith('\n```')).toBe(true);
  });

  it('truncates an oversized fileChange diff but keeps the fence closed', () => {
    const changes = [{ path: 'big.ts', kind: 'update', diff: `+${'x'.repeat(5000)}` }];
    const evt = mapNotification(itemCompleted({ type: 'fileChange', id: 'file-3', changes } as unknown as ThreadItem));
    const output = (evt as { output: string }).output;
    expect(output.length).toBeLessThan(1400);
    expect(output).toContain('```diff\n');
    expect(output).toContain('已截断，完整 diff 5001 字符');
    // the fence is closed BEFORE the truncation note
    expect(output).toMatch(/```\n_（已截断/);
  });

  it('maps supported non-command tool items to tool events', () => {
    // fileChange without changes (defensive) → the old fixed label, no output
    expect(mapNotification(itemStarted({ type: 'fileChange', id: 'file-1' } as ThreadItem))).toEqual({
      type: 'tool_use',
      itemId: 'file-1',
      title: '编辑文件',
      kind: 'file',
    });
    expect(mapNotification(itemCompleted({ type: 'fileChange', id: 'file-1' } as ThreadItem))).toEqual({
      type: 'tool_result',
      itemId: 'file-1',
      output: undefined,
    });
    expect(mapNotification(itemStarted({ type: 'webSearch', id: 'search-1' } as ThreadItem))).toEqual({
      type: 'tool_use',
      itemId: 'search-1',
      title: '联网搜索',
      kind: 'search',
    });
    // with a query, surface it in the title so the search isn't a blank「联网搜索」
    expect(mapNotification(itemStarted({ type: 'webSearch', id: 'search-2', query: '飞书 2026 更新' } as ThreadItem))).toEqual({
      type: 'tool_use',
      itemId: 'search-2',
      title: '联网搜索：飞书 2026 更新',
      kind: 'search',
    });
  });

  it('preserves MCP identity, long arguments, textual and structured results', () => {
    const args = { query: '完整查询'.repeat(2000), limit: 10 };
    const started: ThreadItem = {
      type: 'mcpToolCall', id: 'mcp-1', server: 'exa', tool: 'web_search',
      status: 'inProgress', arguments: args, result: null, error: null, durationMs: null,
    };
    expect(mapNotification(itemStarted(started))).toEqual({
      type: 'tool_use', itemId: 'mcp-1', title: 'mcp__exa__web_search',
      detail: JSON.stringify(args, null, 2), kind: 'tool',
    });
    const result = {
      content: [{ type: 'text', text: '完整返回'.repeat(4000) }],
      structuredContent: { count: 0, nested: { complete: true } }, _meta: { source: 'exa' },
    };
    expect(mapNotification(itemCompleted({ ...started, status: 'completed', result, durationMs: 100 }))).toEqual({
      type: 'tool_result', itemId: 'mcp-1', output: JSON.stringify(result, null, 2), exitCode: undefined,
    });
    const error = { message: '服务错误'.repeat(3000) };
    expect(mapNotification(itemCompleted({ ...started, status: 'failed', result, error }))).toEqual({
      type: 'tool_result', itemId: 'mcp-1', output: JSON.stringify({ result, error }, null, 2), exitCode: 1,
    });
    const emptyResult = { content: [], structuredContent: null, _meta: null };
    expect(mapNotification(itemCompleted({ ...started, status: 'completed', result: emptyResult }))).toEqual({
      type: 'tool_result', itemId: 'mcp-1', output: JSON.stringify(emptyResult, null, 2), exitCode: undefined,
    });
    expect(mapNotification(itemCompleted({ ...started, status: 'failed' }))).toEqual({
      type: 'tool_result', itemId: 'mcp-1', output: undefined, exitCode: 1,
    });
  });

  it('preserves dynamic tool names, arguments, full output, and explicit failures', () => {
    const args = { cmd: 'echo 完整命令'.repeat(2000) };
    const started: ThreadItem = {
      type: 'dynamicToolCall', id: 'dyn-1', namespace: 'functions', tool: 'exec', arguments: args,
      status: 'inProgress', contentItems: null, success: null, durationMs: null,
    };
    expect(mapNotification(itemStarted(started))).toEqual({
      type: 'tool_use', itemId: 'dyn-1', title: 'functions.exec',
      detail: JSON.stringify(args, null, 2), kind: 'tool',
    });
    expect(mapNotification(itemStarted({ ...started, namespace: null }))).toMatchObject({ title: 'exec' });
    const output = '完整输出'.repeat(4000);
    expect(mapNotification(itemCompleted({
      ...started, status: 'completed', success: true, contentItems: [{ type: 'inputText', text: output }],
    }))).toEqual({ type: 'tool_result', itemId: 'dyn-1', output, exitCode: undefined });
    for (const failure of [
      { status: 'failed', success: null }, { status: 'completed', success: false },
    ] satisfies Array<Pick<typeof started, 'status' | 'success'>>) {
      expect(mapNotification(itemCompleted({
        ...started, ...failure, contentItems: [{ type: 'inputText', text: 'failure details' }],
      }))).toEqual({ type: 'tool_result', itemId: 'dyn-1', output: 'failure details', exitCode: 1 });
    }
    for (const contentItems of [[], [{ type: 'inputText', text: '' }]] satisfies Array<typeof started.contentItems>) {
      expect(mapNotification(itemCompleted({ ...started, status: 'completed', success: true, contentItems }))).toEqual({
        type: 'tool_result', itemId: 'dyn-1', output: '', exitCode: undefined,
      });
    }
    expect(mapNotification(itemCompleted({ ...started, status: 'completed', success: true }))).toEqual({
      type: 'tool_result', itemId: 'dyn-1', output: undefined, exitCode: undefined,
    });
  });

  it('maps token usage + compaction notifications', () => {
    // Reads `last` (current context occupancy), NOT `total` (cumulative). A high
    // cumulative total alongside a small last must surface the small one.
    expect(
      mapNotification(notification('thread/tokenUsage/updated', {
        threadId: 'thread-1',
        turnId: 'turn-1',
        tokenUsage: { total: { totalTokens: 999999 }, last: { totalTokens: 4096 }, modelContextWindow: 8192 },
      })),
    ).toEqual({ type: 'context_usage', usedTokens: 4096, contextWindow: 8192 });

    expect(
      mapNotification(notification('thread/tokenUsage/updated', {
        threadId: 'thread-1',
        turnId: 'turn-1',
        tokenUsage: { total: { totalTokens: 5000 }, last: { totalTokens: 100 }, modelContextWindow: null },
      })),
    ).toEqual({ type: 'context_usage', usedTokens: 100, contextWindow: null });

    expect(mapNotification(notification('thread/compacted', { threadId: 'thread-1' }))).toEqual({
      type: 'context_compacted',
    });
  });

  it('returns null for noisy or unsupported notifications', () => {
    for (const method of [
      'hook/started',
      'mcpServer/startupStatus/updated',
      'account/updated',
      'thread/status/changed',
    ]) {
      expect(mapNotification(notification(method, {}))).toBeNull();
    }
    expect(mapNotification(itemStarted({ type: 'userMessage', id: 'user-1' } as ThreadItem))).toBeNull();
  });
});
