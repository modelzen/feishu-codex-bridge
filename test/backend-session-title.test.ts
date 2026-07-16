import { describe, expect, it, vi } from 'vitest';
import type {
  ModelInfo as ClaudeSdkModelInfo,
  Query,
  SDKMessage,
  SDKSessionInfo,
} from '@anthropic-ai/claude-agent-sdk';
import {
  ClaudeAgentBackend,
  type ClaudeSdkFacade,
} from '../src/agent/claude-agent/backend';
import {
  CodexAppServerBackend,
  type CodexTitleBackendDeps,
  type CodexTitleClient,
} from '../src/agent/codex-appserver/backend';
import type { ServerNotification } from '../src/agent/codex-appserver/protocol';

function asyncQuery(
  messages: SDKMessage[],
  models: ClaudeSdkModelInfo[] = [],
): Query & { close: ReturnType<typeof vi.fn>; supportedModels: ReturnType<typeof vi.fn> } {
  const generator = (async function* () {
    for (const message of messages) yield message;
  })() as Query & { close: ReturnType<typeof vi.fn>; supportedModels: ReturnType<typeof vi.fn> };
  generator.close = vi.fn();
  generator.supportedModels = vi.fn(async () => models);
  return generator;
}

function successResult(title: string): SDKMessage {
  return {
    type: 'result',
    subtype: 'success',
    structured_output: { title },
    result: JSON.stringify({ title }),
  } as SDKMessage;
}

describe('Codex backend native session titles', () => {
  it('reads/sets the native name and generates via one isolated structured-output turn', async () => {
    const notifications = [
      {
        method: 'turn/started',
        params: { threadId: 'title-thread', turn: { id: 'turn-1' } },
      },
      {
        method: 'item/completed',
        params: {
          threadId: 'title-thread',
          turnId: 'turn-1',
          item: { type: 'agentMessage', id: 'msg-1', text: '{"title":"修复登录超时"}' },
        },
      },
      {
        method: 'turn/completed',
        params: {
          threadId: 'title-thread',
          turn: { id: 'turn-1', status: 'completed', error: null },
        },
      },
    ] as unknown as ServerNotification[];
    const request = vi.fn(async (method: string) => {
      if (method === 'thread/start') return { thread: { id: 'title-thread' } };
      return {};
    });
    const close = vi.fn(async () => undefined);
    const client: CodexTitleClient = {
      connect: vi.fn(async () => undefined),
      request: request as CodexTitleClient['request'],
      stream: () => (async function* () { yield* notifications; })(),
      close,
    };
    let nativeName: string | null = ' 已有标题 ';
    const utility = vi.fn(async (method: string) => {
      if (method === 'thread/read') return { thread: { name: nativeName } };
      return {};
    });
    const deps: CodexTitleBackendDeps = {
      utilityRequest: utility as CodexTitleBackendDeps['utilityRequest'],
      resolveBin: (() => '/fake/codex') as CodexTitleBackendDeps['resolveBin'],
      createClient: vi.fn(() => client),
    };
    const backend = new CodexAppServerBackend(deps);

    await expect(backend.readSessionTitle('/repo', 'session-1')).resolves.toBe('已有标题');
    expect(utility).toHaveBeenCalledWith(
      'thread/read',
      { threadId: 'session-1', includeTurns: false },
      { timeoutMs: 20_000 },
    );
    nativeName = null;
    await expect(backend.readSessionTitle('/repo', 'session-1')).resolves.toBeUndefined();
    await backend.setSessionTitle('/repo', 'session-1', ' 新标题 ');
    expect(utility).toHaveBeenCalledWith(
      'thread/name/set',
      { threadId: 'session-1', name: '新标题' },
    );

    await expect(backend.generateSessionTitle({
      cwd: '/repo',
      prompt: '完整标题提示词',
      model: 'gpt-title-model',
      effort: 'low',
    })).resolves.toBe('修复登录超时');

    expect(request).toHaveBeenCalledWith('thread/start', expect.objectContaining({
      cwd: '/repo',
      model: 'gpt-title-model',
      ephemeral: true,
      sandbox: 'read-only',
      approvalPolicy: 'never',
      config: expect.objectContaining({ web_search: 'disabled' }),
    }));
    expect(request).toHaveBeenCalledWith('turn/start', expect.objectContaining({
      threadId: 'title-thread',
      model: 'gpt-title-model',
      effort: 'low',
      input: [{ type: 'text', text: '完整标题提示词', text_elements: [] }],
      outputSchema: expect.objectContaining({
        required: ['title'],
        properties: { title: { type: 'string', maxLength: 36 } },
      }),
    }));
    expect(close).toHaveBeenCalledOnce();
  });

  it('propagates title-turn errors and still closes the dedicated client', async () => {
    const close = vi.fn(async () => undefined);
    const client: CodexTitleClient = {
      connect: vi.fn(async () => undefined),
      request: vi.fn(async (method: string) =>
        method === 'thread/start' ? { thread: { id: 'title-thread' } } : {}) as CodexTitleClient['request'],
      stream: () => (async function* () {
        yield {
          method: 'error',
          params: { error: { message: 'model unavailable' }, willRetry: false },
        } as ServerNotification;
      })(),
      close,
    };
    const backend = new CodexAppServerBackend({
      utilityRequest: vi.fn() as unknown as CodexTitleBackendDeps['utilityRequest'],
      resolveBin: (() => '/fake/codex') as CodexTitleBackendDeps['resolveBin'],
      createClient: () => client,
    });

    await expect(backend.generateSessionTitle({
      cwd: '/repo', prompt: 'prompt', model: 'exact-model', effort: 'high',
    })).rejects.toThrow('model unavailable');
    expect(close).toHaveBeenCalledOnce();
  });
});

describe('Claude backend native session titles', () => {
  it('uses customTitle/renameSession and an ephemeral no-tools structured query', async () => {
    const modelQuery = asyncQuery([], [{
      value: 'claude-title-model',
      displayName: 'Claude Title',
      description: 'small and fast',
      supportsEffort: true,
      supportedEffortLevels: ['low', 'high'],
    }]);
    const titleQuery = asyncQuery([successResult('定位支付回调失败')]);
    const query = vi.fn()
      .mockReturnValueOnce(modelQuery)
      .mockReturnValueOnce(titleQuery);
    const renameSession = vi.fn(async () => undefined);
    const getSessionInfo = vi.fn(async (): Promise<SDKSessionInfo | undefined> => ({
      sessionId: 'session-1',
      summary: 'summary is not a title',
      customTitle: ' 原生标题 ',
      lastModified: 2,
    }));
    const sdk = {
      query,
      listSessions: vi.fn(async () => []),
      getSessionInfo,
      getSessionMessages: vi.fn(async () => []),
      renameSession,
    } as unknown as ClaudeSdkFacade;
    const backend = new ClaudeAgentBackend(async () => sdk);

    const models = await backend.listModels();
    expect(models).toEqual([expect.objectContaining({
      id: 'claude-title-model',
      supportedEfforts: ['low', 'high'],
      isDefault: true,
    })]);
    await expect(backend.listModels()).resolves.toEqual(models);
    expect(query).toHaveBeenCalledOnce(); // successful discovery is cached
    expect(modelQuery.close).toHaveBeenCalledOnce();

    await expect(backend.readSessionTitle('/repo', 'session-1')).resolves.toBe('原生标题');
    getSessionInfo.mockResolvedValueOnce({
      sessionId: 'session-1',
      summary: '只有摘要和首条消息，不能当作 customTitle',
      firstPrompt: '首条消息',
      customTitle: undefined,
      lastModified: 3,
    });
    await expect(backend.readSessionTitle('/repo', 'session-1')).resolves.toBeUndefined();
    await backend.setSessionTitle('/repo', 'session-1', ' 新原生标题 ');
    expect(renameSession).toHaveBeenCalledWith('session-1', '新原生标题', { dir: '/repo' });

    await expect(backend.generateSessionTitle({
      cwd: '/repo',
      prompt: '完整标题提示词',
      model: 'claude-title-model',
      effort: 'xhigh',
    })).resolves.toBe('定位支付回调失败');

    const titleCall = query.mock.calls[1]![0];
    expect(titleCall.prompt).toBe('完整标题提示词');
    expect(titleCall.options).toEqual(expect.objectContaining({
      cwd: '/repo',
      model: 'claude-title-model',
      effort: 'xhigh',
      persistSession: false,
      maxTurns: 1,
      tools: [],
      skills: [],
      mcpServers: {},
      settingSources: [],
      outputFormat: {
        type: 'json_schema',
        schema: expect.objectContaining({ required: ['title'] }),
      },
    }));
    expect(titleQuery.close).toHaveBeenCalledOnce();
  });

  it('falls back to the static catalog only when SDK discovery fails', async () => {
    const failed = asyncQuery([]);
    failed.supportedModels.mockRejectedValue(new Error('SDK init failed'));
    const recovered = asyncQuery([], [{
      value: 'claude-recovered',
      displayName: 'Recovered',
      description: '',
      supportedEffortLevels: ['low'],
    }]);
    const query = vi.fn()
      .mockReturnValueOnce(failed)
      .mockReturnValueOnce(recovered);
    const sdk = {
      query,
      listSessions: vi.fn(),
      getSessionInfo: vi.fn(),
      getSessionMessages: vi.fn(),
      renameSession: vi.fn(),
    } as unknown as ClaudeSdkFacade;
    const backend = new ClaudeAgentBackend(async () => sdk);

    const models = await backend.listModels();
    expect(models.length).toBeGreaterThan(0);
    expect(models[0]!.id).toMatch(/^claude-/);
    expect(failed.close).toHaveBeenCalledOnce();

    // Failure fallback is not cached: the next call retries and then caches the
    // successful live catalog instead of pinning the process to stale statics.
    await expect(backend.listModels()).resolves.toEqual([
      expect.objectContaining({ id: 'claude-recovered' }),
    ]);
    await backend.listModels();
    expect(query).toHaveBeenCalledTimes(2);
    expect(recovered.close).toHaveBeenCalledOnce();
  });
});
