import type { TenantBrand } from './schema';

/**
 * The app-identity scopes this bridge needs (design §9). Single source of
 * truth — keep in sync with the design doc's scope list.
 *
 * Feishu has **no API to declare app scopes**: the scan-create flow
 * (`registerApp`) takes no permission argument, and so does the official
 * larksuite/cli. The only way to grant them is the developer-console
 * "apply scope" page. So instead of baking scopes into the QR (impossible),
 * we point the user at one console URL that pre-selects *all* of these at
 * once — scan once, click once. See {@link buildScopeGrantUrl}.
 *
 * `drive:drive` (cloud-doc comments) is optional and intentionally omitted.
 */
export const REQUIRED_SCOPES = [
  // Feishu has split the old umbrella scopes (`im:chat`, `im:message`) into
  // fine-grained ones; new apps can only be granted the fine-grained names, so
  // we list those — not the umbrellas (which would be un-grantable + would make
  // the scope check false-positive).
  'im:message.group_at_msg:readonly', // @bot messages in project groups
  'im:message.group_msg', // ALL group messages (高敏感) — required for 免@ (respond without @)
  'im:message.p2p_msg:readonly', // DM console messages
  'im:message:send_as_bot', // reply_in_thread / send cards
  'im:resource', // upload images / resources
  'im:chat:create', // create the project group
  'im:chat:update', // transfer ownership on unbind
  'im:chat.announcement:read', // read group announcement blocks (list)
  'im:chat.announcement:write_only', // write group announcement blocks (create/delete)
  'im:chat.top_notice:write_only', // pin the announcement to the top banner
  'im:chat.tabs:write_only', // add the "👈 查看可使用的命令" chat tab on group create
  // Pin'ing the welcome message reuses im:message:send_as_bot (no extra scope).
  'cardkit:card:write', // interactive button cards (CardKit entities)
] as const;

const HOSTS: Record<TenantBrand, string> = {
  feishu: 'open.feishu.cn',
  lark: 'open.larksuite.com',
};

/**
 * Developer-console URL that pre-selects every scope in `scopes` for the app,
 * so the user enables them all on a single page. Mirrors larksuite/cli's
 * format (`/app/<id>/auth?q=<comma-joined>`); scopes are URL-encoded so a
 * stray `&`/`#` can't inject extra query params.
 */
export function buildScopeGrantUrl(
  appId: string,
  tenant: TenantBrand,
  scopes: readonly string[] = REQUIRED_SCOPES,
): string {
  const host = HOSTS[tenant];
  const q = encodeURIComponent(scopes.join(','));
  return `https://${host}/app/${encodeURIComponent(appId)}/auth?q=${q}`;
}
