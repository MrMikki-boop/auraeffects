/**
 * onEnterHealing.mjs
 * On-enter effects: heal / damage (with resistances) / saving throw (auto-rolled per token).
 *
 * IN COMBAT:  once per [round+turn+tokenId+effectId], cleared on turn change.
 * OUT OF COMBAT: once per movement segment (500ms cooldown per tokenId+effectId).
 */

import {getAllAuraEffects, getNearbyTokens, getTokenToTokenDistance} from "./helpers.mjs";
import {DISPOSITIONS} from "./constants.mjs";

// ─── Dedup ───────────────────────────────────────────────────────────────────

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

// Pending save fails: when a save button is clicked and fails, apply the effect
const pendingSaveFails = new Map();

// Hook into dnd5e save roll to detect failures
Hooks.on("dnd5e.rollAbilitySaveV2", async (rolls, data) => {
    const token = data.subject?.token;
    if (!token) return;
    // Find any pending fail entries for this token
    for (const [key, entry] of pendingSaveFails) {
        if (!key.startsWith(token.id)) continue;
        if (rolls[0]?.total < entry.dc) {
            pendingSaveFails.delete(key);
            const actor = await fromUuid(entry.targetActorUuid);
            if (actor) await applyFailEffect(actor, entry.effectRef, entry.sourceEffect);
        } else {
            pendingSaveFails.delete(key);
        }
    }
});

// ─── Disposition helpers ──────────────────────────────────────────────────────

function matchesDisposition(sourceToken, targetToken, required) {
    if (required === DISPOSITIONS.ANY) return true;
    const rel = sourceToken.disposition * targetToken.disposition;
    if (required === DISPOSITIONS.FRIENDLY) return rel > 0;
    if (required === DISPOSITIONS.HOSTILE) return rel < 0;
    return true;
}

// ─── Script filter ────────────────────────────────────────────────────────────

function passesScript(sourceToken, targetToken, effect) {
    const script = effect.system.onEnterScript?.trim();
    if (!script) return true;
    try {
        return Function("actor", "token", "sourceToken", "rollData",
            `return Boolean(${script});`
        ).call(null, targetToken.actor,
            targetToken.object ?? targetToken,
            sourceToken.object ?? sourceToken,
            targetToken.actor?.getRollData?.() ?? {});
    } catch (e) {
        console.error(`Aura Effects | onEnterScript error for "${effect.name}":`, e);
        return true;
    }
}

// ─── HP helpers ───────────────────────────────────────────────────────────────

async function applyHP(actor, amount) {
    if (game.system.id === "dnd5e" && typeof actor.applyDamage === "function")
        return actor.applyDamage([{value: amount, type: "healing"}]);
    const hp = actor.system?.attributes?.hp ?? actor.system?.hp;
    if (!hp) return;
    const path = actor.system?.attributes?.hp !== undefined ? "system.attributes.hp.value" : "system.hp.value";
    return actor.update({[path]: Math.min((hp.value ?? 0) + amount, hp.max ?? Infinity)});
}

async function applyTempHP(actor, amount) {
    if (game.system.id === "dnd5e" && typeof actor.applyTempHP === "function")
        return actor.applyTempHP(amount);
    const hp = actor.system?.attributes?.hp ?? actor.system?.hp;
    if (!hp) return;
    if (amount <= (hp.temp ?? 0)) return;
    const path = actor.system?.attributes?.hp !== undefined ? "system.attributes.hp.temp" : "system.hp.temp";
    return actor.update({[path]: amount});
}

// ─── Apply effect by UUID on save fail ───────────────────────────────────────

async function applyFailEffect(targetActor, effectRef, sourceEffect) {
    let effectData = null;
    try {
        const found = await fromUuid(effectRef);
        if (found instanceof ActiveEffect) effectData = found.toObject();
    } catch (_) {
    }

    if (!effectData) {
        // UUID didn't resolve — post fallback message
        await ChatMessage.create({
            speaker: ChatMessage.getSpeaker(),
            content: `<strong>${sourceEffect.name}</strong>: ${targetActor.name} провалил спасбросок — применить эффект: <em>${effectRef}</em>`
        });
        return;
    }

    foundry.utils.mergeObject(effectData, {
        origin: sourceEffect.uuid,
        transfer: false,
        "flags.auraeffects.fromSaveFail": true
    });
    await targetActor.createEmbeddedDocuments("ActiveEffect", [effectData]);
}

// ─── Core: apply all enabled effects to one target ───────────────────────────

async function applyOnEnterEffect(sourceEffect, targetActor, sourceToken, targetToken) {
    const sys = sourceEffect.system;
    if (!sys.hasOnEnterEffect) return;

    const remaining = sys.remainingUses;
    if (remaining <= 0) return;

    const sourceRollData = sourceEffect.parent?.getRollData?.() ?? {};
    let usedAUse = false;

    // ── 1. Healing ── (uses onEnterDisposition, already checked upstream)
    if (sys.onEnterHealEnabled && sys.onEnterHealFormula?.trim()) {
        const roll = await new Roll(sys.onEnterHealFormula, sourceRollData).evaluate();
        const label = sys.onEnterHealType === "temp"
            ? game.i18n.localize("AURAEFFECTS.ACTIVEEFFECT.Aura.FIELDS.onEnterHealType.Choices.temp")
            : game.i18n.localize("AURAEFFECTS.ACTIVEEFFECT.Aura.FIELDS.onEnterHealType.Choices.hp");
        await roll.toMessage({
            speaker: ChatMessage.getSpeaker({token: sourceToken}),
            flavor: `${sourceEffect.name} → ${targetActor.name} (${label})`
        });
        if (sys.onEnterHealType === "temp") await applyTempHP(targetActor, roll.total);
        else await applyHP(targetActor, roll.total);
        usedAUse = true;
    }

    // ── 2. Damage ── (own disposition filter)
    if (sys.onEnterDmgEnabled && sys.onEnterDmgFormula?.trim()
        && matchesDisposition(sourceToken, targetToken, sys.onEnterDmgDisposition)) {
        const roll = await new Roll(sys.onEnterDmgFormula, sourceRollData).evaluate();
        await roll.toMessage({
            speaker: ChatMessage.getSpeaker({token: sourceToken}),
            flavor: `${sourceEffect.name} → ${targetActor.name} (${sys.onEnterDmgType})`
        });
        if (game.system.id === "dnd5e" && typeof targetActor.applyDamage === "function") {
            await targetActor.applyDamage([{value: roll.total, type: sys.onEnterDmgType}]);
        } else {
            const hp = targetActor.system?.attributes?.hp ?? targetActor.system?.hp;
            if (hp) {
                const path = targetActor.system?.attributes?.hp !== undefined ? "system.attributes.hp.value" : "system.hp.value";
                await targetActor.update({[path]: Math.max(0, (hp.value ?? 0) - roll.total)});
            }
        }
        usedAUse = true;
    }

    // ── 3. Saving throw ──
    if (sys.onEnterSaveEnabled
        && matchesDisposition(sourceToken, targetToken, sys.onEnterSaveDisposition)) {
        const dc = Math.round(
            new Roll(sys.onEnterSaveDC || "8", sourceRollData).evaluateSync({strict: false}).total
        );

        if (game.system.id === "dnd5e") {
            // Generates the native dnd5e save button — identical to spell cards
            const enriched = await TextEditor.enrichHTML(
                `[[/save ${sys.onEnterSaveAbility} ${dc}]]`,
                {async: true}
            );
            await ChatMessage.create({
                speaker: ChatMessage.getSpeaker({token: sourceToken}),
                content: `<strong>${sourceEffect.name}</strong> → <strong>${targetActor.name}</strong>: ${enriched}`,
                flags: {dnd5e: {targets: [{uuid: targetToken.uuid}]}}
            });

            // Auto-apply fail effect if UUID given — listen via hook since the roll
            // happens client-side when player clicks the button
            if (sys.onEnterSaveFailEffect?.trim()) {
                // Store pending fail effect keyed by target+effect so the hook can pick it up
                pendingSaveFails.set(`${targetToken.id}|${sourceEffect.id}`, {
                    targetActorUuid: targetActor.uuid,
                    effectRef: sys.onEnterSaveFailEffect.trim(),
                    dc,
                    ability: sys.onEnterSaveAbility,
                    sourceEffect
                });
            }
        } else {
            // Generic fallback for non-dnd5e systems
            await ChatMessage.create({
                speaker: ChatMessage.getSpeaker({token: sourceToken}),
                content: `<strong>${sourceEffect.name}</strong>: ${targetActor.name} — спасбросок <strong>${sys.onEnterSaveAbility.toUpperCase()} DC ${dc}</strong>`
            });
        }
        usedAUse = true;
    }

    // ── Decrement uses ──
    if (usedAUse && sys.onEnterUsesMax?.trim() && remaining !== Infinity) {
        const newRemaining = (sys.onEnterUsesRemaining < 0 ? sys.maxUses : remaining) - 1;
        await sourceEffect.update({"system.onEnterUsesRemaining": newRemaining});
        if (newRemaining <= 0)
            ui.notifications?.info(game.i18n.format("AURAEFFECTS.OnEnter.UsesExhausted", {effect: sourceEffect.name}));
    }
}

// ─── Shared tryTrigger (checks global disposition + script + dedup) ───────────

async function tryTrigger(sourceEffect, sourceToken, targetToken) {
    if (!sourceEffect.system.hasOnEnterEffect) return;
    if (!targetToken.actor) return;
    // Global disposition gate (for healing)
    if (!matchesDisposition(sourceToken, targetToken, sourceEffect.system.onEnterDisposition)) {
        // Even if healing disposition doesn't match, damage/save might — let applyOnEnterEffect decide per-section
        // So only skip entirely if ALL sections would fail the global disposition
        const sys = sourceEffect.system;
        const dmgWouldRun = sys.onEnterDmgEnabled && matchesDisposition(sourceToken, targetToken, sys.onEnterDmgDisposition);
        const saveWouldRun = sys.onEnterSaveEnabled && matchesDisposition(sourceToken, targetToken, sys.onEnterSaveDisposition);
        if (!dmgWouldRun && !saveWouldRun) return;
    }
    if (!passesScript(sourceToken, targetToken, sourceEffect)) return;
    if (isDuplicate(sourceEffect.id, targetToken.id)) return;
    await applyOnEnterEffect(sourceEffect, targetToken.actor, sourceToken, targetToken);
}

// ─── Move trigger ─────────────────────────────────────────────────────────────

export async function checkOnEnterForMovingToken(token, origin) {
    if (!token.actor) return;
    if (!game.users.activeGM || game.user !== game.users.activeGM) return;

    // Token walked INTO someone else's aura
    for (const sourceToken of token.parent.tokens) {
        if (sourceToken === token) continue;
        if (!sourceToken.actor) continue;
        const [activeEffects] = getAllAuraEffects(sourceToken.actor);
        for (const effect of activeEffects) {
            if (!effect.system.hasOnEnterEffect) continue;
            const {distance: radius, collisionTypes} = effect.system;
            if (!radius) continue;
            const distBefore = getTokenToTokenDistance(sourceToken, token, {originB: origin, collisionTypes});
            const distNow = getTokenToTokenDistance(sourceToken, token, {collisionTypes});
            if (distBefore <= radius || distNow > radius) continue;
            await tryTrigger(effect, sourceToken, token);
        }
    }

    // This token's own aura swept over others
    const [ownEffects] = getAllAuraEffects(token.actor);
    for (const effect of ownEffects) {
        if (!effect.system.hasOnEnterEffect) continue;
        const {distance: radius, collisionTypes} = effect.system;
        if (!radius) continue;
        for (const targetToken of token.parent.tokens) {
            if (targetToken === token) continue;
            if (!targetToken.actor) continue;
            const distBefore = getTokenToTokenDistance(token, targetToken, {originA: origin, collisionTypes});
            const distNow = getTokenToTokenDistance(token, targetToken, {collisionTypes});
            if (distBefore <= radius || distNow > radius) continue;
            await tryTrigger(effect, token, targetToken);
        }
    }
}

// ─── Turn-start trigger ───────────────────────────────────────────────────────

export async function checkOnTurnStartForToken(combatant) {
    if (!game.users.activeGM || game.user !== game.users.activeGM) return;
    const token = combatant.token;
    if (!token?.actor) return;

    for (const sourceToken of token.parent?.tokens ?? []) {
        if (!sourceToken.actor) continue;
        const [activeEffects] = getAllAuraEffects(sourceToken.actor);
        for (const effect of activeEffects) {
            if (!effect.system.hasOnEnterEffect) continue;
            const isSelf = sourceToken === token;
            if (isSelf) {
                if (!effect.system.onEnterApplyToSelf) continue;
                if (!passesScript(sourceToken, token, effect)) continue;
                if (isDuplicate(effect.id, token.id)) continue;
                await applyOnEnterEffect(effect, token.actor, sourceToken, token);
                continue;
            }
            const dist = getTokenToTokenDistance(sourceToken, token, {collisionTypes: effect.system.collisionTypes});
            if (dist > effect.system.distance) continue;
            await tryTrigger(effect, sourceToken, token);
        }
    }
}

// ─── Hook registration ────────────────────────────────────────────────────────

export function registerOnEnterHooks() {
    Hooks.on("combatTurnChange", async (combat, _prior, current) => {
        inCombatTriggered.clear();
        const combatant = combat.combatants.get(current.combatantId);
        if (combatant) await checkOnTurnStartForToken(combatant);
    });
}
