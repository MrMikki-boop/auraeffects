function escapeHTML(value) {
  return String(value ?? "").replace(/[&<>"']/g, match => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    "\"": "&quot;",
    "'": "&#39;"
  }[match]));
}

function renderOutcomeRow(outcome, labels) {
  if (!labels.length) return "";
  const labelKey = outcome === "success" ? "AURAEFFECTS.OnEnter.SuccessOutcome" : "AURAEFFECTS.OnEnter.FailureOutcome";
  const actionKey = outcome === "success" ? "AURAEFFECTS.OnEnter.ApplySuccessOutcomes" : "AURAEFFECTS.OnEnter.ApplyFailOutcomes";
  const icon = outcome === "success" ? "fa-check" : "fa-xmark";
  const summary = labels.join(", ");
  return `
    <div class="auraeffects-save-outcome" data-auraeffects-outcome-row="${outcome}">
      <div class="auraeffects-save-outcome-text">
        <span class="auraeffects-save-outcome-summary">${escapeHTML(summary)}</span>
      </div>
      <button type="button" class="auraeffects-save-outcome-button" data-auraeffects-save-outcome="${outcome}" data-tooltip="${escapeHTML(summary)}" aria-label="${escapeHTML(game.i18n.localize(actionKey))}">
        <i class="fa-solid ${icon}"></i>
        <span>${escapeHTML(game.i18n.localize(labelKey))}</span>
      </button>
    </div>
  `;
}

export function renderSavePromptCard({ sourceEffect, targetActor, enriched, failOutcomeLabels, successOutcomeLabels }) {
  return `
    <div class="auraeffects-save-card dnd5e2">
      <header class="auraeffects-save-card-header">
        <strong>${escapeHTML(sourceEffect.name)}</strong>
        <span>${escapeHTML(targetActor.name)}</span>
      </header>
      <div class="auraeffects-save-request">
        ${enriched}
      </div>
      <div class="auraeffects-save-outcomes">
        ${renderOutcomeRow("failure", failOutcomeLabels)}
        ${renderOutcomeRow("success", successOutcomeLabels)}
      </div>
    </div>
  `;
}

export async function notifyImmuneStatuses(targetActor, sourceEffect, statuses) {
  if (!statuses.length) return;
  await ChatMessage.create({
    speaker: ChatMessage.getSpeaker(),
    content: game.i18n.format("AURAEFFECTS.OnEnter.StatusImmune", {
      effect: sourceEffect.name,
      actor: targetActor.name,
      statuses: statuses.join(", ")
    })
  });
}

export async function notifyUnsupportedStatuses(targetActor, sourceEffect, statuses) {
  if (!statuses.length) return;
  await ChatMessage.create({
    speaker: ChatMessage.getSpeaker(),
    content: game.i18n.format("AURAEFFECTS.OnEnter.StatusUnsupported", {
      effect: sourceEffect.name,
      actor: targetActor.name,
      statuses: statuses.join(", ")
    })
  });
}

export async function notifyRepeatSaveRemoved(actor, status, sourceEffect) {
  await ChatMessage.create({
    speaker: ChatMessage.getSpeaker({ actor }),
    content: game.i18n.format("AURAEFFECTS.OnEnter.RepeatSaveRemoved", {
      actor: actor.name,
      status,
      effect: sourceEffect.name
    })
  });
}

export function registerSaveOutcomeChatHook(applyOnEnterSaveOutcome) {
  Hooks.on("renderChatMessageHTML", (message, html) => {
    const outcomeButtonSelector = "[data-auraeffects-save-outcome], [data-auraeffects-apply-fail-outcomes]";
    for (const button of html.querySelectorAll(outcomeButtonSelector)) {
      button.addEventListener("click", async event => {
        event.preventDefault();
        button.disabled = true;

        const data = message.getFlag("auraeffects", "onEnterFail");
        const outcome = button.dataset.auraeffectsSaveOutcome ?? "failure";
        const activeGM = game.users.activeGM;
        if (!data || (!game.user.isGM && !activeGM)) {
          ui.notifications.warn("AURAEFFECTS.NoActiveGM", { localize: true });
          button.disabled = false;
          return;
        }

        const applied = game.user.isGM
          ? await applyOnEnterSaveOutcome({ ...data, outcome })
          : await activeGM.query("auraeffects.applyOnEnterSaveOutcome", { ...data, outcome });

        if (applied) {
          for (const otherButton of html.querySelectorAll(outcomeButtonSelector)) {
            if (otherButton !== button) otherButton.disabled = true;
          }
          const row = button.closest("[data-auraeffects-outcome-row]");
          row?.classList.add("auraeffects-save-outcome-applied");
          button.classList.add("auraeffects-save-outcome-button-applied");
          button.innerHTML = `<i class="fa-solid fa-check"></i><span>${escapeHTML(game.i18n.localize("AURAEFFECTS.OnEnter.OutcomeAppliedShort"))}</span>`;
        } else {
          button.disabled = false;
        }
      });
    }
  });
}
