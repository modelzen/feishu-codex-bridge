import { UPSTREAM_BRIDGE_VERSION } from './runtime-context';

/**
 * The exact upstream version represented by this vendored compatibility
 * snapshot. Keeping it with the recorded upstream identity makes the value
 * available after the kernel is bundled into a CJS desktop executable where
 * neither package.json nor import.meta.url exists as a normal filesystem path.
 */
export function bridgeVersion(): string {
  return UPSTREAM_BRIDGE_VERSION;
}
