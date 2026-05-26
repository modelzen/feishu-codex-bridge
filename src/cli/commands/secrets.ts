import { getSecret, setSecret, removeSecret, listSecretIds } from '../../config/keystore';

/**
 * `secrets get` — exec-provider endpoint. Reads a JSON-RPC-ish request from
 * stdin (`{ protocolVersion, provider, ids: [...] }`) and writes
 * `{ values: { id: secret }, errors: { id: { message } } }` to stdout.
 * Invoked by the secrets-getter wrapper (and lark-cli) to resolve secrets.
 */
export async function secretsGet(): Promise<void> {
  const input = await readStdin();
  let ids: string[] = [];
  try {
    const req = JSON.parse(input) as { ids?: string[] };
    ids = Array.isArray(req.ids) ? req.ids : [];
  } catch {
    process.stdout.write(JSON.stringify({ values: {}, errors: { _: { message: 'invalid request JSON' } } }));
    return;
  }
  const values: Record<string, string> = {};
  const errors: Record<string, { message: string }> = {};
  for (const id of ids) {
    try {
      const v = await getSecret(id);
      if (v !== undefined) values[id] = v;
      else errors[id] = { message: 'not found' };
    } catch (err) {
      errors[id] = { message: err instanceof Error ? err.message : String(err) };
    }
  }
  process.stdout.write(JSON.stringify({ values, errors }));
}

/** `secrets set <id>` — store a secret read from stdin (manual use). */
export async function secretsSet(id: string): Promise<void> {
  const value = (await readStdin()).trim();
  if (!value) {
    console.error('无输入：把密钥通过 stdin 传入，如 `echo <secret> | feishu-codex-bridge secrets set <id>`');
    process.exitCode = 1;
    return;
  }
  await setSecret(id, value);
  console.log(`✓ 已存储密钥: ${id}`);
}

/** `secrets list` / `secrets remove <id>` — manual maintenance. */
export async function secretsList(): Promise<void> {
  const ids = await listSecretIds();
  console.log(ids.length ? ids.join('\n') : '(空)');
}

export async function secretsRemove(id: string): Promise<void> {
  const ok = await removeSecret(id);
  console.log(ok ? `✓ 已删除: ${id}` : `未找到: ${id}`);
}

function readStdin(): Promise<string> {
  return new Promise((resolve) => {
    let data = '';
    if (process.stdin.isTTY) {
      resolve('');
      return;
    }
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (c) => (data += c));
    process.stdin.on('end', () => resolve(data));
  });
}
