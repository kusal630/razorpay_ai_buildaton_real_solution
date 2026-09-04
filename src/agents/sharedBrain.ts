/**
 * Re-export from the shared brain lib.
 * This file exists for backward-compat imports from agent files.
 */
export {
  callBrain,
  rulesBrain as _rulesBrain,
  buildRecoveryContext,
  buildUpsellContext,
  buildChatContext,
  isCircuitOpen,
  getKillSwitch,
  setKillSwitch,
  getCircuitStatus,
  RecoveryOutputSchema,
  UpsellOutputSchema,
  ChatOutputSchema,
  RECOVERY_SYSTEM_PROMPT,
  UPSELL_SYSTEM_PROMPT,
  CHAT_SYSTEM_PROMPT,
} from "../lib/sharedBrain.js";
export type { BrainResult } from "../lib/sharedBrain.js";
