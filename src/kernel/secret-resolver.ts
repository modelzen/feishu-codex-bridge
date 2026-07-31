/**
 * Narrow desktop migration seam over the exact upstream secret resolver.
 * Keeping this adapter separate leaves the vendored implementation unchanged.
 */
export { resolveAppSecret } from '../config/secret-resolver.js';
export type { AppConfig } from '../config/schema.js';
