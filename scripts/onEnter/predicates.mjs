import { DISPOSITIONS } from "../constants.mjs";

export function matchesDisposition(sourceToken, targetToken, required) {
  if (required === DISPOSITIONS.ANY) return true;
  const rel = sourceToken.disposition * targetToken.disposition;
  if (required === DISPOSITIONS.FRIENDLY) return rel > 0;
  if (required === DISPOSITIONS.HOSTILE) return rel < 0;
  return true;
}

export function canTriggerOn(effect, trigger) {
  const mode = effect.system.onEnterTrigger ?? "both";
  return (mode === "both") || (mode === trigger);
}

export function passesScript(sourceToken, targetToken, effect) {
  const script = effect.system.onEnterScript?.trim();
  if (!script) return true;
  try {
    return Function(
      "actor",
      "token",
      "sourceToken",
      "rollData",
      `return Boolean(${script});`
    ).call(
      null,
      targetToken.actor,
      targetToken.object ?? targetToken,
      sourceToken.object ?? sourceToken,
      targetToken.actor?.getRollData?.() ?? {}
    );
  } catch (error) {
    console.error(`Aura Effects | onEnterScript error for "${effect.name}":`, error);
    return true;
  }
}
