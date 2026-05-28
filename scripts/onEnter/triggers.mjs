import { getAllAuraEffects, getTokenToTokenDistance } from "../helpers.mjs";
import { registerSaveOutcomeChatHook } from "./chat.mjs";
import { cleanupStatusesForSourceEffect, cleanupTurnBoundStatuses, cleanupWhileInAuraStatuses, processEndOfTurnRepeatSaves } from "./duration.mjs";
import { applyOnEnterEffect, applyOnEnterSaveOutcome } from "./outcomes.mjs";
import { canTriggerOn, matchesDisposition, passesScript } from "./predicates.mjs";

const inCombatTriggered = new Set();
const outOfCombatTriggered = new Set();

const OUT_OF_COMBAT_COOLDOWN_MS = 500;

function isDuplicate(effectId, tokenId) {
  if (game.combat?.active) {
    const c = game.combat;
    const key = `${c.id}|${c.round}|${c.turn}|${tokenId}|${effectId}`;
    if (inCombatTriggered.has(key)) return true;
    inCombatTriggered.add(key);
    return false;
  }

  const key = `${tokenId}|${effectId}`;
  if (outOfCombatTriggered.has(key)) return true;
  outOfCombatTriggered.add(key);
  setTimeout(() => outOfCombatTriggered.delete(key), OUT_OF_COMBAT_COOLDOWN_MS);
  return false;
}

async function tryTrigger(sourceEffect, sourceToken, targetToken) {
  if (!sourceEffect.system.hasOnEnterEffect) return;
  if (!targetToken.actor) return;

  if (!matchesDisposition(sourceToken, targetToken, sourceEffect.system.onEnterDisposition)) {
    const sys = sourceEffect.system;
    const dmgWouldRun = sys.onEnterDmgEnabled && matchesDisposition(sourceToken, targetToken, sys.onEnterDmgDisposition);
    const saveWouldRun = sys.onEnterSaveEnabled && matchesDisposition(sourceToken, targetToken, sys.onEnterSaveDisposition);
    if (!dmgWouldRun && !saveWouldRun) return;
  }

  if (!passesScript(sourceToken, targetToken, sourceEffect)) return;
  if (isDuplicate(sourceEffect.id, targetToken.id)) return;
  await applyOnEnterEffect(sourceEffect, targetToken.actor, sourceToken, targetToken);
}

export async function checkOnEnterForMovingToken(token, origin) {
  if (!token.actor) return;
  if (!game.users.activeGM || game.user !== game.users.activeGM) return;

  for (const sourceToken of token.parent.tokens) {
    if (sourceToken === token) continue;
    if (!sourceToken.actor) continue;
    const [activeEffects] = getAllAuraEffects(sourceToken.actor);
    for (const effect of activeEffects) {
      if (!effect.system.hasOnEnterEffect) continue;
      if (!canTriggerOn(effect, "movement")) continue;
      const { distance: radius, collisionTypes } = effect.system;
      if (!radius) continue;
      const distBefore = getTokenToTokenDistance(sourceToken, token, { originB: origin, collisionTypes });
      const distNow = getTokenToTokenDistance(sourceToken, token, { collisionTypes });
      if (distBefore <= radius || distNow > radius) continue;
      await tryTrigger(effect, sourceToken, token);
    }
  }

  const [ownEffects] = getAllAuraEffects(token.actor);
  for (const effect of ownEffects) {
    if (!effect.system.hasOnEnterEffect) continue;
    if (!canTriggerOn(effect, "movement")) continue;
    const { distance: radius, collisionTypes } = effect.system;
    if (!radius) continue;
    for (const targetToken of token.parent.tokens) {
      if (targetToken === token) continue;
      if (!targetToken.actor) continue;
      const distBefore = getTokenToTokenDistance(token, targetToken, { originA: origin, collisionTypes });
      const distNow = getTokenToTokenDistance(token, targetToken, { collisionTypes });
      if (distBefore <= radius || distNow > radius) continue;
      await tryTrigger(effect, token, targetToken);
    }
  }
}

export async function checkOnTurnStartForToken(combatant) {
  if (!game.users.activeGM || game.user !== game.users.activeGM) return;
  const token = combatant.token;
  if (!token?.actor) return;

  for (const sourceToken of token.parent?.tokens ?? []) {
    if (!sourceToken.actor) continue;
    const [activeEffects] = getAllAuraEffects(sourceToken.actor);
    for (const effect of activeEffects) {
      if (!effect.system.hasOnEnterEffect) continue;
      if (!canTriggerOn(effect, "turn")) continue;

      const isSelf = sourceToken === token;
      if (isSelf) {
        if (!effect.system.onEnterApplyToSelf) continue;
        if (!passesScript(sourceToken, token, effect)) continue;
        if (isDuplicate(effect.id, token.id)) continue;
        await applyOnEnterEffect(effect, token.actor, sourceToken, token);
        continue;
      }

      const dist = getTokenToTokenDistance(sourceToken, token, { collisionTypes: effect.system.collisionTypes });
      if (dist > effect.system.distance) continue;
      await tryTrigger(effect, sourceToken, token);
    }
  }
}

function isTokenPositionUpdate(updates) {
  return ["x", "y", "elevation", "hidden"].some(key => Object.hasOwn(updates, key));
}

export function registerOnEnterHooks() {
  Hooks.on("combatTurnChange", async (combat, prior, current) => {
    inCombatTriggered.clear();
    if (game.users.activeGM && game.user === game.users.activeGM) {
      await processEndOfTurnRepeatSaves(combat, prior);
      await cleanupTurnBoundStatuses(combat, prior, current);
      await cleanupWhileInAuraStatuses(combat.scene);
    }
    const combatant = current?.combatantId ? combat.combatants.get(current.combatantId) : null;
    if (combatant) await checkOnTurnStartForToken(combatant);
  });

  Hooks.on("updateToken", async (token, updates) => {
    if (!game.users.activeGM || game.user !== game.users.activeGM) return;
    if (!isTokenPositionUpdate(updates)) return;
    await cleanupWhileInAuraStatuses(token.parent);
  });

  Hooks.on("deleteToken", async token => {
    if (!game.users.activeGM || game.user !== game.users.activeGM) return;
    await cleanupWhileInAuraStatuses(token.parent);
  });

  Hooks.on("updateActiveEffect", async (effect, updates) => {
    if (!game.users.activeGM || game.user !== game.users.activeGM) return;
    if (effect.type !== "auraeffects.aura") return;
    if (!Object.hasOwn(updates, "disabled") && !Object.hasOwn(updates, "system")) return;
    await cleanupWhileInAuraStatuses(canvas?.scene);
  });

  Hooks.on("deleteActiveEffect", async effect => {
    if (!game.users.activeGM || game.user !== game.users.activeGM) return;
    if (effect.type !== "auraeffects.aura") return;
    await cleanupStatusesForSourceEffect(effect.uuid);
  });

  registerSaveOutcomeChatHook(applyOnEnterSaveOutcome);
}
