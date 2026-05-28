/**
 * Compatibility facade for on-enter aura behavior.
 *
 * Implementation lives under scripts/onEnter/:
 * - triggers.mjs: movement, turn hooks, dedupe
 * - outcomes.mjs: heal, damage, saves, status outcomes
 * - dnd5e.mjs: dnd5e damage, saves, immunities
 * - duration.mjs: status duration and cleanup
 * - chat.mjs: chat cards and chat actions
 */

export { applyOnEnterFailOutcomes, applyOnEnterSaveOutcome } from "./onEnter/outcomes.mjs";
export { checkOnEnterForMovingToken, registerOnEnterHooks } from "./onEnter/triggers.mjs";
