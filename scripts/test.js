// ============================================================
// ПЕПЕРБОКС — Foundry v13
// Урон: 1d4 × 3 | Дистанция: 30/90 | Осечка: ≤3
// ============================================================

// === АКТЁР И ЦЕЛИ ===
const token = canvas.tokens.controlled[0];
const actor = token?.actor;
if (!actor || !token) return ui.notifications.warn("Выбери свой токен!");
let targets = Array.from(game.user.targets);
if (!targets.length) return ui.notifications.warn("Выбери хотя бы одну цель!");

const MAX_SHOTS     = 3;
const MISFIRE       = 3;
const RANGE_NORMAL  = 30;
const RANGE_MAX     = 90;
const critThreshold = actor.getFlag("dnd5e", "weaponCriticalThreshold") ?? 20;

let disadvantageNext = false;
let weaponJammed     = false;
let ashUsedThisTurn  = false;

// ============================================================
// 📏 ДИСТАНЦИЯ
// ============================================================
function getDistance(t) {
    if (typeof MidiQOL !== "undefined" && MidiQOL.computeDistance) {
        return Math.round(MidiQOL.computeDistance(token, t));
    }
    return Math.round(canvas.grid.measureDistance(token, t));
}

// ============================================================
// 🎲 ROLL → toMessage
// Foundry v13 + Dice So Nice: НЕ вызываем showForRoll вручную.
// DSN перехватывает toMessage() через хук и сам показывает
// анимацию до появления результата в чате.
// ============================================================
async function rollAndSend(formula, rollData = {}, flavor = "") {
    const roll = await new Roll(formula, rollData).evaluate();

    // показываем только кубы, но не спамим чат
    await game.dice3d?.showForRoll(roll);

    return roll;
}

// ============================================================
// 💬 DialogV2.confirm — обёртка с rejectClose: false
// Без этого флага закрытие диалога бросает исключение
// и ломает весь async-цикл выстрелов молча.
// ============================================================
async function confirm(title, content) {
    return foundry.applications.api.DialogV2.confirm({
        window: { title },
        content,
        rejectClose: false,   // ← ключевой фикс: false вместо exception
        modal: true,
    });
}

// ============================================================
// 🎨 UI — строки целей
// ============================================================
let targetsHtml = "";
targets.forEach((t, index) => {
    const dist      = getDistance(t);
    const distColor = dist > RANGE_MAX ? "#ff4d4f" : dist > RANGE_NORMAL ? "#faad14" : "#73d13d";
    const distNote  = dist > RANGE_MAX ? " ⛔ вне дистанции" : dist > RANGE_NORMAL ? " ⚠️ помеха" : "";

    targetsHtml += `
  <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:10px;">
    <div style="display:flex; align-items:center; gap:10px;">
      <img src="${t.document.texture.src}"
           style="width:40px; height:40px; min-width:40px; object-fit:cover;
                  border-radius:6px; border:1px solid #8c5a2b; flex-shrink:0;">
      <div style="display:flex; flex-direction:column;">
        <span style="font-weight:bold;">${t.name}</span>
        <span style="font-size:11px; color:${distColor};">📏 ${dist} фт${distNote}</span>
      </div>
    </div>
    <select class="shot-select" data-index="${index}"
      ${dist > RANGE_MAX ? "disabled" : ""}
      style="background:#111; color:${dist > RANGE_MAX ? "#666" : "#fff"};
             border:1px solid #8c5a2b; border-radius:6px;
             height:28px; width:50px; text-align:center;">
      <option value="0">0</option>
      <option value="1">1</option>
      <option value="2">2</option>
      <option value="3">3</option>
    </select>
  </div>`;
});

// ============================================================
// 🎨 UI — режим броска
// ============================================================
const rollModeHtml = `
<div id="roll-mode-group" style="display:flex; gap:6px; margin-bottom:12px;">
  <label id="lbl-adv"
    style="flex:1; display:flex; flex-direction:column; align-items:center; gap:3px;
           padding:7px 4px; border-radius:8px; cursor:pointer;
           border:1px solid #3a2010; background:rgba(0,0,0,0.3);
           font-size:12px; color:#a08060;">
    <input type="radio" name="roll-mode" value="advantage" style="display:none;">
    <span style="font-size:1.3em;">🎯</span>
    <span>Преимущество</span>
  </label>
  <label id="lbl-normal"
    style="flex:1; display:flex; flex-direction:column; align-items:center; gap:3px;
           padding:7px 4px; border-radius:8px; cursor:pointer;
           border:1px solid #f4a235; background:rgba(244,162,53,0.12);
           font-size:12px; color:#f4a235;">
    <input type="radio" name="roll-mode" value="normal" checked style="display:none;">
    <span style="font-size:1.3em;">🎲</span>
    <span>Обычный</span>
  </label>
  <label id="lbl-dis"
    style="flex:1; display:flex; flex-direction:column; align-items:center; gap:3px;
           padding:7px 4px; border-radius:8px; cursor:pointer;
           border:1px solid #3a2010; background:rgba(0,0,0,0.3);
           font-size:12px; color:#a08060;">
    <input type="radio" name="roll-mode" value="disadvantage" style="display:none;">
    <span style="font-size:1.3em;">⚠️</span>
    <span>Помеха</span>
  </label>
</div>`;

// ============================================================
// 🎨 UI — итоговый контент
// ============================================================
const content = `
<div style="background:linear-gradient(145deg,#0f0f0f,#1a1208);
            padding:15px; border-radius:12px;
            border:1px solid #5a3a1a; color:#f1f3f5;">
  <div style="border-bottom:1px solid #444; margin-bottom:10px; padding-bottom:5px;">
    <b>Выстрелов осталось:</b>
    <span id="shots-left" style="color:#ff922b; font-size:16px; font-weight:bold;">${MAX_SHOTS}</span>
  </div>
  ${rollModeHtml}
  ${targetsHtml}
</div>`;

// ============================================================
// 💬 Dialog V2 — основной диалог
// ============================================================
const { DialogV2 } = foundry.applications.api;

const dialogResult = await new Promise((resolve) => {
    let resolved = false;

    class PepperboxDialog extends DialogV2 {
        _onRender() {
            super._onRender();
            const el       = this.element;
            const selects  = el.querySelectorAll(".shot-select");
            const leftSpan = el.querySelector("#shots-left");

            // --- Счётчик выстрелов ---
            const updateShots = () => {
                let total = 0;
                selects.forEach(s => total += Number(s.value));
                const rem = MAX_SHOTS - total;
                leftSpan.textContent = rem;
                selects.forEach(sel => {
                    const cur = Number(sel.value);
                    for (const opt of sel.options) {
                        opt.disabled = Number(opt.value) > cur + rem;
                    }
                });
            };
            selects.forEach(s => s.addEventListener("change", updateShots));
            updateShots();

            // --- Подсветка режима броска ---
            const lbls = {
                advantage:    el.querySelector("#lbl-adv"),
                normal:       el.querySelector("#lbl-normal"),
                disadvantage: el.querySelector("#lbl-dis"),
            };
            const updateMode = () => {
                const checked = el.querySelector("input[name='roll-mode']:checked")?.value ?? "normal";
                for (const [val, lbl] of Object.entries(lbls)) {
                    lbl.style.border     = val === checked ? "1px solid #f4a235" : "1px solid #3a2010";
                    lbl.style.background = val === checked ? "rgba(244,162,53,0.12)" : "rgba(0,0,0,0.3)";
                    lbl.style.color      = val === checked ? "#f4a235" : "#a08060";
                }
            };
            el.querySelectorAll("input[name='roll-mode']").forEach(inp =>
                inp.addEventListener("change", updateMode)
            );
            updateMode();
        }

        async close(options) {
            if (!resolved) resolve(null);
            return super.close(options);
        }
    }

    new PepperboxDialog({
        window: { title: "Пепербокс" },
        content,
        buttons: [{
            action: "fire",
            label: "🔥 Огонь!",
            callback: (event, button, dialog) => {
                const el = dialog.element;
                const selections = [];
                el.querySelectorAll(".shot-select").forEach((sel, i) => {
                    const shots = Number(sel.value);
                    if (shots > 0) selections.push({ target: targets[i], shots });
                });
                const chosenMode = el.querySelector("input[name='roll-mode']:checked")?.value ?? "normal";
                resolved = true;
                resolve({ selections, chosenMode });
            }
        }]
    }).render(true);
});

if (!dialogResult || !dialogResult.selections.length) return;
const { selections, chosenMode } = dialogResult;

// ============================================================
// 🔥 ПЕПЕЛ В СТВОЛЕ — спрашиваем после закрытия основного диалога
// ============================================================
let useAshBarrel = false;
const combat  = game.combat;
// Если мы вне боя — генерируем случайный ID, чтобы спрашивало каждый раз!
const turnId  = combat ? `${combat.round}-${combat.turn}` : `no-combat-${foundry.utils.randomID()}`;
const lastUse = actor.getFlag("world", "ash_barrel_turn");

if (lastUse !== turnId) {
    useAshBarrel = await confirm(
        "🔥 Особая подготовка",
        "<p style='text-align:center; font-size:16px;'>Использовать <b>Пепел в стволе</b>?</p>"
    );
    // Флаг сохранится, и в рамках одного хода диалог больше не вылезет
    if (useAshBarrel) await actor.setFlag("world", "ash_barrel_turn", turnId);
}

// ============================================================
// ОСНОВНОЙ ЦИКЛ ВЫСТРЕЛОВ
// ============================================================
outer:
    for (const entry of selections) {
        for (let i = 0; i < entry.shots; i++) {

            if (weaponJammed) {
                ui.notifications.error("💨 Оружие забито! Стрельба прекращена.");
                break outer;
            }

            // --- Дистанция ---
            const dist = getDistance(entry.target);
            if (dist > RANGE_MAX) {
                ChatMessage.create({
                    content: `<div style="background:#1a1a1a; border:1px solid #ff4d4f;
                              padding:8px; border-radius:8px; color:#f1f3f5;">
          ⛔ <b>${entry.target.name}</b> вне досягаемости (${dist} фт).
        </div>`
                });
                continue;
            }

            // --- Режим броска с учётом дистанции ---
            // ADV + дальний = обычный (компенсируют), всё остальное + дальний = помеха
            let shotMode = disadvantageNext ? "disadvantage" : chosenMode;
            if (dist > RANGE_NORMAL) {
                shotMode = shotMode === "advantage" ? "normal" : "disadvantage";
            }
            disadvantageNext = false;

            const rollBase = shotMode === "advantage"    ? "2d20kh1"
                : shotMode === "disadvantage" ? "2d20kl1"
                    :                               "1d20";
            const formula = `${rollBase} + @abilities.dex.mod + @prof`;

            let flavorParts = [`Выстрел по ${entry.target.name}`];
            if (dist > RANGE_NORMAL)              flavorParts.push(`дальний (${dist} фт)`);
            if (shotMode === "advantage")         flavorParts.push("преимущество");
            else if (shotMode === "disadvantage") flavorParts.push("помеха");

            // --- Анимация выстрела ---
            if (typeof Sequence !== "undefined") {
                new Sequence()
                    .sound()
                    .file("blfx.sound.weapon.range.pistol_shot1.1")
                    .volume(0.9)
                    .delay(100)
                    .effect()
                    .file("jb2a.bullet.Snipe.orange")
                    .atLocation(token)
                    .stretchTo(entry.target)
                    .play();
            }

            // --- Бросок атаки ---
            const attack = await rollAndSend(formula, actor.getRollData(), "");
            // const d20    = attack.terms[0].results.find(r => r.active)?.result
            //     ?? attack.terms[0].results[0].result;
            const d20Term = attack.dice?.find(d => d.faces === 20);
            const d20 = d20Term?.results.find(r => r.active)?.result ?? d20Term?.results[0]?.result;

            // ==========================================================
            // 💥 ОСЕЧКА
            // ==========================================================

            if (d20 <= MISFIRE) {

                // Спрашиваем — как в оригинале
                const accept = await confirm(
                    "💥 Осечка!",
                    `<p style="color:#f1f3f5;">
          💥 Произошла осечка (выпало <b>${d20}</b>).<br>Принять последствия?<br>
          <span style="font-size:11px; color:#aaa;">(Отмена = переброс за вдохновение)</span>
        </p>`
                );

                if (!accept) {
                    // === ПЕРЕБРОС ЗА ВДОХНОВЕНИЕ ===
                    const reroll = await rollAndSend(formula, actor.getRollData(), "🎯 Переброс (вдохновение)");
                    const newD20 = reroll.terms[0].results.find(r => r.active)?.result
                        ?? reroll.terms[0].results[0].result;
                    const isCrit = newD20 >= critThreshold;
                    const ac     = entry.target.actor.system.attributes.ac.value;
                    await processHit(reroll.total >= ac || isCrit, isCrit, entry.target, useAshBarrel);
                    continue;
                }

                // === ТАБЛИЦА ОСЕЧЕК ===
                const mishapRoll = await rollAndSend("1d6", {}, "💥 Таблица осечки");
                const m = mishapRoll.total;

                const mishapTable = {
                    1: { icon:"💣", title:"Взрыв в стволе",      color:"#ff4d4f", desc:"Вы получаете урон оружия. Оружие ломается."     },
                    2: { icon:"🔥", title:"Обратный выброс",      color:"#ff922b", desc:"Вы получаете половину урона. Оружие заклинило." },
                    3: { icon:"💨", title:"Забитый ствол",        color:"#adb5bd", desc:"Требуется действие на починку."                 },
                    4: { icon:"⚙️", title:"Частичная осечка",     color:"#74c0fc", desc:"Атака с помехой, урон половинный."              },
                    5: { icon:"⚡", title:"Нестабильный выстрел", color:"#ffd43b", desc:"Атака проходит, урон уменьшается вдвое."        },
                    6: { icon:"😈", title:"Удачный срыв",         color:"#c77dff", desc:"Атака проходит. Следующая атака с помехой."     },
                };
                const mishap = mishapTable[m];

                ChatMessage.create({
                    content: `
        <div style="background:#1a1a1a; border:1px solid #444;
                    border-radius:10px; padding:12px; color:#f1f3f5;">
          <div style="font-size:1.05em; margin-bottom:6px;">
            ${mishap.icon} <b style="color:${mishap.color};">Осечка: ${mishap.title}</b>
          </div>
          <div style="background:#111; padding:6px; border-radius:6px;
                      margin-bottom:6px; font-size:0.9em; color:#ccc;">
            🎲 Результат d6: <strong>${m}</strong>
          </div>
          <div style="color:#ddd;">${mishap.desc}</div>
        </div>`
                });

                if (m === 1) {
                    const dmg = await rollAndSend("1d4 + @abilities.dex.mod", actor.getRollData(), "💣 Взрыв — урон стрелку");
                    await MidiQOL.applyTokenDamage([{ damage: dmg.total, type: "piercing" }], dmg.total, new Set([token]));

                } else if (m === 2) {
                    const dmg  = await rollAndSend("1d4 + @abilities.dex.mod", actor.getRollData(), "🔥 Обратный выброс — урон стрелку");
                    const half = Math.floor(dmg.total / 2);
                    await MidiQOL.applyTokenDamage([{ damage: half, type: "piercing" }], half, new Set([token]));

                } else if (m === 3) {
                    weaponJammed = true;
                    ChatMessage.create({
                        content: `<div style="background:#1a1a1a; border:1px solid #ff922b;
                                padding:10px; border-radius:10px; color:#f1f3f5;">
            💨 <b>Ствол забит!</b> Оружие не стреляет. Требуется действие.
          </div>`
                    });
                    break outer;

                } else if (m === 4) {
                    const disAtk = await rollAndSend(
                        `2d20kl1 + @abilities.dex.mod + @prof`, actor.getRollData(),
                        `⚙️ Осечка — атака с помехой по ${entry.target.name}`
                    );
                    const ac = entry.target.actor.system.attributes.ac.value;
                    if (disAtk.total >= ac) {
                        const dmg  = await rollAndSend("1d4 + @abilities.dex.mod", actor.getRollData(), "⚙️ Осечка — урон (половина)");
                        const half = Math.floor(dmg.total / 2);
                        await MidiQOL.applyTokenDamage([{ damage: half, type: "piercing" }], half, new Set([entry.target]));
                    }

                } else if (m === 5) {
                    const dmg  = await rollAndSend("1d4 + @abilities.dex.mod", actor.getRollData(), "⚡ Нестабильный — урон (половина)");
                    const half = Math.floor(dmg.total / 2);
                    await MidiQOL.applyTokenDamage([{ damage: half, type: "piercing" }], half, new Set([entry.target]));

                } else if (m === 6) {
                    disadvantageNext = true;
                    const dmg = await rollAndSend("1d4 + @abilities.dex.mod", actor.getRollData(), "😈 Удачный срыв — урон");
                    await MidiQOL.applyTokenDamage([{ damage: dmg.total, type: "piercing" }], dmg.total, new Set([entry.target]));
                }

                continue; // осечка обработана

            } // конец блока осечки

            // ==========================================================
            // 🎯 ОБЫЧНАЯ АТАКА / КРИТ
            // ==========================================================
            const isCrit = d20 >= critThreshold;
            const ac     = entry.target.actor.system.attributes.ac.value;
            await processHit(attack.total >= ac || isCrit, isCrit, entry.target, useAshBarrel);

        }
    }

// ============================================================
// 🎯 ПОПАДАНИЕ / ПРОМАХ
// ============================================================
async function processHit(hit, isCrit, target, ashEnabled) {
    if (!hit) {
        ChatMessage.create({
            content: `<div style="background:#1a1a1a; border:1px solid #444;
                            padding:8px; border-radius:8px; color:#f1f3f5;">
        ❌ Промах по <b>${target.name}</b>
      </div>`
        });
        return;
    }

    if (typeof Sequence !== "undefined") {
        new Sequence()
            .effect()
            .file("jb2a.impact.004.yellow")
            .atLocation(target)
            .scale(0.6)
            .play();
    }

    const baseFormula = isCrit ? "2d4 + @abilities.dex.mod" : "1d4 + @abilities.dex.mod";
    const baseRoll    = await rollAndSend(
        baseFormula, actor.getRollData(),
        isCrit ? `💥 Крит по ${target.name}` : `🎯 Урон по ${target.name}`
    );

    let ashRoll = null;
    let applyAsh = ashEnabled && !ashUsedThisTurn;

    if (applyAsh) {
        ashUsedThisTurn = true;
        ui.notifications.info("🔥 Пепел в стволе сработал");

        const lvl  = actor.system.details.level ?? 1;
        const dice = lvl >= 17 ? "4d4" : lvl >= 11 ? "3d4" : lvl >= 5 ? "2d4" : "1d4";
        ashRoll    = await rollAndSend(dice, {}, "🔥 Пепел в стволе");
    }

    const totalDmg = baseRoll.total + (ashRoll?.total ?? 0);
    await MidiQOL.applyTokenDamage([{ damage: totalDmg, type: "piercing" }], totalDmg, new Set([target]));

    const baseDice = baseRoll.terms[0].results.map(r => r.result).join(" + ");
    const ashDice  = ashRoll ? ashRoll.terms[0].results.map(r => r.result).join(" + ") : null;

    ChatMessage.create({
        content: `
    <div style="background:#1a1a1a; border:1px solid #5a3a1a;
                padding:10px; border-radius:10px; color:#f1f3f5;">
      <div style="font-size:1.05em; margin-bottom:6px;">
        ${isCrit ? "💥 <b>КРИТИЧЕСКОЕ!</b>" : "Попадание"} → <b>${target.name}</b>
      </div>
      <div style="background:#111; padding:6px; border-radius:6px;
                  margin-bottom:6px; font-size:0.9em; color:#ccc;">
        🎲 Основа: [${baseDice}]${ashDice ? `<br>🔥 Пепел: [${ashDice}]` : ""}
      </div>
      <div>Урон: <b style="color:#ffd166; font-size:1.1em;">${totalDmg}</b> пробивающего</div>
    </div>`
    });

    if (isCrit && applyAsh) {
        await target.actor.createEmbeddedDocuments("ActiveEffect", [{
            name: "Ослеплён (Пепел в стволе)",
            icon: "icons/svg/blind.svg",
            duration: { rounds: 1 },
            statuses: ["blinded"]
        }]);
        ChatMessage.create({
            content: `<div style="background:#1a1a1a; border:1px solid #ffd43b;
                            padding:8px; border-radius:8px; color:#f1f3f5;">
        👁️ <b>${target.name}</b> ослеплён (Пепел в стволе, 1 раунд).
      </div>`
        });
    }
}