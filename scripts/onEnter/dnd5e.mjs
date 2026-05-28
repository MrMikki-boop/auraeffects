import { getStatusEffect } from "./statuses.mjs";

export function getDamageTypeLabel(type) {
  const label = CONFIG.DND5E?.damageTypes?.[type]?.label ?? type;
  return game.i18n.localize(label);
}

function getDnd5eConditionImmunities(actor) {
  const value = actor.system?.traits?.ci?.value ?? actor.system?.traits?.ci;
  if (value instanceof Set) return value;
  if (Array.isArray(value)) return new Set(value);
  if (value && typeof value === "object") {
    return new Set(Object.entries(value).filter(([, enabled]) => !!enabled).map(([key]) => key));
  }
  return new Set();
}

export function isImmuneToStatus(actor, statusId) {
  if (game.system.id !== "dnd5e") return false;
  const status = getStatusEffect(statusId);
  const statusIds = new Set([statusId, ...(status?.statuses ?? [])]);
  const immunities = getDnd5eConditionImmunities(actor);
  return Array.from(statusIds).some(id => immunities.has(id));
}

export async function rollDnd5eSavingThrow(targetActor, targetToken, ability, dc) {
  const speaker = ChatMessage.getSpeaker({ actor: targetActor, scene: targetToken.parent, token: targetToken });
  return targetActor.rollSavingThrow(
    { ability, target: dc },
    { configure: false },
    { data: { speaker } }
  );
}

export async function applyHP(actor, amount) {
  if (game.system.id === "dnd5e" && typeof actor.applyDamage === "function") {
    return actor.applyDamage([{ value: amount, type: "healing" }]);
  }

  const hp = actor.system?.attributes?.hp ?? actor.system?.hp;
  if (!hp) return;
  const path = actor.system?.attributes?.hp !== undefined ? "system.attributes.hp.value" : "system.hp.value";
  return actor.update({ [path]: Math.min((hp.value ?? 0) + amount, hp.max ?? Infinity) });
}

export async function applyTempHP(actor, amount) {
  if (game.system.id === "dnd5e" && typeof actor.applyTempHP === "function") {
    return actor.applyTempHP(amount);
  }

  const hp = actor.system?.attributes?.hp ?? actor.system?.hp;
  if (!hp) return;
  if (amount <= (hp.temp ?? 0)) return;
  const path = actor.system?.attributes?.hp !== undefined ? "system.attributes.hp.temp" : "system.hp.temp";
  return actor.update({ [path]: amount });
}

export async function applyDamage(actor, amount, type) {
  if (game.system.id === "dnd5e" && typeof actor.applyDamage === "function") {
    return actor.applyDamage([{ value: amount, type }]);
  }

  const hp = actor.system?.attributes?.hp ?? actor.system?.hp;
  if (!hp) return;
  const path = actor.system?.attributes?.hp !== undefined ? "system.attributes.hp.value" : "system.hp.value";
  return actor.update({ [path]: Math.max(0, (hp.value ?? 0) - amount) });
}
