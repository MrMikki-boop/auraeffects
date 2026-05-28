import { renderSavePromptCard, notifyImmuneStatuses, notifyUnsupportedStatuses } from "./chat.mjs";
import { applyDamage, applyHP, applyTempHP, getDamageTypeLabel, isImmuneToStatus, rollDnd5eSavingThrow } from "./dnd5e.mjs";
import { configureStatusDuration } from "./duration.mjs";
import { matchesDisposition } from "./predicates.mjs";
import { findActorStatusEffect, getStatusEffect, getStatusEffectLabel } from "./statuses.mjs";

async function applyFailOutcomesOnFailedSave(targetActor, total, dc, sourceEffect, context = {}) {
  if (!Number.isFinite(total)) return;
  if (total >= dc) return;
  await applyFailOutcomes(targetActor, sourceEffect, context);
}

function getSaveFailStatuses(system) {
  const statuses = new Set(system.onEnterSaveFailStatuses ?? []);
  const legacy = system.onEnterSaveFailEffect?.trim();
  if (legacy && getStatusEffect(legacy)) statuses.add(legacy);
  return Array.from(statuses).filter(statusId => getStatusEffect(statusId));
}

function getSaveSuccessStatuses(system) {
  return Array.from(new Set(system.onEnterSaveSuccessStatuses ?? [])).filter(statusId => getStatusEffect(statusId));
}

function getLegacyFailEffectRef(system) {
  const legacy = system.onEnterSaveFailEffect?.trim();
  if (!legacy || getStatusEffect(legacy)) return "";
  return legacy;
}

function hasSaveDamage(system, outcome) {
  if (!system.onEnterSaveDmgFormula?.trim()) return false;
  return outcome === "failure" || system.onEnterSaveDmgHalfOnSuccess;
}

function hasFailOutcomes(system) {
  return getSaveFailStatuses(system).length > 0 || !!getLegacyFailEffectRef(system) || hasSaveDamage(system, "failure");
}

function hasSuccessOutcomes(system) {
  return getSaveSuccessStatuses(system).length > 0 || hasSaveDamage(system, "success");
}

function getSaveDamageOutcomeLabel(system) {
  return game.i18n.format("AURAEFFECTS.OnEnter.SaveDamageOutcome", {
    formula: system.onEnterSaveDmgFormula,
    type: getDamageTypeLabel(system.onEnterSaveDmgType)
  });
}

async function getEffectReferenceLabel(effectRef) {
  const statusLabel = getStatusEffectLabel(effectRef);
  if (statusLabel) return statusLabel;

  try {
    const found = await fromUuid(effectRef);
    if (found instanceof ActiveEffect) return found.name;
  } catch (_) {
    // Invalid UUIDs fall back to the raw reference for troubleshooting.
  }
  return effectRef;
}

async function getFailOutcomeLabels(system) {
  const labels = getSaveFailStatuses(system).map(statusId => getStatusEffectLabel(statusId) ?? statusId);
  const legacy = getLegacyFailEffectRef(system);
  if (legacy) labels.push(await getEffectReferenceLabel(legacy));
  if (hasSaveDamage(system, "failure")) labels.push(getSaveDamageOutcomeLabel(system));
  return labels;
}

async function getSuccessOutcomeLabels(system) {
  const labels = getSaveSuccessStatuses(system).map(statusId => getStatusEffectLabel(statusId) ?? statusId);
  if (hasSaveDamage(system, "success")) labels.push(getSaveDamageOutcomeLabel(system));
  return labels;
}

async function applyFailStatus(targetActor, statusId, sourceEffect, context = {}) {
  const label = getStatusEffectLabel(statusId) ?? statusId;
  if (isImmuneToStatus(targetActor, statusId)) return { label, immune: true };
  if (typeof targetActor.toggleStatusEffect !== "function") return { label, unsupported: true };

  const existing = findActorStatusEffect(targetActor, statusId);
  if (existing) return { label, alreadyActive: true };

  await targetActor.toggleStatusEffect(statusId, { active: true });
  const effect = findActorStatusEffect(targetActor, statusId);
  if (effect) await configureStatusDuration(effect, statusId, sourceEffect, context);
  return { label, applied: true };
}

async function applyLegacyFailEffect(targetActor, effectRef, sourceEffect) {
  let effectData = null;
  try {
    const found = await fromUuid(effectRef);
    if (found instanceof ActiveEffect) effectData = found.toObject();
  } catch (_) {
    // Invalid UUIDs fall through to a chat prompt.
  }

  if (!effectData) {
    const effectName = await getEffectReferenceLabel(effectRef);
    await ChatMessage.create({
      speaker: ChatMessage.getSpeaker(),
      content: game.i18n.format("AURAEFFECTS.OnEnter.SaveFailedApplyEffect", {
        effect: sourceEffect.name,
        actor: targetActor.name,
        effectName
      })
    });
    return;
  }

  delete effectData._id;
  foundry.utils.mergeObject(effectData, {
    origin: sourceEffect.uuid,
    transfer: false,
    "flags.auraeffects.fromSaveFail": true
  });
  await targetActor.createEmbeddedDocuments("ActiveEffect", [effectData]);
}

async function applyFailOutcomes(targetActor, sourceEffect, context = {}) {
  const immune = [];
  const unsupported = [];

  for (const statusId of getSaveFailStatuses(sourceEffect.system)) {
    const result = await applyFailStatus(targetActor, statusId, sourceEffect, context);
    if (result.immune) immune.push(result.label);
    if (result.unsupported) unsupported.push(result.label);
  }

  await notifyImmuneStatuses(targetActor, sourceEffect, immune);
  await notifyUnsupportedStatuses(targetActor, sourceEffect, unsupported);
  await applySaveDamage(targetActor, sourceEffect, "failure");

  const legacy = getLegacyFailEffectRef(sourceEffect.system);
  if (legacy) await applyLegacyFailEffect(targetActor, legacy, sourceEffect);
}

async function applySuccessOutcomes(targetActor, sourceEffect, context = {}) {
  const immune = [];
  const unsupported = [];

  for (const statusId of getSaveSuccessStatuses(sourceEffect.system)) {
    const result = await applyFailStatus(targetActor, statusId, sourceEffect, context);
    if (result.immune) immune.push(result.label);
    if (result.unsupported) unsupported.push(result.label);
  }

  await notifyImmuneStatuses(targetActor, sourceEffect, immune);
  await notifyUnsupportedStatuses(targetActor, sourceEffect, unsupported);
  await applySaveDamage(targetActor, sourceEffect, "success");
}

async function applySaveDamage(targetActor, sourceEffect, outcome) {
  const sys = sourceEffect.system;
  if (!hasSaveDamage(sys, outcome)) return;

  const sourceRollData = sourceEffect.parent?.getRollData?.() ?? {};
  const roll = await new Roll(sys.onEnterSaveDmgFormula, sourceRollData).evaluate();
  const total = outcome === "success" ? Math.floor(roll.total / 2) : roll.total;
  if (total <= 0) return;

  const sourceActor = sourceEffect.parent instanceof Actor ? sourceEffect.parent : sourceEffect.parent?.actor;
  await roll.toMessage({
    speaker: ChatMessage.getSpeaker({ actor: sourceActor }),
    flavor: game.i18n.format("AURAEFFECTS.OnEnter.SaveDamageFlavor", {
      effect: sourceEffect.name,
      actor: targetActor.name,
      outcome: game.i18n.localize(`AURAEFFECTS.OnEnter.${outcome === "success" ? "SuccessOutcome" : "FailureOutcome"}`),
      total,
      type: getDamageTypeLabel(sys.onEnterSaveDmgType)
    })
  });

  await applyDamage(targetActor, total, sys.onEnterSaveDmgType);
}

export async function applyOnEnterFailOutcomes({ targetActorUuid, sourceEffectUuid }) {
  return applyOnEnterSaveOutcome({ targetActorUuid, sourceEffectUuid, outcome: "failure" });
}

export async function applyOnEnterSaveOutcome({ targetActorUuid, sourceEffectUuid, sourceTokenUuid, targetTokenUuid, outcome }) {
  const targetActor = await fromUuid(targetActorUuid);
  const sourceEffect = await fromUuid(sourceEffectUuid);
  if (!(targetActor instanceof Actor)) return false;
  if (!(sourceEffect instanceof ActiveEffect)) return false;
  if (!sourceEffect.system?.onEnterSaveEnabled) return false;
  const context = { sourceTokenUuid, targetTokenUuid };

  if (outcome === "success") {
    if (!hasSuccessOutcomes(sourceEffect.system)) return false;
    await applySuccessOutcomes(targetActor, sourceEffect, context);
  } else {
    if (!hasFailOutcomes(sourceEffect.system)) return false;
    await applyFailOutcomes(targetActor, sourceEffect, context);
  }
  return true;
}

export async function applyOnEnterEffect(sourceEffect, targetActor, sourceToken, targetToken) {
  const sys = sourceEffect.system;
  if (!sys.hasOnEnterEffect) return;

  const remaining = sys.remainingUses;
  if (remaining <= 0) return;

  const sourceRollData = sourceEffect.parent?.getRollData?.() ?? {};
  let usedAUse = false;

  if (
    sys.onEnterHealEnabled
    && sys.onEnterHealFormula?.trim()
    && matchesDisposition(sourceToken, targetToken, sys.onEnterDisposition)
  ) {
    const roll = await new Roll(sys.onEnterHealFormula, sourceRollData).evaluate();
    const label = sys.onEnterHealType === "temp"
      ? game.i18n.localize("AURAEFFECTS.ACTIVEEFFECT.Aura.FIELDS.onEnterHealType.Choices.temp")
      : game.i18n.localize("AURAEFFECTS.ACTIVEEFFECT.Aura.FIELDS.onEnterHealType.Choices.hp");

    await roll.toMessage({
      speaker: ChatMessage.getSpeaker({ token: sourceToken }),
      flavor: game.i18n.format("AURAEFFECTS.OnEnter.HealFlavor", {
        effect: sourceEffect.name,
        actor: targetActor.name,
        type: label
      })
    });
    if (sys.onEnterHealType === "temp") await applyTempHP(targetActor, roll.total);
    else await applyHP(targetActor, roll.total);
    usedAUse = true;
  }

  if (
    sys.onEnterDmgEnabled
    && sys.onEnterDmgFormula?.trim()
    && matchesDisposition(sourceToken, targetToken, sys.onEnterDmgDisposition)
  ) {
    const roll = await new Roll(sys.onEnterDmgFormula, sourceRollData).evaluate();
    await roll.toMessage({
      speaker: ChatMessage.getSpeaker({ token: sourceToken }),
      flavor: game.i18n.format("AURAEFFECTS.OnEnter.DamageFlavor", {
        effect: sourceEffect.name,
        actor: targetActor.name,
        type: getDamageTypeLabel(sys.onEnterDmgType)
      })
    });
    await applyDamage(targetActor, roll.total, sys.onEnterDmgType);
    usedAUse = true;
  }

  if (sys.onEnterSaveEnabled && matchesDisposition(sourceToken, targetToken, sys.onEnterSaveDisposition)) {
    const dc = Math.round(new Roll(sys.onEnterSaveDC || "8", sourceRollData).evaluateSync({ strict: false }).total);

    if (game.system.id === "dnd5e" && sys.onEnterSaveMode === "auto") {
      const rolls = await rollDnd5eSavingThrow(targetActor, targetToken, sys.onEnterSaveAbility, dc);
      const total = Array.isArray(rolls) ? rolls[0]?.total : rolls?.total;
      if (Number.isFinite(total)) {
        const context = { sourceToken, targetToken };
        if (total >= dc && hasSuccessOutcomes(sys)) await applySuccessOutcomes(targetActor, sourceEffect, context);
        else if (total < dc && hasFailOutcomes(sys)) await applyFailOutcomesOnFailedSave(targetActor, total, dc, sourceEffect, context);
      }
    } else if (game.system.id === "dnd5e") {
      const enriched = await TextEditor.enrichHTML(
        `[[/save ability=${sys.onEnterSaveAbility} dc=${dc}]]`,
        { async: true }
      );
      const failOutcomeLabels = await getFailOutcomeLabels(sys);
      const successOutcomeLabels = await getSuccessOutcomeLabels(sys);
      await ChatMessage.create({
        speaker: ChatMessage.getSpeaker({ token: sourceToken }),
        content: renderSavePromptCard({
          sourceEffect,
          targetActor,
          enriched,
          failOutcomeLabels,
          successOutcomeLabels
        }),
        flags: {
          auraeffects: {
            onEnterFail: {
              sourceEffectUuid: sourceEffect.uuid,
              targetActorUuid: targetActor.uuid,
              sourceTokenUuid: sourceToken.uuid,
              targetTokenUuid: targetToken.uuid
            }
          },
          dnd5e: { targets: [{ uuid: targetToken.uuid }] }
        }
      });
    } else {
      await ChatMessage.create({
        speaker: ChatMessage.getSpeaker({ token: sourceToken }),
        content: game.i18n.format("AURAEFFECTS.OnEnter.SavePrompt", {
          effect: sourceEffect.name,
          actor: targetActor.name,
          ability: sys.onEnterSaveAbility.toUpperCase(),
          dc
        })
      });
    }
    usedAUse = true;
  }

  if (usedAUse && sys.onEnterUsesMax?.trim() && remaining !== Infinity) {
    const newRemaining = (sys.onEnterUsesRemaining < 0 ? sys.maxUses : remaining) - 1;
    await sourceEffect.update({ "system.onEnterUsesRemaining": newRemaining });
    if (newRemaining <= 0) {
      ui.notifications?.info(game.i18n.format("AURAEFFECTS.OnEnter.UsesExhausted", { effect: sourceEffect.name }));
    }
  }
}
