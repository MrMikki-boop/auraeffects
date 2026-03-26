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
      onEnterEnabled: new BooleanField({ initial: false }),
      onEnterDisposition: new NumberField({
        initial: DISPOSITIONS.FRIENDLY,
        choices: {
          [DISPOSITIONS.HOSTILE]: "AURAEFFECTS.ACTIVEEFFECT.Aura.FIELDS.disposition.Choices.Hostile",
          [DISPOSITIONS.ANY]: "AURAEFFECTS.ACTIVEEFFECT.Aura.FIELDS.disposition.Choices.Any",
          [DISPOSITIONS.FRIENDLY]: "AURAEFFECTS.ACTIVEEFFECT.Aura.FIELDS.disposition.Choices.Friendly"
        }
      }),
      onEnterUsesMax: new StringField({ initial: "" }),
      onEnterUsesRemaining: new NumberField({ initial: -1, integer: true }),
      onEnterScript: new JavaScriptField(),
      onEnterApplyToSelf: new BooleanField({ initial: false }),

      // Healing
      onEnterHealEnabled: new BooleanField({ initial: false }),
      onEnterHealFormula: new StringField({ initial: "" }),
      onEnterHealType: new StringField({
        initial: "hp",
        choices: {
          hp: "AURAEFFECTS.ACTIVEEFFECT.Aura.FIELDS.onEnterHealType.Choices.hp",
          temp: "AURAEFFECTS.ACTIVEEFFECT.Aura.FIELDS.onEnterHealType.Choices.temp"
        }
      }),

      // Damage
      onEnterDmgEnabled: new BooleanField({ initial: false }),
      onEnterDmgFormula: new StringField({ initial: "" }),
      onEnterDmgType: new StringField({
        initial: "fire",
        choices: {
          acid: "DND5E.DamageAcid", bludgeoning: "DND5E.DamageBludgeoning",
          cold: "DND5E.DamageCold", fire: "DND5E.DamageFire",
          force: "DND5E.DamageForce", lightning: "DND5E.DamageLightning",
          necrotic: "DND5E.DamageNecrotic", piercing: "DND5E.DamagePiercing",
          poison: "DND5E.DamagePoison", psychic: "DND5E.DamagePsychic",
          radiant: "DND5E.DamageRadiant", slashing: "DND5E.DamageSlashing",
          thunder: "DND5E.DamageThunder"
        }
      }),

      // Saving throw
      onEnterSaveEnabled: new BooleanField({ initial: false }),
      onEnterSaveAbility: new StringField({
        initial: "con",
        choices: {
          str: "DND5E.AbilityStr", dex: "DND5E.AbilityDex", con: "DND5E.AbilityCon",
          int: "DND5E.AbilityInt", wis: "DND5E.AbilityWis", cha: "DND5E.AbilityCha"
        }
      }),
      onEnterSaveDC: new StringField({ initial: "8+@prof+@abilities.con.mod" }),
      onEnterSaveFailEffect: new StringField({ initial: "" }),
      onEnterDmgDisposition: new NumberField({
        initial: DISPOSITIONS.HOSTILE,
        choices: {
          [DISPOSITIONS.HOSTILE]: "AURAEFFECTS.ACTIVEEFFECT.Aura.FIELDS.disposition.Choices.Hostile",
          [DISPOSITIONS.ANY]: "AURAEFFECTS.ACTIVEEFFECT.Aura.FIELDS.disposition.Choices.Any",
          [DISPOSITIONS.FRIENDLY]: "AURAEFFECTS.ACTIVEEFFECT.Aura.FIELDS.disposition.Choices.Friendly"
        }
      }),
      onEnterSaveDisposition: new NumberField({
        initial: DISPOSITIONS.HOSTILE,
        choices: {
          [DISPOSITIONS.HOSTILE]: "AURAEFFECTS.ACTIVEEFFECT.Aura.FIELDS.disposition.Choices.Hostile",
          [DISPOSITIONS.ANY]: "AURAEFFECTS.ACTIVEEFFECT.Aura.FIELDS.disposition.Choices.Any",
          [DISPOSITIONS.FRIENDLY]: "AURAEFFECTS.ACTIVEEFFECT.Aura.FIELDS.disposition.Choices.Friendly"
        }
      })
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
    return this.onEnterEnabled && (
      (this.onEnterHealEnabled && !!this.onEnterHealFormula?.trim()) ||
      (this.onEnterDmgEnabled  && !!this.onEnterDmgFormula?.trim()) ||
      this.onEnterSaveEnabled
    );
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
