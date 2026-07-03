export async function migrate() {
  const sortedMigrations = Object.entries(migrations).sort((a, b) => {
    return foundry.utils.isNewerVersion(b[0], a[0]) ? -1 : 1;
  });
  const migrationVersion = game.settings.get("auraeffects", "migrationVersion");
  let existingAlert;
  for (const [version, migration] of sortedMigrations) {
    if (!foundry.utils.isNewerVersion(version, migrationVersion)) continue;
    if (migration.alert && !existingAlert) existingAlert = ui.notifications.info("AURAEFFECTS.Migrations.Beginning", { permanent: true, localize: true });
    await migration.migrateFunction();
    await game.settings.set("auraeffects", "migrationVersion", version);
  }
  if (existingAlert) {
    existingAlert.remove();
    ui.notifications.success("AURAEFFECTS.Migrations.AllCompleted", { localize: true });
  }
}

function getStatusEffect(statusId) {
  const statusEffects = CONFIG.statusEffects ?? [];
  const effects = Array.isArray(statusEffects) ? statusEffects : Object.values(statusEffects);
  return effects.find(status => status?.id === statusId);
}

async function getAuraEffectParents() {
  const syntheticActors = game.scenes
    .map(scene => scene.tokens.filter(token => token.actor?.isToken).map(token => token.actor))
    .flat();
  const worldActors = syntheticActors.concat(game.actors.contents).filter(Boolean);
  const worldItems = worldActors.flatMap(actor => actor.items.contents).concat(game.items.contents).filter(Boolean);
  const parents = new Set([...worldActors, ...worldItems]);

  const actorPacks = game.packs.filter(pack => pack.metadata.type === "Actor" && !pack.locked);
  for (const pack of actorPacks) {
    console.log("Aura Effects: migrating pack", pack.metadata.id);
    const actors = await pack.getDocuments();
    for (const actor of actors) {
      parents.add(actor);
      for (const item of actor.items.contents) parents.add(item);
    }
  }

  const itemPacks = game.packs.filter(pack => pack.metadata.type === "Item" && !pack.locked);
  for (const pack of itemPacks) {
    console.log("Aura Effects: migrating pack", pack.metadata.id);
    const items = await pack.getDocuments();
    for (const item of items) parents.add(item);
  }

  return parents;
}

function getOnEnterOutcomeMigration(effect) {
  if (effect.type !== "auraeffects.aura") return null;

  const rawSystem = effect.toObject().system ?? {};
  const update = { _id: effect.id };
  let changed = false;

  if (!Object.hasOwn(rawSystem, "onEnterSaveFailStatuses")) {
    update["system.onEnterSaveFailStatuses"] = [];
    changed = true;
  }
  if (!Object.hasOwn(rawSystem, "onEnterSaveSuccessStatuses")) {
    update["system.onEnterSaveSuccessStatuses"] = [];
    changed = true;
  }
  if (!Object.hasOwn(rawSystem, "onEnterSaveStatusDuration")) {
    update["system.onEnterSaveStatusDuration"] = "manual";
    changed = true;
  }
  if (!Object.hasOwn(rawSystem, "onEnterSaveStatusRounds")) {
    update["system.onEnterSaveStatusRounds"] = 1;
    changed = true;
  }
  if (!Object.hasOwn(rawSystem, "onEnterSaveRepeatSaveEndOfTurn")) {
    update["system.onEnterSaveRepeatSaveEndOfTurn"] = false;
    changed = true;
  }

  const legacy = effect.system.onEnterSaveFailEffect?.trim();
  if (!legacy || !getStatusEffect(legacy)) return changed ? update : null;

  const statuses = new Set(effect.system.onEnterSaveFailStatuses ?? []);
  statuses.add(legacy);
  update["system.onEnterSaveFailStatuses"] = Array.from(statuses);
  update["system.onEnterSaveFailEffect"] = "";
  return update;
}

async function migrateOnEnterOutcomes() {
  for (const parent of await getAuraEffectParents()) {
    const updates = parent.effects
      .map(getOnEnterOutcomeMigration)
      .filter(Boolean);
    if (!updates.length) continue;
    try {
      await parent.updateEmbeddedDocuments("ActiveEffect", updates);
    } catch (error) {
      console.error(`Aura Effects | Failed to migrate aura effects on ${parent.uuid ?? parent.name}`, error);
    }
  }
}

const migrations = {
  "1.0.0": {
    alert: false,
    migrateFunction: async () => {
      ChatMessage.create({
        speaker: {
          alias: "Aura Effects"
        },
        whisper: [game.user],
        content: game.i18n.localize("AURAEFFECTS.Migrations.ActiveAurasChatMessage")
      })
    }
  },
  "1.5.0": {
    alert: true,
    migrateFunction: migrateOnEnterOutcomes
  }
}
