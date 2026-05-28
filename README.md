# Aura Effects

Aura Effects adds aura Active Effects for Foundry VTT v13. An aura can apply normal effect changes, token status effects, and optional on-enter outcomes such as healing, damage, saving throws, and dnd5e conditions.

Install manifest:

```text
https://github.com/MrMikki-boop/auraeffects/releases/latest/download/module.json
```

## On-Enter Effects

Open an aura Active Effect and use the **Aura** tab.

| Setting | What it does |
| --- | --- |
| Enable on-enter effects | Enables the reactive aura outcomes. |
| Trigger | Runs on movement, turn start, or both. |
| Targets | Limits which token dispositions can trigger the aura. |
| Apply to self | Lets turn-start auras affect the source token. |
| Uses | Optional maximum uses before the aura stops firing. |
| Script | Optional condition checked before outcomes run. |

### Healing And Damage

Healing and damage use formulas such as `1d6`, `2d8+@abilities.wis.mod`, or fixed values.

For dnd5e, damage uses the selected damage type and goes through the system damage API, so resistance and immunity handling stays consistent with dnd5e.

### Saving Throws

Saving throw mode has two options:

| Mode | Behavior |
| --- | --- |
| Prompt | Posts a compact chat card with a dnd5e save button and manual success/failure outcome buttons. |
| Automatic | Rolls the dnd5e saving throw immediately and applies the matching outcome. |

Failure and success can each apply multiple Foundry status effects. Failure can also apply legacy custom Active Effect UUIDs for older worlds.

Save damage can be applied on failure, with optional half damage on success.

### Status Duration

| Duration | Behavior |
| --- | --- |
| Manual | Applied status remains until removed normally. |
| Rounds | Status is removed after the configured number of rounds. |
| Until turn start | Status is removed at the start of the target's next turn. |
| Until turn end | Status is removed at the end of the target's next turn. |
| While in aura | Status is removed when the target leaves the aura or the source aura is removed/disabled. |

Repeat save at end of turn lets dnd5e targets retry the same save. On success, Aura Effects removes statuses owned by that aura.

### dnd5e Condition Immunity

When the target has dnd5e condition immunity for a selected status, Aura Effects does not apply that status and reports the immunity in chat. Other outcomes from the same aura can still apply.

## Testing

Aura Effects includes an optional Quench batch:

```text
Aura Effects: On-Enter Smoke
```

Install and enable the Quench module first, then reload the world. Run the batch from the Quench UI, or from the browser console:

```js
await quench.runBatches(["auraeffects.on-enter.smoke"]);
```

The batch covers:

- failure statuses apply;
- success does not apply failure statuses;
- dnd5e condition immunity blocks matching statuses;
- aura-owned statuses clean up with the source;
- movement entry damage fires once;
- turn-start damage fires once per combat turn.

Manual Foundry smoke checks still recommended:

- move a hostile token from outside into a damaging aura and verify one damage roll;
- start the target's combat turn inside a turn-start aura and verify one damage roll;
- test `While in aura` by leaving the aura and disabling/deleting the source effect;
- test repeat save at end of turn in an active combat;
- test prompt and automatic save modes with a dnd5e immune target.
