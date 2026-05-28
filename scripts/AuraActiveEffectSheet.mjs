import { getExtendedParts, getExtendedTabs } from "./helpers.mjs";
/** @import ActiveEffectConfig from "@client/applications/sheets/active-effect-config.mjs"; */

function getStatusEffects() {
  const statusEffects = CONFIG.statusEffects ?? [];
  return Array.isArray(statusEffects) ? statusEffects : Object.values(statusEffects);
}

function getStatusEffectLabel(status) {
  return game.i18n.localize(status.name ?? status.label ?? status.id);
}

function getStatusEffect(statusId) {
  return getStatusEffects().find(status => status?.id === statusId);
}

function getStatusContext(auraEffect, fieldName, { includeLegacy = false } = {}) {
  const selected = new Set(auraEffect.system[fieldName] ?? []);
  const current = auraEffect.system.onEnterSaveFailEffect?.trim();

  if (includeLegacy && current && getStatusEffect(current)) selected.add(current);

  const statuses = getStatusEffects()
    .filter(status => status?.id && ((status.hud !== false) || selected.has(status.id)))
    .map(status => ({
      id: status.id,
      img: status.img,
      label: getStatusEffectLabel(status),
      selected: selected.has(status.id)
    }))
    .sort((a, b) => a.label.localeCompare(b.label, game.i18n.lang));

  return {
    statuses,
    legacy: includeLegacy && current && !getStatusEffect(current)
      ? {
        uuid: current,
        label: game.i18n.format("AURAEFFECTS.OnEnter.CustomFailEffect", { uuid: current })
      }
      : null
  };
}

/**
 * Extend an Active Effect Config sheet to include the Aura Effects tab & logic
 * @param {typeof ActiveEffectConfig} ActiveEffectSheet An existing Active Effect Config sheet class
 * @returns The extended sheet
 */
export default function AuraActiveEffectSheetMixin(ActiveEffectSheet) {
  return class AuraActiveEffectSheet extends ActiveEffectSheet {
    static PARTS = getExtendedParts(super.PARTS);
  
    static TABS = getExtendedTabs(super.TABS);
  
    static DEFAULT_OPTIONS = {
      actions: {
        revert: AuraActiveEffectSheet.#onRevert,
        resetUses: AuraActiveEffectSheet.#onResetUses
      }
    };
  
    async _preparePartContext(id, context) {
      context = await super._preparePartContext(id, context);
      if (id === "aura") {
        const failStatusContext = getStatusContext(this.document, "onEnterSaveFailStatuses", { includeLegacy: true });
        const successStatusContext = getStatusContext(this.document, "onEnterSaveSuccessStatuses");
        context = foundry.utils.mergeObject(context, {
          fields: this.document.system.schema.fields,
          failStatuses: failStatusContext.statuses,
          successStatuses: successStatusContext.statuses,
          legacyFailEffect: failStatusContext.legacy,
          isDAEEnabled: game.modules.get("dae")?.active
        }, { inplace: false });
      }
      return context;
    };

    async _onRender(context, options) {
      await super._onRender?.(context, options);
      AuraActiveEffectSheet.#bindVisibilityToggles(this.element);
    }

    static #bindVisibilityToggles(element) {
      const root = element?.querySelector?.(".auraeffects-config");
      if (!root) return;

      const updateSection = (fieldName) => {
        const input = root.querySelector(`[name="system.${fieldName}"]`);
        const section = root.querySelector(`[data-auraeffects-section="${fieldName}"]`);
        if (section) section.hidden = !input?.checked;
      };

      const updateAll = () => {
        for (const fieldName of ["onEnterEnabled", "onEnterHealEnabled", "onEnterDmgEnabled", "onEnterSaveEnabled"]) {
          updateSection(fieldName);
        }
        const statusDuration = root.querySelector("[name='system.onEnterSaveStatusDuration']");
        const statusRounds = root.querySelector("[data-auraeffects-status-rounds]");
        if (statusRounds) statusRounds.hidden = statusDuration?.value !== "rounds";
      };

      for (const input of root.querySelectorAll("[name='system.onEnterEnabled'], [name='system.onEnterHealEnabled'], [name='system.onEnterDmgEnabled'], [name='system.onEnterSaveEnabled']")) {
        input.addEventListener("change", updateAll);
      }
      root.querySelector("[name='system.onEnterSaveStatusDuration']")?.addEventListener("change", updateAll);
      updateAll();
    }

    _processFormData(event, form, formData) {
      const updates = super._processFormData(event, form, formData);
      const root = form?.querySelector?.(".auraeffects-config");
      if (!root) return updates;

      for (const fieldName of ["onEnterSaveFailStatuses", "onEnterSaveSuccessStatuses"]) {
        if (!root.querySelector(`[name='system.${fieldName}']`)) continue;
        const statuses = foundry.utils.getProperty(updates, `system.${fieldName}`);
        const normalizedStatuses = statuses === undefined
          ? []
          : Array.isArray(statuses)
            ? statuses
            : [statuses];
        foundry.utils.setProperty(updates, `system.${fieldName}`, normalizedStatuses);
      }

      const legacyInput = root.querySelector("[data-auraeffects-legacy-fail-effect]");
      const legacyValue = legacyInput?.checked ? legacyInput.value : "";
      foundry.utils.setProperty(updates, "system.onEnterSaveFailEffect", legacyValue);

      return updates;
    }
  
    static #onRevert() {
      const updates = this._processFormData(null, this.form, new foundry.applications.ux.FormDataExtended(this.form));
      if (foundry.utils.getType(updates.changes) !== "Array") updates.changes = Object.values(updates.changes ?? {});
      updates.type = this.document.getFlag("auraeffects", "originalType") ?? "base";
      foundry.utils.setProperty(updates, "flags.-=auraeffects", null);
      updates["==system"] = {};
      this.document.update(updates);
    }

    /**
     * Reset the onEnter uses counter back to the maximum (re-evaluating the formula).
     */
    static #onResetUses() {
      const sys = this.document.system;
      if (!sys.onEnterUsesMax?.trim()) return;
      const actor = this.document.parent instanceof Actor
        ? this.document.parent
        : this.document.parent?.parent;
      const max = new Roll(sys.onEnterUsesMax, actor?.getRollData?.() ?? {}).evaluateSync({ strict: false }).total;
      this.document.update({ "system.onEnterUsesRemaining": max });
    }
  }
}
