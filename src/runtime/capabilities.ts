/** Browser-safe capability catalog for Runtime hosts and their settings UI. */
export {
  APPLICATION_COLLABORATOR_SCOPES,
  APP_VERSION_SCOPES,
  CARD_ACTION_CALLBACKS,
  COMMENT_SCOPES,
  CONTACT_SCOPES,
  DISCOVERY_SCOPES,
  GRANT_SCOPES,
  HUMAN_MEMBERSHIP_SCOPES,
  JOIN_GROUP_SCOPES,
  REQUIRED_SCOPES,
  SCOPE_LABELS,
  TASK_SURFACE_SCOPES,
} from '../config/scopes';
export {
  BOT_MEMBERSHIP_EVENTS,
  BOT_MENU_EVENTS,
  DOCUMENT_COMMENT_EVENTS,
  HUMAN_MEMBERSHIP_EVENTS,
  MESSAGE_REACTION_EVENTS,
  OPTIONAL_EVENTS,
  REQUIRED_EVENTS,
} from '../utils/event-diagnosis';
export {
  RUN_IDLE_TIMEOUT_MAX_SEC,
  RUN_IDLE_TIMEOUT_MIN_SEC,
  type ModelDisplayMode,
  type TenantBrand,
} from '../config/schema';
export type { CompletionReminderMode } from '../core/completion-reminder';
