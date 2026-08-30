import { appendFileSync } from 'node:fs';

let buffer = '';

function send(frame) {
  process.stdout.write(`${JSON.stringify(frame)}\n`);
}

function record(frame) {
  if (!process.env.FAKE_DSH_OBSERVE) return;
  appendFileSync(
    process.env.FAKE_DSH_OBSERVE,
    `${JSON.stringify({ id: frame.id, method: frame.method, params: frame.params })}\n`,
  );
}

function result(id, value) {
  send({ jsonrpc: '2.0', id, result: value });
}

function notification(method, params) {
  send({ jsonrpc: '2.0', method, params });
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
    const sessionId = frame.params.sessionId;
    if (process.env.FAKE_DSH_FOREIGN === '1') {
      notification('session.event', {
        sessionId: 'foreign-session',
        event: { type: 'turn/start', seq: 0, time: 0, data: { turn: 99 } },
      });
    }
    notification('session.event', {
      sessionId,
      event: { type: 'turn/start', seq: 0, time: 0, data: { turn: 1 } },
    });
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
