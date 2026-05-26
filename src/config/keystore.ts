import { createCipheriv, createDecipheriv, pbkdf2Sync, randomBytes } from 'node:crypto';
import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { hostname, userInfo } from 'node:os';
import { dirname } from 'node:path';
import { paths } from './paths';

/**
 * Local AES-256-GCM keystore for App Secrets and similar.
 *
 *   ~/.feishu-codex-bridge/secrets.enc      — JSON map { id → encrypted envelope }
 *   ~/.feishu-codex-bridge/.keystore.salt   — 32 random bytes, generated once
 *
 * Both chmod 0600. Key derived (PBKDF2-SHA256, 100k) from
 * `hostname + username + salt`. Defense-in-depth against accidental
 * disclosure (backups, git, log dumps) — not against a same-user process.
 */

const KEY_LEN = 32;
const IV_LEN = 12;
const TAG_LEN = 16;
const PBKDF2_ITER = 100_000;
const FILE_VERSION = 1;

interface Envelope {
  iv: string;
  data: string;
  tag: string;
}

interface StoreFile {
  version: number;
  entries: Record<string, Envelope>;
}

const EMPTY: StoreFile = { version: FILE_VERSION, entries: {} };

async function readStore(): Promise<StoreFile> {
  try {
    const text = await readFile(paths.secretsFile, 'utf8');
    const parsed = JSON.parse(text) as Partial<StoreFile>;
    if (parsed?.version !== FILE_VERSION || !parsed.entries) return { ...EMPTY };
    return { version: parsed.version, entries: { ...parsed.entries } };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { ...EMPTY };
    throw err;
  }
}

async function writeStore(store: StoreFile): Promise<void> {
  await mkdir(dirname(paths.secretsFile), { recursive: true });
  const tmp = `${paths.secretsFile}.tmp-${process.pid}`;
  await writeFile(tmp, `${JSON.stringify(store, null, 2)}\n`, 'utf8');
  await chmod(tmp, 0o600);
  await rename(tmp, paths.secretsFile);
}

async function loadOrCreateSalt(): Promise<Buffer> {
  try {
    const buf = await readFile(paths.keystoreSaltFile);
    if (buf.length === KEY_LEN) return buf;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
  const salt = randomBytes(KEY_LEN);
  await mkdir(dirname(paths.keystoreSaltFile), { recursive: true });
  const tmp = `${paths.keystoreSaltFile}.tmp-${process.pid}`;
  await writeFile(tmp, salt);
  await chmod(tmp, 0o600);
  await rename(tmp, paths.keystoreSaltFile);
  return salt;
}

async function deriveKey(): Promise<Buffer> {
  const salt = await loadOrCreateSalt();
  const seed = `${hostname()}|${userInfo().username}`;
  return pbkdf2Sync(seed, salt, PBKDF2_ITER, KEY_LEN, 'sha256');
}

function encrypt(key: Buffer, plaintext: string): Envelope {
  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return { iv: iv.toString('base64'), data: enc.toString('base64'), tag: tag.toString('base64') };
}

function decrypt(key: Buffer, env: Envelope): string {
  const iv = Buffer.from(env.iv, 'base64');
  const data = Buffer.from(env.data, 'base64');
  const tag = Buffer.from(env.tag, 'base64');
  if (iv.length !== IV_LEN) throw new Error('invalid IV length');
  if (tag.length !== TAG_LEN) throw new Error('invalid auth tag length');
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  const dec = Buffer.concat([decipher.update(data), decipher.final()]);
  return dec.toString('utf8');
}

export async function getSecret(id: string): Promise<string | undefined> {
  const store = await readStore();
  const env = store.entries[id];
  if (!env) return undefined;
  const key = await deriveKey();
  return decrypt(key, env);
}

export async function setSecret(id: string, plaintext: string): Promise<void> {
  const key = await deriveKey();
  const env = encrypt(key, plaintext);
  const store = await readStore();
  store.entries[id] = env;
  await writeStore(store);
}

export async function removeSecret(id: string): Promise<boolean> {
  const store = await readStore();
  if (!(id in store.entries)) return false;
  delete store.entries[id];
  await writeStore(store);
  return true;
}

export async function listSecretIds(): Promise<string[]> {
  const store = await readStore();
  return Object.keys(store.entries);
}
