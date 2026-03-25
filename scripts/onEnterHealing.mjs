/**
 * onEnterHealing.mjs
 *
 * Triggers a roll-and-heal when a token enters or starts its turn inside an aura
 * that has `onEnterEnabled = true`.
 *
 * === Trigger rules ===
 *
 * IN COMBAT:
 *   • A token may be healed at most ONCE per [round+turn] per [sourceEffect].
 *   • The trigger fires when:
 *       (a) The token MOVES INTO the zone during any turn (move trigger).
 *       (b) The token STARTS ITS OWN TURN already inside the zone (turn-start trigger).
 *   • If both (a) and (b) would fire in the same round+turn slot, only the
 *     first one counts.  The key is  `combatId|round|turn|tokenId|effectId`.
 *
 * OUT OF COMBAT:
 *   • Fires on every entry into the zone (no per-turn limiting).
 *   • We still prevent a double-fire from the same single movement segment by
 *     tracking movement-session keys that are cleared after a short timeout.
 */

import { getAllAuraEffects, getNearbyTokens, getTokenToTokenDistance } from "./helpers.mjs";
import { DISPOSITIONS } from "./constants.mjs";

// ─── Dedup stores ────────────────────────────────────────────────────────────

/**
 * In-combat dedup: `combatId|round|turn|tokenId|effectId`
 * Cleared at the start of each new combat turn (combatTurnChange hook).
 */
const inCombatTriggered = new Set();

/**
 * Out-of-combat dedup: `tokenId|effectId`
 * Entries are added when a move fires, then removed after a short delay so that
 * a token that leaves and re-enters later still triggers again.
 * (We can't use movement origin alone because multiple waypoints share one hook call.)
 */
const outOfCombatTriggered = new Set();
const OUT_OF_COMBAT_COOLDOWN_MS = 500; // same movement segment grace window

// ─── Key helpers ─────────────────────────────────────────────────────────────

function combatKey(effectId, tokenId) {
  const c = game.combat;
  return `${c.id}|${c.round}|${c.turn}|${tokenId}|${effectId}`;
}

function moveKey(effectId, tokenId) {
  return `${tokenId}|${effectId}`;
}

/**
 * Returns true if this trigger should be skipped (already fired this slot).
 * Also registers the key so subsequent calls are blocked.
 */
function isDuplicate(effectId, tokenId) {
  if (game.combat?.active) {
    const key = combatKey(effectId, tokenId);
    if (inCombatTriggered.has(key)) return true;
    inCombatTriggered.add(key);
    return false;
  } else {
    const key = moveKey(effectId, tokenId);
    if (outOfCombatTriggered.has(key)) return true;
    outOfCombatTriggered.add(key);
    setTimeout(() => outOfCombatTriggered.delete(key), OUT_OF_COMBAT_COOLDOWN_MS);
    return false;
  }
}

// ─── Disposition check ───────────────────────────────────────────────────────

function passesDisposition(sourceToken, targetToken, requiredDisposition) {
  if (requiredDisposition === DISPOSITIONS.ANY) return true;
  const rel = sourceToken.disposition * targetToken.disposition;
  if (requiredDisposition === DISPOSITIONS.FRIENDLY) return rel > 0;
  if (requiredDisposition === DISPOSITIONS.HOSTILE)  return rel < 0;
  return true;
}

// ─── Conditional script check ────────────────────────────────────────────────

function passesScript(sourceToken, targetToken, effect) {
  const script = effect.system.onEnterScript?.trim();
  if (!script) return true;
  const actor    = targetToken.actor;
  const rollData = actor?.getRollData?.() ?? {};
  try {
    return Function("actor", "token", "sourceToken", "rollData",
      `return Boolean(${script});`
    ).call(null, actor, targetToken.object ?? targetToken, sourceToken.object ?? sourceToken, rollData);
  } catch (e) {
    console.error(`Aura Effects | onEnterScript error for "${effect.name}":`, e);
    return true;
  }
}

// ─── Core: roll and apply ────────────────────────────────────────────────────

async function applyOnEnterHealing(sourceEffect, targetActor, sourceToken, targetToken) {
  const sys = sourceEffect.system;
  if (!sys.hasOnEnterEffect) return;

  // ── Uses check ──
  const remaining = sys.remainingUses;
  if (remaining <= 0) {
    // Silent — no notification spam. Uses are just exhausted.
    return;
  }

  // ── Roll ──
  const roll = await new Roll(
    sys.onEnterFormula,
    sourceEffect.parent?.getRollData?.() ?? {}
  ).evaluate();

  const healTypeLabel = sys.onEnterHealType === "temp"
    ? game.i18n.localize("AURAEFFECTS.ACTIVEEFFECT.Aura.FIELDS.onEnterHealType.Choices.temp")
    : game.i18n.localize("AURAEFFECTS.ACTIVEEFFECT.Aura.FIELDS.onEnterHealType.Choices.hp");

  await roll.toMessage({
    speaker: ChatMessage.getSpeaker({ token: sourceToken }),
    flavor:  `${sourceEffect.name} → ${targetActor.name} (${healTypeLabel})`
  });

  // ── Apply ──
  if (sys.onEnterHealType === "temp") {
    await applyTempHP(targetActor, roll.total);
  } else {
    await applyHP(targetActor, roll.total);
  }

  // ── Decrement uses ──
  if (sys.onEnterUsesMax?.trim() && remaining !== Infinity) {
    // If uninitialised (-1), write maxUses-1 so the counter is now explicit.
    const newRemaining = (sys.onEnterUsesRemaining < 0 ? sys.maxUses : remaining) - 1;
    await sourceEffect.update({ "system.onEnterUsesRemaining": newRemaining });
    if (newRemaining <= 0) {
      ui.notifications?.info(
        game.i18n.format("AURAEFFECTS.OnEnter.UsesExhausted", { effect: sourceEffect.name })
      );
    }
  }
}

// ─── System-agnostic HP helpers ──────────────────────────────────────────────

async function applyHP(actor, amount) {
  if (game.system.id === "dnd5e" && typeof actor.applyDamage === "function") {
    return actor.applyDamage([{ value: amount, type: "healing" }]);
  }
  const hp = actor.system?.attributes?.hp ?? actor.system?.hp;
  if (!hp) return;
  const path = actor.system?.attributes?.hp !== undefined
    ? "system.attributes.hp.value"
    : "system.hp.value";
  return actor.update({ [path]: Math.min((hp.value ?? 0) + amount, hp.max ?? Infinity) });
}

async function applyTempHP(actor, amount) {
  if (game.system.id === "dnd5e" && typeof actor.applyTempHP === "function") {
    return actor.applyTempHP(amount);
  }
  const hp = actor.system?.attributes?.hp ?? actor.system?.hp;
  if (!hp) return;
  if (amount <= (hp.temp ?? 0)) return; // temp HP never stacks — take the higher
  const path = actor.system?.attributes?.hp !== undefined
    ? "system.attributes.hp.temp"
    : "system.hp.temp";
  return actor.update({ [path]: amount });
}

// ─── Shared: evaluate one source-effect against one target token ─────────────

async function tryTrigger(sourceEffect, sourceToken, targetToken) {
  if (!sourceEffect.system.hasOnEnterEffect) return;
  if (!targetToken.actor) return;
  if (!passesDisposition(sourceToken, targetToken, sourceEffect.system.onEnterDisposition)) return;
  if (!passesScript(sourceToken, targetToken, sourceEffect)) return;
  if (isDuplicate(sourceEffect.id, targetToken.id)) return;
  await applyOnEnterHealing(sourceEffect, targetToken.actor, sourceToken, targetToken);
}

// ─── Move trigger ────────────────────────────────────────────────────────────
// Called from auras.mjs → moveToken, AFTER movement animation completes.

export async function checkOnEnterForMovingToken(token, origin) {
  if (!token.actor) return;
  // Only the active GM runs the writes.
  if (!game.users.activeGM || game.user !== game.users.activeGM) return;

  // Case 1: token walked INTO someone else's aura
  for (const sourceToken of token.parent.tokens) {
    if (sourceToken === token) continue;
    if (!sourceToken.actor) continue;

    const [activeEffects] = getAllAuraEffects(sourceToken.actor);
    for (const effect of activeEffects) {
      if (!effect.system.hasOnEnterEffect) continue;
      const sys    = effect.system;
      const radius = sys.distance;
      if (!radius) continue;

      const distBefore = getTokenToTokenDistance(sourceToken, token,
        { originB: origin, collisionTypes: sys.collisionTypes });
      const distNow    = getTokenToTokenDistance(sourceToken, token,
        { collisionTypes: sys.collisionTypes });

      // Only fire if the token just crossed from outside → inside
      if (distBefore <= radius) continue; // was already inside
      if (distNow    >  radius) continue; // still outside

      await tryTrigger(effect, sourceToken, token);
    }
  }

  // Case 2: this token's own aura swept over other tokens as it moved
  const [ownEffects] = getAllAuraEffects(token.actor);
  for (const effect of ownEffects) {
    if (!effect.system.hasOnEnterEffect) continue;
    const sys    = effect.system;
    const radius = sys.distance;
    if (!radius) continue;

    for (const targetToken of token.parent.tokens) {
      if (targetToken === token) continue;
      if (!targetToken.actor) continue;

      const distBefore = getTokenToTokenDistance(token, targetToken,
        { originA: origin, collisionTypes: sys.collisionTypes });
      const distNow    = getTokenToTokenDistance(token, targetToken,
        { collisionTypes: sys.collisionTypes });

      if (distBefore <= radius) continue; // target was already inside this aura
      if (distNow    >  radius) continue; // target still outside

      await tryTrigger(effect, token, targetToken);
    }
  }
}

// ─── Turn-start trigger ──────────────────────────────────────────────────────
// Called from combatTurnChange hook.

export async function checkOnTurnStartForToken(combatant) {
  if (!game.users.activeGM || game.user !== game.users.activeGM) return;
  const token = combatant.token;
  if (!token?.actor) return;

  // Case 1: token is inside someone else's aura at turn start
  for (const sourceToken of token.parent?.tokens ?? []) {
    if (sourceToken === token) continue;
    if (!sourceToken.actor) continue;

    const [activeEffects] = getAllAuraEffects(sourceToken.actor);
    for (const effect of activeEffects) {
      if (!effect.system.hasOnEnterEffect) continue;
      const radius = effect.system.distance;
      if (!radius) continue;

      const dist = getTokenToTokenDistance(sourceToken, token,
        { collisionTypes: effect.system.collisionTypes });
      if (dist > radius) continue;

      await tryTrigger(effect, sourceToken, token);
    }
  }

  // Case 2: it's the aura-source token's own turn — heal everyone in its aura
  const [ownEffects] = getAllAuraEffects(token.actor);
  for (const effect of ownEffects) {
    if (!effect.system.hasOnEnterEffect) continue;
    const radius = effect.system.distance;
    if (!radius) continue;

    const nearby = getNearbyTokens(token, radius, {
      disposition:    effect.system.onEnterDisposition,
      collisionTypes: effect.system.collisionTypes
    });
    for (const targetToken of nearby) {
      if (targetToken === token) continue;
      await tryTrigger(effect, token, targetToken);
    }
  }
}

// ─── Hook registration ───────────────────────────────────────────────────────

export function registerOnEnterHooks() {
  Hooks.on("combatTurnChange", async (combat, _prior, current) => {
    // Clear last-turn's dedup keys so the new turn is a fresh slate
    inCombatTriggered.clear();

    const combatant = combat.combatants.get(current.combatantId);
    if (combatant) await checkOnTurnStartForToken(combatant);
  });
}
