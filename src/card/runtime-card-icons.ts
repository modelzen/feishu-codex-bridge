export const RUNTIME_TERMINAL_ICON = 'computer_outlined';

interface IconClient {
  readonly im?: { readonly v1?: { readonly image?: { create(input: unknown): Promise<unknown> } } };
}

// Embedded 64px transparent terminal icon from VonVon; no runtime asset path needed.
const TERMINAL_PNG = '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';
const terminalKeys = new WeakMap<object, { pending: Promise<string | undefined>; retryAt: number }>();

export async function serializeRuntimeCard(card: object, client: IconClient): Promise<string> {
  const raw = JSON.stringify(card);
  if (!raw.includes(RUNTIME_TERMINAL_ICON) || !client.im?.v1?.image) return raw;
  let entry = terminalKeys.get(client);
  if (!entry || Date.now() >= entry.retryAt) {
    entry = { pending: uploadTerminal(client), retryAt: Infinity };
    terminalKeys.set(client, entry);
    const attempt = entry;
    void attempt.pending.then(key => { if (!key) attempt.retryAt = Date.now() + 60_000; });
  }
  const key = await entry.pending;
  if (!key) return raw;
  // Use the captured frame even when callers mutate their state during upload.
  return JSON.stringify(JSON.parse(raw), (_name, value: unknown) => {
    if (typeof value === 'object' && value !== null && 'tag' in value && 'token' in value
      && value.tag === 'standard_icon' && value.token === RUNTIME_TERMINAL_ICON) {
      return { tag: 'custom_icon', img_key: key };
    }
    return value;
  });
}

async function uploadTerminal(client: IconClient): Promise<string | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const response: unknown = await Promise.race([
      client.im!.v1!.image!.create({ data: { image_type: 'message', image: Buffer.from(TERMINAL_PNG, 'base64') } }),
      new Promise<undefined>((resolve) => {
        timer = setTimeout(() => resolve(undefined), 3_000);
        timer.unref();
      }),
    ]);
    if (typeof response !== 'object' || response === null) return undefined;
    if ('code' in response && response.code !== undefined && response.code !== 0) return undefined;
    const data = 'data' in response ? response.data : response;
    return typeof data === 'object' && data !== null && 'image_key' in data
      && typeof data.image_key === 'string' && data.image_key !== '' ? data.image_key : undefined;
  } catch {
    return undefined;
  } finally {
    if (timer) clearTimeout(timer);
  }
}
