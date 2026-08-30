import { appendFileSync } from 'node:fs';

let buffer = '';
let turn = 0;

function send(frame) {
  process.stdout.write(`${JSON.stringify(frame)}\n`);
}

function record(frame) {
  if (!process.env.FAKE_DSH_OBSERVE) return;
  appendFileSync(
    process.env.FAKE_DSH_OBSERVE,
    `${JSON.stringify({
      pid: process.pid,
      id: frame.id,
      method: frame.method,
      params: frame.params,
      runtime: {
        profile: process.env.DSH_CORDIS_CONFIG,
        cwd: process.env.DSH_CWD,
        sessionRoot: process.env.DSH_SESSION_ROOT,
        permission: process.env.DSH_PERMISSION_MODE,
        tools: process.env.DSH_TOOLS_MODE,
        telemetryDisabled: process.env.DSH_TELEMETRY_DISABLED,
        effort: process.env.FEISHU_CODEX_BRIDGE_DSH_EFFORT,
      },
    })}\n`,
  );
}

function result(id, value) {
  send({ jsonrpc: '2.0', id, result: value });
}

function notification(method, params) {
  send({ jsonrpc: '2.0', method, params });
}

function sessionEvent(sessionId, type, data) {
  notification('session.event', {
    sessionId,
    event: { type, seq: turn, time: 0, data },
  });
}

function fullTurn(sessionId) {
  const current = ++turn;
  const text = `hello from fake DSH ${current}`;
  sessionEvent(sessionId, 'turn/start', { turn: current });
  sessionEvent(sessionId, 'assistant/chunk', {
    turn: current,
    step: 0,
    chunk: { type: 'reasoning-delta', index: 0, text: 'thinking' },
  });
  sessionEvent(sessionId, 'assistant/chunk', {
    turn: current,
    step: 0,
    chunk: { type: 'text-delta', index: 1, text },
  });
  sessionEvent(sessionId, 'assistant/chunk', {
    turn: current,
    step: 0,
    chunk: { type: 'block-end', index: 0, block: { type: 'reasoning', text: 'thinking' } },
  });
  sessionEvent(sessionId, 'assistant/chunk', {
    turn: current,
    step: 0,
    chunk: { type: 'block-end', index: 1, block: { type: 'text', text } },
  });
  sessionEvent(sessionId, 'assistant/chunk', {
    turn: current,
    step: 0,
    chunk: { type: 'usage', usage: { inputTokens: 11, outputTokens: 7 } },
  });
  sessionEvent(sessionId, 'tool/call', {
    turn: current,
    step: 1,
    callId: `call-${current}`,
    name: 'bash',
    arguments: { command: 'printf ok' },
  });
  sessionEvent(sessionId, 'tool/result', {
    turn: current,
    step: 1,
    message: {
      source: { callId: `call-${current}` },
      content: [{ type: 'tool-result', toolCallId: `call-${current}`, content: [{ type: 'text', text: 'ok' }] }],
    },
  });
  // Reconciles the committed message. The mapper must not duplicate blocks or usage.
  sessionEvent(sessionId, 'assistant/message', {
    turn: current,
    step: 0,
    message: {
      id: `assistant-${current}`,
      role: 'assistant',
      content: [
        { type: 'reasoning', text: 'thinking' },
        { type: 'text', text },
      ],
    },
    usage: { inputTokens: 11, outputTokens: 7 },
  });
  sessionEvent(sessionId, 'turn/end', { turn: current, reason: { kind: 'completed' } });
}

function handle(frame) {
  record(frame);
  if (frame.method === 'initialize') {
    if (process.env.FAKE_DSH_STDERR_BYTES) {
      process.stderr.write('E'.repeat(Number(process.env.FAKE_DSH_STDERR_BYTES)));
    }
    if (process.env.FAKE_DSH_MALFORMED === '1') {
      process.stdout.write('this is not json\n');
      return;
    }
    if (process.env.FAKE_DSH_EXIT_ON_INIT === '1') {
      process.exit(23);
    }
    result(frame.id, {
      serverInfo: { name: 'deepseek-harness-sdk-runtime', version: 'fixture' },
    });
    return;
  }

  if (frame.method === 'session/prompt') {
    if (process.env.FAKE_DSH_RPC_ERROR === '1') {
      send({
        jsonrpc: '2.0',
        id: frame.id,
        error: { code: -32001, message: 'fixture rejected prompt' },
      });
      return;
    }
    if (process.env.FAKE_DSH_EXIT_ON_PROMPT === '1') {
      process.exit(24);
    }
    if (process.env.FAKE_DSH_HANG_PROMPT === '1') return;
    const sessionId = frame.params.sessionId;
    if (process.env.FAKE_DSH_FOREIGN === '1') {
      notification('session.event', {
        sessionId: 'foreign-session',
        event: { type: 'turn/start', seq: 0, time: 0, data: { turn: 99 } },
      });
    }
    if (process.env.FAKE_DSH_FULL_TURN === '1') {
      notification('session.status', { sessionId, status: 'running' });
      fullTurn(sessionId);
    } else {
      notification('session.event', {
        sessionId,
        event: { type: 'turn/start', seq: 0, time: 0, data: { turn: 1 } },
      });
    }
    result(frame.id, { messageId: `message-${frame.id}` });
    notification('session.status', { sessionId, status: 'idle' });
    return;
  }

  if (frame.method === 'shutdown') {
    if (process.env.FAKE_DSH_HANG_SHUTDOWN === '1') return;
    result(frame.id, {});
    setTimeout(() => process.exit(0), 5);
    return;
  }

  send({ jsonrpc: '2.0', id: frame.id, error: { code: -32601, message: 'method not found' } });
}

process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  let newline;
  while ((newline = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, newline).trim();
    buffer = buffer.slice(newline + 1);
    if (!line) continue;
    handle(JSON.parse(line));
  }
});
