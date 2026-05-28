import { cleanupStatusesForSourceEffect } from "../onEnter/duration.mjs";
import { applyOnEnterSaveOutcome } from "../onEnter/outcomes.mjs";
import { checkOnEnterForMovingToken, checkOnTurnStartForToken } from "../onEnter/triggers.mjs";

Hooks.on("quenchReady", quench => {
  quench.registerBatch("auraeffects.on-enter.smoke", context => {
    const { describe, it, before, after, expect } = context;

    const created = [];
    const createdCombats = [];
    const createdScenes = [];

    async function createActor(name, system = {}) {
      const actor = await Actor.create({ name, type: "npc", system });
      created.push(actor);
      return actor;
    }

    async function createAuraEffect(actor, system = {}) {
      const [effect] = await actor.createEmbeddedDocuments("ActiveEffect", [{
        name: "Aura Effects Smoke Aura",
        type: "auraeffects.aura",
        system: foundry.utils.mergeObject({
          onEnterEnabled: true,
          onEnterSaveEnabled: true,
          onEnterSaveFailStatuses: ["poisoned"],
          onEnterSaveSuccessStatuses: [],
          onEnterSaveStatusDuration: "manual",
          onEnterSaveRepeatSaveEndOfTurn: false
        }, system, { inplace: false })
      }]);
      return effect;
    }

    async function createSceneWithTokens(source, target, { targetX = 100 } = {}) {
      const scene = await Scene.create({
        name: "AE Smoke Scene",
        width: 1000,
        height: 1000,
        grid: { type: CONST.GRID_TYPES.SQUARE, size: 100, distance: 5, units: "ft" }
      });
      createdScenes.push(scene);
      const [sourceToken, targetToken] = await scene.createEmbeddedDocuments("Token", [
        {
          name: source.name,
          actorId: source.id,
          actorLink: true,
          x: 0,
          y: 0,
          disposition: CONST.TOKEN_DISPOSITIONS.FRIENDLY
        },
        {
          name: target.name,
          actorId: target.id,
          actorLink: true,
          x: targetX,
          y: 0,
          disposition: CONST.TOKEN_DISPOSITIONS.HOSTILE
        }
      ]);
      return { scene, sourceToken, targetToken };
    }

    async function createCombat(scene, targetToken) {
      const combat = await Combat.create({ scene: scene.id, active: true }, { render: false });
      createdCombats.push(combat);
      await Combatant.createDocuments([{
        tokenId: targetToken.id,
        actorId: targetToken.actor.id,
        sceneId: scene.id
      }], { parent: combat });
      return combat;
    }

    function hasStatus(actor, statusId) {
      return actor.statuses?.has(statusId)
        || actor.effects.some(effect => effect.statuses?.has(statusId));
    }

    async function clearStatus(actor, statusId) {
      const effects = actor.effects.filter(effect => effect.statuses?.has(statusId));
      await actor.deleteEmbeddedDocuments("ActiveEffect", effects.map(effect => effect.id));
    }

    function hp(actor) {
      return actor.system.attributes.hp.value;
    }

    describe("On-enter outcomes", function() {
      before(function() {
        if (game.system.id !== "dnd5e") this.skip();
        if (!game.user.isGM) this.skip();
      });

      after(async function() {
        for (const combat of createdCombats.splice(0)) await combat.delete();
        for (const scene of createdScenes.splice(0)) await scene.delete();
        for (const actor of created.splice(0)) await actor.delete();
      });

      it("applies fail statuses on failed outcome", async function() {
        const source = await createActor("AE Smoke Source");
        const target = await createActor("AE Smoke Target");
        const aura = await createAuraEffect(source);

        const applied = await applyOnEnterSaveOutcome({
          sourceEffectUuid: aura.uuid,
          targetActorUuid: target.uuid,
          outcome: "failure"
        });

        expect(applied).to.equal(true);
        expect(hasStatus(target, "poisoned")).to.equal(true);
        await clearStatus(target, "poisoned");
      });

      it("does not apply fail statuses on successful outcome", async function() {
        const source = await createActor("AE Smoke Source Success");
        const target = await createActor("AE Smoke Target Success");
        const aura = await createAuraEffect(source);

        const applied = await applyOnEnterSaveOutcome({
          sourceEffectUuid: aura.uuid,
          targetActorUuid: target.uuid,
          outcome: "success"
        });

        expect(applied).to.equal(false);
        expect(hasStatus(target, "poisoned")).to.equal(false);
      });

      it("does not apply statuses blocked by dnd5e condition immunity", async function() {
        const source = await createActor("AE Smoke Source Immune");
        const target = await createActor("AE Smoke Target Immune", {
          traits: { ci: { value: ["poisoned"] } }
        });
        const aura = await createAuraEffect(source);

        const applied = await applyOnEnterSaveOutcome({
          sourceEffectUuid: aura.uuid,
          targetActorUuid: target.uuid,
          outcome: "failure"
        });

        expect(applied).to.equal(true);
        expect(hasStatus(target, "poisoned")).to.equal(false);
      });

      it("removes aura-owned statuses when the source is cleaned up", async function() {
        const source = await createActor("AE Smoke Source Cleanup");
        const target = await createActor("AE Smoke Target Cleanup");
        const aura = await createAuraEffect(source, {
          onEnterSaveStatusDuration: "whileInAura"
        });

        await applyOnEnterSaveOutcome({
          sourceEffectUuid: aura.uuid,
          targetActorUuid: target.uuid,
          outcome: "failure"
        });
        expect(hasStatus(target, "poisoned")).to.equal(true);

        await cleanupStatusesForSourceEffect(aura.uuid, { tokens: [{ actor: target }] });
        expect(hasStatus(target, "poisoned")).to.equal(false);
      });

      it("movement entry damage triggers once", async function() {
        const source = await createActor("AE Smoke Move Source");
        const target = await createActor("AE Smoke Move Target", {
          attributes: { hp: { value: 20, max: 20 } }
        });
        await createAuraEffect(source, {
          onEnterTrigger: "movement",
          onEnterSaveEnabled: false,
          onEnterDmgEnabled: true,
          onEnterDmgFormula: "4",
          onEnterDmgType: "fire",
          onEnterDmgDisposition: CONST.TOKEN_DISPOSITIONS.HOSTILE,
          distanceFormula: "10",
          collisionTypes: []
        });
        const { targetToken } = await createSceneWithTokens(source, target);

        await checkOnEnterForMovingToken(targetToken, { x: 600, y: 0, elevation: 0 });
        expect(hp(target)).to.equal(16);

        await checkOnEnterForMovingToken(targetToken, { x: 600, y: 0, elevation: 0 });
        expect(hp(target)).to.equal(16);
      });

      it("turn-start damage triggers once per combat turn", async function() {
        const source = await createActor("AE Smoke Turn Source");
        const target = await createActor("AE Smoke Turn Target", {
          attributes: { hp: { value: 20, max: 20 } }
        });
        await createAuraEffect(source, {
          onEnterTrigger: "turn",
          onEnterSaveEnabled: false,
          onEnterDmgEnabled: true,
          onEnterDmgFormula: "3",
          onEnterDmgType: "fire",
          onEnterDmgDisposition: CONST.TOKEN_DISPOSITIONS.HOSTILE,
          distanceFormula: "10",
          collisionTypes: []
        });
        const { scene, targetToken } = await createSceneWithTokens(source, target);
        const combat = await createCombat(scene, targetToken);
        const combatant = combat.combatants.find(c => c.tokenId === targetToken.id);

        await checkOnTurnStartForToken(combatant);
        expect(hp(target)).to.equal(17);

        await checkOnTurnStartForToken(combatant);
        expect(hp(target)).to.equal(17);
      });
    });
  }, { displayName: "Aura Effects: On-Enter Smoke" });
});
