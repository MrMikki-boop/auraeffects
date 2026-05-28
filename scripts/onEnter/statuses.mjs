export const STATUS_DURATION_MODES = {
  MANUAL: "manual",
  ROUNDS: "rounds",
  UNTIL_TURN_START: "untilTurnStart",
  UNTIL_TURN_END: "untilTurnEnd",
  WHILE_IN_AURA: "whileInAura"
};

export function getStatusEffects() {
  const statusEffects = CONFIG.statusEffects ?? [];
  return Array.isArray(statusEffects) ? statusEffects : Object.values(statusEffects);
}

export function getStatusEffect(statusId) {
  return getStatusEffects().find(status => status?.id === statusId);
}

export function getStatusEffectLabel(statusId) {
  const status = getStatusEffect(statusId);
  if (!status) return null;
  return game.i18n.localize(status.name ?? status.label ?? status.id);
}

export function hasEffectStatus(effect, statusId) {
  const statuses = effect.statuses;
  if (statuses instanceof Set) return statuses.has(statusId);
  if (Array.isArray(statuses)) return statuses.includes(statusId);
  if (statuses && typeof statuses.has === "function") return statuses.has(statusId);
  return false;
}

export function getActorEffects(actor) {
  return actor?.effects?.contents ?? Array.from(actor?.effects ?? []);
}

export function findActorStatusEffect(actor, statusId) {
  return getActorEffects(actor).find(effect => hasEffectStatus(effect, statusId));
}
