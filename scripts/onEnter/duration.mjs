import { getTokenToTokenDistance } from "../helpers.mjs";
import { notifyRepeatSaveRemoved } from "./chat.mjs";
import { rollDnd5eSavingThrow } from "./dnd5e.mjs";
import { matchesDisposition, passesScript } from "./predicates.mjs";
import { getActorEffects, getStatusEffectLabel, STATUS_DURATION_MODES } from "./statuses.mjs";

function getCombatPosition() {
  if (!game.combat?.active) return {};
  return {
    appliedRound: game.combat.round,
    appliedTurn: game.combat.turn
  };
}

function getStatusDurationMode(sourceEffect) {
  return sourceEffect.system.onEnterSaveStatusDuration ?? STATUS_DURATION_MODES.MANUAL;
}

export async function configureStatusDuration(effect, statusId, sourceEffect, context = {}) {
  if (!sourceEffect) return;
  const mode = getStatusDurationMode(sourceEffect);
  const repeatSaveOnTurnEnd = !!sourceEffect.system.onEnterSaveRepeatSaveEndOfTurn;
  if ((mode === STATUS_DURATION_MODES.MANUAL) && !repeatSaveOnTurnEnd) return;

  const flag = {
    mode,
    repeatSaveOnTurnEnd,
    statusId,
    sourceEffectUuid: sourceEffect.uuid,
    sourceTokenUuid: context.sourceTokenUuid ?? context.sourceToken?.uuid ?? "",
    targetTokenUuid: context.targetTokenUuid ?? context.targetToken?.uuid ?? "",
    ...getCombatPosition()
  };

  const update = { "flags.auraeffects.onEnterStatus": flag };
  if (mode === STATUS_DURATION_MODES.ROUNDS && game.combat?.active) {
    update.duration = {
      rounds: Math.max(1, Number(sourceEffect.system.onEnterSaveStatusRounds) || 1),
      turns: 0,
      startRound: game.combat.round,
      startTurn: game.combat.turn
    };
  }
  await effect.update(update);
}

function getOnEnterStatusFlag(effect) {
  return effect.getFlag?.("auraeffects", "onEnterStatus") ?? effect.flags?.auraeffects?.onEnterStatus;
}

function getSceneActors(scene = canvas?.scene) {
  return new Set((scene?.tokens ?? []).map(token => token.actor).filter(Boolean));
}

function combatPositionAdvanced(currentRound, currentTurn, flag) {
  if (!Number.isFinite(flag.appliedRound) || !Number.isFinite(flag.appliedTurn)) return true;
  return (currentRound > flag.appliedRound) || ((currentRound === flag.appliedRound) && (currentTurn > flag.appliedTurn));
}

function combatantMatchesActor(combatant, actor) {
  if (!combatant || !actor) return false;
  return combatant.actor === actor || combatant.actor?.uuid === actor.uuid || combatant.token?.actor === actor;
}

async function deleteFlaggedStatusEffect(effect) {
  try {
    await effect.delete();
  } catch (error) {
    console.warn("Aura Effects | Failed to remove on-enter status effect", effect, error);
  }
}

export async function cleanupTurnBoundStatuses(combat, prior, current) {
  const currentCombatant = combat.combatants.get(current?.combatantId);
  const priorCombatant = combat.combatants.get(prior?.combatantId);
  const currentRound = combat.round;
  const currentTurn = combat.turn;

  const actors = new Set(combat.combatants.map(combatant => combatant.actor).filter(Boolean));
  for (const actor of actors) {
    for (const effect of getActorEffects(actor)) {
      const flag = getOnEnterStatusFlag(effect);
      if (!flag) continue;
      const advanced = combatPositionAdvanced(currentRound, currentTurn, flag);
      if (
        flag.mode === STATUS_DURATION_MODES.UNTIL_TURN_START
        && advanced
        && combatantMatchesActor(currentCombatant, actor)
      ) {
        await deleteFlaggedStatusEffect(effect);
      }
      if (
        flag.mode === STATUS_DURATION_MODES.UNTIL_TURN_END
        && advanced
        && combatantMatchesActor(priorCombatant, actor)
      ) {
        await deleteFlaggedStatusEffect(effect);
      }
    }
  }
}

async function getUuidDocument(uuid) {
  if (!uuid) return null;
  try {
    return await fromUuid(uuid);
  } catch (_) {
    return null;
  }
}

async function checkRepeatSaveEndOfTurn(effect, flag, actor, combatant) {
  if (!flag.repeatSaveOnTurnEnd) return;
  if (game.system.id !== "dnd5e") return;
  if (!combatPositionAdvanced(game.combat.round, game.combat.turn, flag)) return;

  const sourceEffect = await getUuidDocument(flag.sourceEffectUuid);
  if (!(sourceEffect instanceof ActiveEffect)) return;
  if (!sourceEffect.system?.onEnterSaveEnabled) return;

  const targetToken = await getUuidDocument(flag.targetTokenUuid) ?? combatant?.token;
  if (!targetToken) return;

  const sourceRollData = sourceEffect.parent?.getRollData?.() ?? {};
  const dc = Math.round(new Roll(sourceEffect.system.onEnterSaveDC || "8", sourceRollData).evaluateSync({ strict: false }).total);
  const rolls = await rollDnd5eSavingThrow(actor, targetToken, sourceEffect.system.onEnterSaveAbility, dc);
  const total = Array.isArray(rolls) ? rolls[0]?.total : rolls?.total;
  if (!Number.isFinite(total) || total < dc) return;

  await deleteFlaggedStatusEffect(effect);
  await notifyRepeatSaveRemoved(actor, getStatusEffectLabel(flag.statusId) ?? flag.statusId, sourceEffect);
}

export async function processEndOfTurnRepeatSaves(combat, prior) {
  const combatant = combat.combatants.get(prior?.combatantId);
  const actor = combatant?.actor;
  if (!actor) return;

  for (const effect of getActorEffects(actor)) {
    const flag = getOnEnterStatusFlag(effect);
    if (!flag) continue;
    await checkRepeatSaveEndOfTurn(effect, flag, actor, combatant);
  }
}

async function shouldRemoveWhileInAuraStatus(effect, flag, actor) {
  if (flag.mode !== STATUS_DURATION_MODES.WHILE_IN_AURA) return false;

  const sourceEffect = await getUuidDocument(flag.sourceEffectUuid);
  const sourceToken = await getUuidDocument(flag.sourceTokenUuid);
  const targetToken = await getUuidDocument(flag.targetTokenUuid);
  if (!(sourceEffect instanceof ActiveEffect)) return true;
  if (!sourceToken?.actor || !targetToken?.actor) return true;
  if (targetToken.actor !== actor) return true;
  if (sourceEffect.disabled || sourceEffect.system?.isSuppressed) return true;

  const distance = getTokenToTokenDistance(sourceToken, targetToken, {
    collisionTypes: sourceEffect.system.collisionTypes
  });
  if (distance > sourceEffect.system.distance) return true;
  if (!matchesDisposition(sourceToken, targetToken, sourceEffect.system.onEnterSaveDisposition)) return true;
  return !passesScript(sourceToken, targetToken, sourceEffect);
}

export async function cleanupWhileInAuraStatuses(scene = canvas?.scene) {
  for (const actor of getSceneActors(scene)) {
    for (const effect of getActorEffects(actor)) {
      const flag = getOnEnterStatusFlag(effect);
      if (!flag) continue;
      if (await shouldRemoveWhileInAuraStatus(effect, flag, actor)) {
        await deleteFlaggedStatusEffect(effect);
      }
    }
  }
}

export async function cleanupStatusesForSourceEffect(sourceEffectUuid, scene = canvas?.scene) {
  for (const actor of getSceneActors(scene)) {
    for (const effect of getActorEffects(actor)) {
      const flag = getOnEnterStatusFlag(effect);
      if (flag?.sourceEffectUuid === sourceEffectUuid) await deleteFlaggedStatusEffect(effect);
    }
  }
}
