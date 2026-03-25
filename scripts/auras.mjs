import AuraActiveEffectData from "./AuraActiveEffectData.mjs";
import AuraActiveEffectSheetMixin from "./AuraActiveEffectSheet.mjs";
import { executeScript, getAllAuraEffects, getChangingSceneAuras, getNearbyTokens, isFinalMovementComplete, removeAndReplaceAuras } from "./helpers.mjs";
import { applyAuraEffects, deleteEffects } from "./queries.mjs";
import { registerSettings } from "./settings.mjs";
import { canvasInit, destroyToken, drawGridLayer, drawToken, refreshToken, updateAllVisualizations, updateTokenVisualization } from "./auraVisualization.mjs";
import { migrate } from "./migrations.mjs";
import { api } from "./api.mjs";
import { registerDnd5eHooks } from "./systems/dnd5e.mjs";
import { checkOnEnterForMovingToken, registerOnEnterHooks } from "./onEnterHealing.mjs";

/** @import { ActiveEffect, TokenDocument, User } from "@client/documents/_module.mjs"; */
/** @import { TokenMovementOperation } from "@client/documents/_types.mjs" */

let seenWarning = false;

async function addRemoveEffect(effect, options, userId) {
  if (!effect.modifiesActor || !(effect.target instanceof Actor)) return;
  if (foundry.utils.getProperty(effect, 'flags.auraeffects.fromAura')) return;
  if (game.user.id !== userId) return;
  const activeGM = game.users.activeGM;
  if (!activeGM) {
    if (!seenWarning) { ui.notifications.warn("AURAEFFECTS.NoActiveGM", { localize: true }); seenWarning = true; }
    return;
  }
  const [activeSourceEffects, inactiveSourceEffects] = getAllAuraEffects(effect.target);
  const [mainToken] = effect.target.getActiveTokens(false, true);
  if (!mainToken) return;

  const actorToEffectsMap = {};
  const toDelete = [];
  for (const sourceEffect of activeSourceEffects) {
    const { distance: radius, disposition, collisionTypes } = sourceEffect.system;
    await sourceEffect.prepareData();
    const nearby = getNearbyTokens(mainToken, radius, { disposition, collisionTypes });
    if (!nearby.length) continue;
    const shouldHave = nearby.filter(t => t !== mainToken && executeScript(mainToken, t, sourceEffect));
    const toAddTo = shouldHave.map(t => t.actor).filter(a => !a?.effects.find(e => e.origin === sourceEffect.uuid)).map(a => a.uuid);
    for (const actorUuid of toAddTo) actorToEffectsMap[actorUuid] = (actorToEffectsMap[actorUuid] ?? []).concat(sourceEffect.uuid);
    for (const currToken of nearby.filter(t => !shouldHave.includes(t))) {
      const badEffect = currToken.actor.effects.find(e => e.origin === sourceEffect.uuid);
      if (badEffect) toDelete.push(badEffect);
    }
  }

  const [sceneAurasToRemove, sceneAurasToAdd] = getChangingSceneAuras(mainToken);
  if (sceneAurasToRemove.length) toDelete.push(...sceneAurasToRemove);
  for (const addEffect of sceneAurasToAdd) {
    if (addEffect.uuid === effect.origin) continue;
    actorToEffectsMap[mainToken.actor.uuid] = (actorToEffectsMap[mainToken.actor.uuid] ?? []).concat(addEffect.uuid);
  }

  if (!foundry.utils.isEmpty(actorToEffectsMap)) await activeGM.query("auraeffects.applyAuraEffects", actorToEffectsMap);
  if (toDelete) await removeAndReplaceAuras(toDelete, mainToken.parent);
}

async function createToken(token, options, userId) {
  if (game.user.id !== userId) return;
  const activeGM = game.users.activeGM;
  if (!activeGM) {
    if (!seenWarning) { ui.notifications.warn("AURAEFFECTS.NoActiveGM", { localize: true }); seenWarning = true; }
    return;
  }
  if (!token.actor) return;
  const [activeSourceEffects] = getAllAuraEffects(token.actor);
  const actorToEffectsMap = {};
  for (const effect of activeSourceEffects) {
    const { distance: radius, disposition, collisionTypes } = effect.system;
    if (!radius) continue;
    const inRange = new Set(getNearbyTokens(token, radius, { disposition, collisionTypes }).filter(t => executeScript(token, t, effect)).map(t => t.actor));
    const toAddTo = Array.from(inRange.filter(a => (a !== token.actor) && !a?.effects.find(e => e.origin === effect.uuid))).map(a => a?.uuid);
    for (const actorUuid of toAddTo) actorToEffectsMap[actorUuid] = (actorToEffectsMap[actorUuid] ?? []).concat(effect.uuid);
  }
  if (!foundry.utils.isEmpty(actorToEffectsMap)) await activeGM.query("auraeffects.applyAuraEffects", actorToEffectsMap);
}

async function deleteToken(token, options, userId) {
  if (game.user.id !== userId) return;
  if (!canvas.scene) return;
  const actor = token.actor;
  if (!actor) return;
  const activeGM = game.users.activeGM;
  if (!activeGM) {
    if (!seenWarning) { ui.notifications.warn("AURAEFFECTS.NoActiveGM", { localize: true }); seenWarning = true; }
    return;
  }
  const [activeSourceEffects] = getAllAuraEffects(actor);
  const auraSourceUuids = activeSourceEffects.map(e => e.uuid);
  const toRemoveAppliedEffects = canvas.scene.tokens
    .filter(t => t.actor && (t.actor !== actor))
    .flatMap(t => t.actor.appliedEffects)
    .filter(e => e.flags?.auraeffects?.fromAura && auraSourceUuids.includes(e.origin));
  await removeAndReplaceAuras(toRemoveAppliedEffects, canvas.scene);
}

async function updateToken(token, updates, options, userId) {
  updateTokenVisualization(token, updates);
  if (game.user.id !== userId) return;
  const activeGM = game.users.activeGM;
  if (!activeGM) {
    if (!seenWarning) { ui.notifications.warn("AURAEFFECTS.NoActiveGM", { localize: true }); seenWarning = true; }
    return;
  }
  if (!token.actor) return;
  const [activeSourceEffects, inactiveSourceEffects] = getAllAuraEffects(token.actor);
  if (updates.hidden) {
    const toRemoveSourceEffects = inactiveSourceEffects.filter(e => e.system.disableOnHidden);
    const toRemoveAppliedEffects = canvas.scene.tokens
      .filter(t => t.actor && (t !== token))
      .flatMap(t => t.actor.appliedEffects)
      .filter(e => e.flags?.auraeffects?.fromAura && toRemoveSourceEffects.some(sourceEff => e.origin === sourceEff.uuid));
    if (toRemoveAppliedEffects.length) await removeAndReplaceAuras(toRemoveAppliedEffects, token.parent);
  }
  if (("x" in updates) || ("y" in updates) || ("elevation" in updates)) return;
  if (updates.hidden === false) {
    const actorToEffectsMap = {};
    for (const effect of activeSourceEffects) {
      const { distance: radius, disposition, collisionTypes } = effect.system;
      if (!radius) continue;
      const inRange = new Set(getNearbyTokens(token, radius, { disposition, collisionTypes }).filter(t => executeScript(token, t, effect)).map(t => t.actor));
      const toAddTo = Array.from(inRange.filter(a => (a !== token.actor) && !a?.effects.find(e => e.origin === effect.uuid))).map(a => a?.uuid);
      for (const actorUuid of toAddTo) actorToEffectsMap[actorUuid] = (actorToEffectsMap[actorUuid] ?? []).concat(effect.uuid);
    }
    if (!foundry.utils.isEmpty(actorToEffectsMap)) await activeGM.query("auraeffects.applyAuraEffects", actorToEffectsMap);
  }
}

async function moveToken(token, movement, operation, user) {
  if (game.user !== user) return;
  const activeGM = game.users.activeGM;
  if (!activeGM) {
    if (!seenWarning) { ui.notifications.warn("AURAEFFECTS.NoActiveGM", { localize: true }); seenWarning = true; }
    return;
  }
  if (!token.actor) return;
  const [activeSourceEffects, inactiveSourceEffects] = getAllAuraEffects(token.actor);
  const inactiveUuids = inactiveSourceEffects.map(e => e.uuid);

  const preMoveRanges = {};
  if (!("previousActorId" in operation)) {
    for (const effect of activeSourceEffects) {
      const { distance: radius, disposition, collisionTypes } = effect.system;
      if (!radius) continue;
      preMoveRanges[effect.uuid] = new Set(getNearbyTokens(token, radius, { origin: movement.origin, disposition, collisionTypes }).map(t => t.actor));
    }
  }
  await token.object.movementAnimationPromise;

  const actorToEffectsMap = {};
  for (const effect of activeSourceEffects) {
    const { distance: radius, disposition, collisionTypes } = effect.system;
    if (!radius) continue;
    const preMoveRange = preMoveRanges[effect.uuid] ?? new Set();
    const postMoveRange = new Set(
      getNearbyTokens(token, radius, { disposition, collisionTypes })
      .filter(t => executeScript(token, t, effect))
      .map(t => t.actor)
    );
    const toDelete = Array.from(preMoveRange.difference(postMoveRange)).map(a => a.effects.find(e => e.origin === effect.uuid));
    const additionalDeletion = token.parent.tokens.map(t => t.actor?.appliedEffects.filter(e => inactiveUuids.includes(e.origin)) ?? []).flat();
    await removeAndReplaceAuras(toDelete.concat(additionalDeletion).filter(e => e), token.parent);

    if (isFinalMovementComplete(token)) {
      const toAddTo = Array.from(postMoveRange.difference(preMoveRange).filter(a => (a !== token.actor) && !a?.effects.find(e => e.origin === effect.uuid))).map(a => a?.uuid);
      for (const actorUuid of toAddTo) actorToEffectsMap[actorUuid] = (actorToEffectsMap[actorUuid] ?? []).concat(effect.uuid);
    }
  }
  if (isFinalMovementComplete(token) && !foundry.utils.isEmpty(actorToEffectsMap)) {
    await activeGM.query("auraeffects.applyAuraEffects", actorToEffectsMap);
  }

  const [sceneAurasToRemove, sceneAurasToAdd] = getChangingSceneAuras(token, movement.origin);
  if (sceneAurasToRemove.length) await removeAndReplaceAuras(sceneAurasToRemove, token.parent);
  if (sceneAurasToAdd.length && isFinalMovementComplete(token)) {
    await activeGM.query("auraeffects.applyAuraEffects", { [token.actor.uuid]: sceneAurasToAdd.map(e => e.uuid) });
  }

  // ── On-Enter Healing: fire after final step of movement ──
  if (isFinalMovementComplete(token)) {
    await checkOnEnterForMovingToken(token, movement.origin);
  }
}

async function updateActiveEffect(effect, updates, options, userId) {
  if (game.user.id !== userId) return;
  if (effect.type !== "auraeffects.aura") return;
  if (!updates.hasOwnProperty("disabled") && !updates.hasOwnProperty("system")) return;
  if (!canvas.scene) return;
  const actor = (effect.parent instanceof Actor) ? effect.parent : effect.parent?.parent;
  const [token] = actor?.getActiveTokens(false, true) ?? [];
  if (!token) return;
  const activeGM = game.users.activeGM;
  if (!activeGM) {
    if (!seenWarning) { ui.notifications.warn("AURAEFFECTS.NoActiveGM", { localize: true }); seenWarning = true; }
    return;
  }

  let toRemoveAppliedEffects = canvas.scene.tokens
    .filter(t => t.actor && (t.actor !== actor))
    .flatMap(t => t.actor.appliedEffects)
    .filter(e => e.flags?.auraeffects?.fromAura && e.origin === effect.uuid);

  if (!updates.disabled) {
    const { distance: radius, disposition, collisionTypes } = effect.system;
    if (!radius) return;
    const tokensInRange = getNearbyTokens(token, radius, { disposition, collisionTypes }).filter(t => t !== token && t.actor !== token.actor);
    const shouldHave = tokensInRange.filter(t => executeScript(token, t, effect)).map(t => t.actor);
    toRemoveAppliedEffects = toRemoveAppliedEffects.filter(e => !shouldHave.includes(e.target));
    const toAddTo = shouldHave.filter(a => !a.effects.find(e => e.origin === effect.uuid));
    const actorToEffectsMap = Object.fromEntries(toAddTo.map(a => [a.uuid, [effect.uuid]]));
    if (!foundry.utils.isEmpty(actorToEffectsMap)) await activeGM.query("auraeffects.applyAuraEffects", actorToEffectsMap);
  }
  if (toRemoveAppliedEffects.length) await removeAndReplaceAuras(toRemoveAppliedEffects, canvas.scene);
}

async function deleteActiveEffect(effect, options, userId) {
  if (game.user.id !== userId) return;
  if (effect.type !== "auraeffects.aura") return;
  if (!canvas.scene) return;
  const actor = (effect.parent instanceof Actor) ? effect.parent : effect.parent?.parent;
  if (!actor) return;
  const activeGM = game.users.activeGM;
  if (!activeGM) {
    if (!seenWarning) { ui.notifications.warn("AURAEFFECTS.NoActiveGM", { localize: true }); seenWarning = true; }
    return;
  }
  const toRemoveAppliedEffects = canvas.scene.tokens
    .filter(t => t.actor && (t.actor !== actor))
    .flatMap(t => t.actor.appliedEffects)
    .filter(e => e.flags?.auraeffects?.fromAura && e.origin === effect.uuid);
  await removeAndReplaceAuras(toRemoveAppliedEffects, canvas.scene);
}

function injectAuraButton(app, html) {
  const typesToInjectOn = ["base"];
  if (!typesToInjectOn.includes(app.document.type)) return;
  const template = document.createElement("template");
  template.innerHTML = `
    <div class="form-group">
      <label>Aura Effects</label>
      <div class="form-fields">
        <button type="button" data-tooltip="AURAEFFECTS.ConvertToAuraHint">
          <i class="fa-solid fa-person-rays"></i>
          ${game.i18n.localize("AURAEFFECTS.ConvertToAura")}
        </button>
      </div>
    </div>
  `;
  const element = template.content.children[0];
  html.querySelector(".tab[data-tab=details]")?.insertAdjacentElement("beforeend", element);
  element.querySelector("button")?.addEventListener("click", () => {
    const currType = app.document.type;
    const updates = app._processFormData(null, app.form, new foundry.applications.ux.FormDataExtended(app.form));
    if (foundry.utils.getType(updates.changes) !== "Array") updates.changes = Object.values(updates.changes ?? {});
    updates.type = "auraeffects.aura";
    foundry.utils.setProperty(updates, "flags.auraeffects.originalType", currType);
    updates["==system"] = { showRadius: game.settings.get("auraeffects", "defaultVisibility") };
    return app.document.update(updates);
  });
}

function registerHooks() {
  Hooks.on("createActiveEffect", addRemoveEffect);
  Hooks.on("deleteActiveEffect", addRemoveEffect);
  Hooks.on("createToken", createToken);
  Hooks.on("deleteToken", deleteToken);
  Hooks.on("updateToken", updateToken);
  Hooks.on("moveToken", moveToken);
  Hooks.on("updateActiveEffect", updateActiveEffect);
  Hooks.on("deleteActiveEffect", deleteActiveEffect);
  Hooks.on("renderActiveEffectConfig", injectAuraButton);
  Hooks.on("canvasInit", canvasInit);
  Hooks.on("drawGridLayer", drawGridLayer);
  Hooks.on("drawToken", drawToken);
  Hooks.on("destroyToken", destroyToken);
  Hooks.on("refreshToken", refreshToken);
  Hooks.on("initializeLightSources", updateAllVisualizations);

  switch (game.system.id) {
    case "dnd5e": registerDnd5eHooks(); break;
  }

  registerOnEnterHooks();
}

function registerQueries() {
  CONFIG.queries["auraeffects.deleteEffects"] = deleteEffects;
  CONFIG.queries["auraeffects.applyAuraEffects"] = applyAuraEffects;
}

function registerAuraType() {
  Object.assign(CONFIG.ActiveEffect.dataModels, { "auraeffects.aura": AuraActiveEffectData });
}

function registerAuraSheet() {
  const defaultAESheet = Object.values(CONFIG.ActiveEffect.sheetClasses.base).find(d => d.default)?.cls;
  const AuraActiveEffectSheet = AuraActiveEffectSheetMixin(defaultAESheet ?? foundry.applications.sheets.ActiveEffectConfig);
  foundry.applications.apps.DocumentSheetConfig.registerSheet(ActiveEffect, "auraeffects", AuraActiveEffectSheet, {
    label: "AURAEFFECTS.SHEETS.AuraActiveEffectSheet",
    types: ["auraeffects.aura"],
    makeDefault: true
  });
}

Hooks.once("init", () => {
  registerHooks();
  registerQueries();
  registerAuraType();
  registerSettings();
  CONFIG.Canvas.polygonBackends.aura = foundry.canvas.geometry.ClockwiseSweepPolygon;
});

Hooks.once("ready", () => {
  registerAuraSheet();
  game.modules.get("auraeffects").api = api;
  if (game.user.isActiveGM) migrate();
});
