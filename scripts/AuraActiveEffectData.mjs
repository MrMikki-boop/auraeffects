import { DISPOSITIONS } from "./constants.mjs";
import { executeScript } from "./helpers.mjs";
/** @import { ActiveEffect } from "@client/documents/_module.mjs"; */

const { ArrayField, BooleanField, ColorField, JavaScriptField, NumberField, SetField, SchemaField, StringField } = foundry.data.fields;

export default class AuraActiveEffectData extends foundry.abstract.TypeDataModel {
  static LOCALIZATION_PREFIXES = ["AURAEFFECTS.ACTIVEEFFECT.Aura"];
  static defineSchema() {
    return {
      applyToSelf: new BooleanField({ initial: true }),
      bestFormula: new StringField({ initial: "" }),
      canStack: new BooleanField({ initial: false }),
      collisionTypes: new SetField(new StringField({
        choices: {
          light: "WALL.FIELDS.light.label",
          move: "WALL.FIELDS.move.label",
          sight: "WALL.FIELDS.sight.label",
          sound: "WALL.FIELDS.sound.label"
        },
        required: true,
        blank: false
      }), {
        initial: ["move"],
      }),
      color: new ColorField(),
      combatOnly: new BooleanField({ initial: false }),
      disableOnHidden: new BooleanField({ initial: true }),
      distanceFormula: new StringField({ initial: "0" }),
      disposition: new NumberField({
        initial: DISPOSITIONS.ANY,
        choices: {
          [DISPOSITIONS.HOSTILE]: "AURAEFFECTS.ACTIVEEFFECT.Aura.FIELDS.disposition.Choices.Hostile",
          [DISPOSITIONS.ANY]: "AURAEFFECTS.ACTIVEEFFECT.Aura.FIELDS.disposition.Choices.Any",
          [DISPOSITIONS.FRIENDLY]: "AURAEFFECTS.ACTIVEEFFECT.Aura.FIELDS.disposition.Choices.Friendly"
        }
      }),
      evaluatePreApply: new BooleanField({ initial: false }),
      opacity: new NumberField({
        min: 0,
        max: 1,
        step: 0.05,
        initial: 0.25
      }),
      overrideName: new StringField({ initial: '' }),
      script: new JavaScriptField(),
      stashedChanges: new ArrayField(new SchemaField({
        key: new StringField(),
        value: new StringField(),
        mode: new NumberField(),
        priority: new NumberField()
      })),
      stashedStatuses: new SetField(new StringField()),
      showRadius: new BooleanField({ initial: false }),

      // --- On-Enter Effect fields ---
      onEnterFormula: new StringField({ initial: "" }),
      onEnterEnabled: new BooleanField({ initial: false }),
      onEnterHealType: new StringField({
        initial: "hp",
        choices: {
          hp: "AURAEFFECTS.ACTIVEEFFECT.Aura.FIELDS.onEnterHealType.Choices.hp",
          temp: "AURAEFFECTS.ACTIVEEFFECT.Aura.FIELDS.onEnterHealType.Choices.temp"
        }
      }),
      // Default FRIENDLY so Healing Spirit works out of the box
      onEnterDisposition: new NumberField({
        initial: DISPOSITIONS.FRIENDLY,
        choices: {
          [DISPOSITIONS.HOSTILE]: "AURAEFFECTS.ACTIVEEFFECT.Aura.FIELDS.disposition.Choices.Hostile",
          [DISPOSITIONS.ANY]: "AURAEFFECTS.ACTIVEEFFECT.Aura.FIELDS.disposition.Choices.Any",
          [DISPOSITIONS.FRIENDLY]: "AURAEFFECTS.ACTIVEEFFECT.Aura.FIELDS.disposition.Choices.Friendly"
        }
      }),
      onEnterUsesMax: new StringField({ initial: "" }),
      // -1 = uninitialised (treated as full). Actual decrement happens in onEnterHealing.mjs.
      onEnterUsesRemaining: new NumberField({ initial: -1, integer: true }),
      onEnterScript: new JavaScriptField(),
      // Whether the aura source token itself can receive the on-enter heal on its own turn
      onEnterApplyToSelf: new BooleanField({ initial: false })
    }
  }

  get isSuppressed() {
    if (this.combatOnly && !game.combat?.active) return true;
    if (this.disableOnHidden) {
      let actor = this.parent.parent;
      if (actor instanceof Item) actor = actor.actor;
      if (actor?.getActiveTokens(false, true)[0]?.hidden) return true;
    }
    return false;
  }

  get distance() {
    return new Roll(this.distanceFormula || "0", this.parent.parent?.getRollData?.()).evaluateSync({ strict: false }).total;
  }

  get hasOnEnterEffect() {
    return this.onEnterEnabled && !!this.onEnterFormula?.trim();
  }

  get maxUses() {
    if (!this.onEnterUsesMax?.trim()) return Infinity;
    const actor = this.parent.parent instanceof Item
      ? this.parent.parent.actor
      : this.parent.parent;
    return new Roll(this.onEnterUsesMax, actor?.getRollData?.() ?? {}).evaluateSync({ strict: false }).total;
  }

  /**
   * -1 means "never written yet" → treat as fully charged (maxUses).
   * No DB write here — writes happen only when a use is consumed.
   */
  get remainingUses() {
    if (!this.onEnterUsesMax?.trim()) return Infinity;
    if (this.onEnterUsesRemaining < 0) return this.maxUses;
    return this.onEnterUsesRemaining;
  }

  prepareDerivedData() {
    // IMPORTANT: no DB writes here — called too frequently, causes update loops.
    let actor = this.parent.parent;
    if (actor instanceof Item) actor = actor.actor;
    if (!this.applyToSelf) {
      this.stashedChanges = this.parent.changes;
      this.stashedStatuses = this.parent.statuses;
      this.parent.changes = [];
      this.parent.statuses = new Set();
    } else {
      const token = actor?.getActiveTokens(false, true)[0];
      if (token) {
        const deltaPrepped = !actor.isToken || Object.getOwnPropertyDescriptor(token, "delta")?.value;
        if (deltaPrepped && !executeScript(token, token, this.parent)) {
          this.stashedChanges = this.parent.changes;
          this.stashedStatuses = this.parent.statuses;
          this.parent.changes = [];
          this.parent.statuses = new Set();
        } else {
          if (this.stashedChanges?.length) this.parent.changes = this.stashedChanges;
          if (this.stashedStatuses?.size) this.parent.statuses = this.stashedStatuses;
        }
      }
    }
    if (!this.canStack) {
      const nameMatch = this.overrideName || this.parent.name;
      const existing = actor?.appliedEffects.find(e => e.flags?.auraeffects?.fromAura && e.name === nameMatch);
      if (existing) {
        this.stashedChanges = this.parent.changes;
        this.stashedStatuses = this.parent.statuses;
        this.parent.changes = [];
        this.parent.statuses = new Set();
      }
    }
  }
}
