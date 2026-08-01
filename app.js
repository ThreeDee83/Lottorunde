const supabaseClient = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

let currentProfile = null; // { id, name, role, balance }
let allEntries = [];
let allProfiles = [];
let activeEntryFilter = "month";
let appDialogResolver = null;

// ---------- Helpers ----------
const fmtMoney = (n) =>
  Number(n || 0).toLocaleString("de-AT", { style: "currency", currency: "EUR" });

const $ = (id) => document.getElementById(id);

function show(el) { el.classList.remove("hidden"); }
function hide(el) { el.classList.add("hidden"); }

function formatDate(dateString) {
  if (!dateString) return "-";
  return new Intl.DateTimeFormat("de-AT").format(new Date(`${dateString}T00:00:00`));
}

function todayIso() {
  const now = new Date();
  const offset = now.getTimezoneOffset();
  return new Date(now.getTime() - offset * 60_000).toISOString().slice(0, 10);
}

function parseDrawDates(value) {
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function balanceToneClass(value) {
  const amount = Number(value || 0);
  if (amount > 0) return "amount-positive";
  if (amount < 0) return "amount-negative";
  return "";
}

function setBalanceDisplay(element, value) {
  element.textContent = fmtMoney(value);
  element.classList.toggle("amount-positive", Number(value) > 0);
  element.classList.toggle("amount-negative", Number(value) < 0);
}

function showAppDialog({ title, message, confirmLabel = "OK", cancelLabel = null, danger = false }) {
  if (appDialogResolver) appDialogResolver(false);
  $("appDialogTitle").textContent = title;
  $("appDialogMessage").textContent = message;
  $("appDialogConfirmBtn").textContent = confirmLabel;
  $("appDialogConfirmBtn").classList.toggle("btn-danger", danger);
  $("appDialogConfirmBtn").classList.toggle("btn-primary", !danger);
  $("appDialogCancelBtn").textContent = cancelLabel || "Abbrechen";
  $("appDialogCancelBtn").classList.toggle("hidden", !cancelLabel);
  show($("appDialogModal"));
  $("appDialogConfirmBtn").focus();
  return new Promise((resolve) => { appDialogResolver = resolve; });
}

function closeAppDialog(result) {
  hide($("appDialogModal"));
  const resolve = appDialogResolver;
  appDialogResolver = null;
  if (resolve) resolve(result);
}

$("appDialogConfirmBtn").addEventListener("click", () => closeAppDialog(true));
$("appDialogCancelBtn").addEventListener("click", () => closeAppDialog(false));

// ---------- Auth ----------
$("loginForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  $("loginError").textContent = "";
  const email = $("loginEmail").value.trim();
  const password = $("loginPassword").value;
  const { error } = await supabaseClient.auth.signInWithPassword({ email, password });
  if (error) {
    $("loginError").textContent = "Anmeldung fehlgeschlagen: " + error.message;
    return;
  }
  await bootstrapApp();
});

$("logoutBtn").addEventListener("click", async () => {
  await supabaseClient.auth.signOut();
  location.reload();
});

async function bootstrapApp() {
  const { data: { user } } = await supabaseClient.auth.getUser();
  if (!user) return;

  const { data: profile, error } = await supabaseClient
    .from("profiles")
    .select("*")
    .eq("id", user.id)
    .single();

  if (error || !profile) {
    $("loginError").textContent = "Kein Profil gefunden. Bitte einen Admin kontaktieren.";
    await supabaseClient.auth.signOut();
    return;
  }

  if (!profile.active) {
    $("loginError").textContent = "Dieses Konto wurde deaktiviert. Bitte einen Admin kontaktieren.";
    await supabaseClient.auth.signOut();
    return;
  }

  currentProfile = profile;
  hide($("loginScreen"));
  show($("appScreen"));
  $("whoami").textContent = `${profile.name} (${profile.role === "admin" ? "Admin" : "User"})`;

  if (profile.role === "admin") {
    show($("settingsBtn"));
    show($("adminOverviewSection"));
    show($("newEntrySection"));
    show($("entriesActionsHeader"));
    $("entryDate").value = todayIso();
    await loadOverview();
  } else {
    show($("userBalanceSection"));
    setBalanceDisplay($("userBalanceAmount"), profile.balance);
  }

  await loadEntries();
}

// ---------- Admin: Kontostand-Übersicht ----------
async function loadOverview() {
  const { data: profiles, error } = await supabaseClient
    .from("profiles")
    .select("*")
    .order("role", { ascending: false })
    .order("name");

  if (error) return;

  allProfiles = profiles || [];
  populateDepositPlayers();

  const body = $("overviewTableBody");
  body.innerHTML = "";
  allProfiles.forEach((p) => {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td data-label="Name" class="profile-card-name">${p.name}</td>
      <td data-label="Kontostand" class="mono profile-card-balance ${balanceToneClass(p.balance)}">${fmtMoney(p.balance)}</td>
    `;
    body.appendChild(tr);
  });
}

function populateDepositPlayers() {
  const select = $("depositPlayer");
  select.innerHTML = "";
  const placeholder = document.createElement("option");
  placeholder.value = "";
  placeholder.textContent = "Spieler wählen";
  placeholder.disabled = true;
  placeholder.selected = true;
  select.appendChild(placeholder);
  allProfiles.forEach((profile) => {
    const option = document.createElement("option");
    option.value = profile.id;
    option.textContent = profile.name;
    select.appendChild(option);
  });
}

function openDeposit() {
  $("depositForm").reset();
  $("depositStatus").textContent = "";
  populateDepositPlayers();
  show($("depositModal"));
  $("closeDepositBtn").focus();
}

function closeDeposit() {
  hide($("depositModal"));
}

$("openDepositBtn").addEventListener("click", openDeposit);
$("closeDepositBtn").addEventListener("click", closeDeposit);
$("cancelDepositBtn").addEventListener("click", closeDeposit);

$("depositForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!$("depositPlayer").value) {
    $("depositStatus").textContent = "Bitte zuerst einen Spieler wählen.";
    return;
  }
  const amount = Number.parseFloat($("depositAmount").value);
  if (!Number.isFinite(amount) || amount <= 0) {
    $("depositStatus").textContent = "Bitte einen Betrag größer als 0 eingeben.";
    return;
  }

  const button = $("saveDepositBtn");
  button.disabled = true;
  $("depositStatus").textContent = "";
  const { error } = await supabaseClient.rpc("admin_deposit", {
    target_id: $("depositPlayer").value,
    deposit_amount: amount,
    deposit_note: "Einzahlung über Website",
  });
  button.disabled = false;
  if (error) {
    $("depositStatus").textContent = "Fehler: " + error.message;
    return;
  }

  closeDeposit();
  await loadOverview();
});

// ---------- Eintragsliste ----------
async function loadEntries() {
  const { data: entries, error } = await supabaseClient
    .from("entries")
    .select("*")
    .order("entry_date", { ascending: false });

  if (error) {
    $("entriesCount").textContent = "Einträge konnten nicht geladen werden.";
    return;
  }

  allEntries = entries || [];
  renderEntries();
}

function isEntryInActivePeriod(entry) {
  if (activeEntryFilter === "all") return true;

  const today = new Date();
  const [year, month] = entry.entry_date.split("-").map(Number);
  if (activeEntryFilter === "year") return year === today.getFullYear();
  return year === today.getFullYear() && month === today.getMonth() + 1;
}

function renderEntries() {
  const entries = allEntries.filter(isEntryInActivePeriod);

  const body = $("entriesTableBody");
  body.innerHTML = "";

  $("entriesCount").textContent = `${entries.length} ${entries.length === 1 ? "Eintrag" : "Einträge"}`;

  if (!entries.length) {
    const tr = document.createElement("tr");
    tr.className = "empty-row";
    const td = document.createElement("td");
    td.colSpan = currentProfile.role === "admin" ? 7 : 6;
    td.textContent = "Für diesen Zeitraum sind keine Spielscheine vorhanden.";
    tr.appendChild(td);
    body.appendChild(tr);
    return;
  }

  entries.forEach((e) => {
    const tr = document.createElement("tr");
    const draws = (e.draw_dates || []).map(formatDate).join(", ");
    tr.innerHTML = `
      <td data-label="Datum">${formatDate(e.entry_date)}</td>
      <td data-label="Quittungsnr." class="mono">${e.receipt_number}</td>
      <td data-label="Spielart">${e.game_type}</td>
      <td data-label="Ziehungsdatum">${draws || "-"}</td>
      <td data-label="Kosten" class="mono ticket-cost">${fmtMoney(e.cost)}</td>
      <td data-label="Gewinn" class="mono ${e.gewinn > 0 ? "amount-positive" : ""}">${fmtMoney(e.gewinn)}</td>
    `;

    if (currentProfile.role === "admin") {
      const actionCell = document.createElement("td");
      actionCell.className = "entry-actions";
      actionCell.dataset.label = "Aktionen";
      actionCell.innerHTML = `
        <div class="action-group">
          <button type="button" class="btn btn-secondary btn-icon" data-edit-entry="${e.id}" aria-label="Spielschein bearbeiten" title="Bearbeiten">
            <span class="material-symbols-rounded" aria-hidden="true">edit</span>
          </button>
          <button type="button" class="btn btn-danger btn-icon" data-delete-entry="${e.id}" aria-label="Spielschein löschen" title="Löschen">
            <span class="material-symbols-rounded" aria-hidden="true">delete</span>
          </button>
        </div>
      `;
      actionCell.querySelector("[data-edit-entry]").addEventListener("click", () => openEditEntry(e));
      const deleteButton = actionCell.querySelector("[data-delete-entry]");
      deleteButton.addEventListener("click", (event) => deleteEntry(e, event.currentTarget));
      tr.appendChild(actionCell);
      attachEntrySwipe(tr, e, deleteButton);
    }

    attachEntryDetails(tr, e);
    body.appendChild(tr);
  });
}

function isMobileEntryView() {
  return window.matchMedia("(max-width: 600px) and (orientation: portrait)").matches;
}

function openEntryDetails(entry) {
  const draws = (entry.draw_dates || []).map(formatDate).join(", ");
  $("detailEntryDate").textContent = formatDate(entry.entry_date);
  $("detailReceipt").textContent = entry.receipt_number || "-";
  $("detailGameType").textContent = entry.game_type || "-";
  $("detailDrawDates").textContent = draws || "-";
  $("detailCost").textContent = fmtMoney(entry.cost);
  $("detailGewinn").textContent = fmtMoney(entry.gewinn);
  $("detailGewinn").classList.toggle("amount-positive", Number(entry.gewinn) > 0);
  show($("entryDetailsModal"));
  $("closeEntryDetailsBtn").focus();
}

function closeEntryDetails() {
  hide($("entryDetailsModal"));
}

function attachEntryDetails(row, entry) {
  row.addEventListener("click", (event) => {
    if (!isMobileEntryView() || event.target.closest("button")) return;
    if (Date.now() < Number(row.dataset.suppressDetailsUntil || 0)) return;
    openEntryDetails(entry);
  });
}

function attachEntrySwipe(row, entry, deleteButton) {
  let startX = 0;
  let startY = 0;
  let deltaX = 0;
  let isHorizontal = false;

  row.addEventListener("touchstart", (event) => {
    if (event.touches.length !== 1) return;
    startX = event.touches[0].clientX;
    startY = event.touches[0].clientY;
    deltaX = 0;
    isHorizontal = false;
    row.classList.add("swipe-tracking");
  }, { passive: true });

  row.addEventListener("touchmove", (event) => {
    if (event.touches.length !== 1) return;
    const currentX = event.touches[0].clientX;
    const currentY = event.touches[0].clientY;
    deltaX = currentX - startX;
    const deltaY = currentY - startY;
    isHorizontal = Math.abs(deltaX) > 10 && Math.abs(deltaX) > Math.abs(deltaY) * 1.2;
    if (!isHorizontal) return;

    const offset = Math.max(-88, Math.min(88, deltaX));
    row.style.transform = `translateX(${offset}px)`;
    row.classList.toggle("swipe-edit", deltaX > 0);
    row.classList.toggle("swipe-delete", deltaX < 0);
  }, { passive: true });

  const finishSwipe = () => {
    row.classList.remove("swipe-tracking", "swipe-edit", "swipe-delete");
    row.style.transform = "";
    if (!isHorizontal || Math.abs(deltaX) < 72) return;
    row.dataset.suppressDetailsUntil = String(Date.now() + 600);
    if (deltaX > 0) openEditEntry(entry);
    else deleteEntry(entry, deleteButton);
  };

  row.addEventListener("touchend", finishSwipe, { passive: true });
  row.addEventListener("touchcancel", () => {
    isHorizontal = false;
    finishSwipe();
  }, { passive: true });
}

$("refreshEntriesBtn").addEventListener("click", async () => {
  const button = $("refreshEntriesBtn");
  button.disabled = true;
  button.textContent = "↻ Wird aktualisiert …";
  $("entriesRefreshStatus").textContent = "Daten werden aktualisiert.";

  if (currentProfile.role === "admin") {
    await loadOverview();
  } else {
    const { data: profile } = await supabaseClient
      .from("profiles")
      .select("balance")
      .eq("id", currentProfile.id)
      .single();
    if (profile) {
      currentProfile.balance = profile.balance;
      setBalanceDisplay($("userBalanceAmount"), profile.balance);
    }
  }

  await loadEntries();
  button.disabled = false;
  button.textContent = "↻ Aktualisieren";
  $("entriesRefreshStatus").textContent = "Tabelle und Kontostände wurden aktualisiert.";
});

document.querySelectorAll("[data-entry-filter]").forEach((button) => {
  button.addEventListener("click", () => {
    activeEntryFilter = button.dataset.entryFilter;
    document.querySelectorAll("[data-entry-filter]").forEach((item) => {
      const selected = item === button;
      item.classList.toggle("active", selected);
      item.setAttribute("aria-pressed", String(selected));
    });
    renderEntries();
  });
});

async function deleteEntry(entry, button) {
  const confirmed = await showAppDialog({
    title: "Spielschein löschen?",
    message: `Quittung ${entry.receipt_number} vom ${formatDate(entry.entry_date)} wird dauerhaft gelöscht. Verrechnete Kosten und Gewinne werden in den Kontoständen zurückgerechnet.`,
    confirmLabel: "Löschen",
    cancelLabel: "Abbrechen",
    danger: true,
  });
  if (!confirmed) return;

  const originalButtonHtml = button.innerHTML;
  button.disabled = true;
  button.innerHTML = '<span class="material-symbols-rounded" aria-hidden="true">progress_activity</span>';
  const { error } = await supabaseClient.rpc("admin_delete_entry", { target_entry_id: entry.id });
  if (error) {
    button.disabled = false;
    button.innerHTML = originalButtonHtml;
    await showAppDialog({ title: "Löschen fehlgeschlagen", message: error.message });
    return;
  }

  await loadEntries();
  await loadOverview();
}

// ---------- Admin: Spielart auswählen ----------
const standardGameTypes = ["Lotto", "Joker", "Euromillionen"];

function selectedGameTypes(prefix) {
  const selected = [...document.querySelectorAll(`[data-game-type-for="${prefix}"]:checked`)]
    .map((input) => input.value);
  const manual = $(`${prefix}GameTypeCustom`).value
    .split(/[,;]+/)
    .map((item) => item.trim())
    .filter(Boolean);
  return [...new Set([...selected, ...manual])];
}

function updateGameTypeSummary(prefix) {
  const selected = selectedGameTypes(prefix);
  $(`${prefix}GameTypeSummary`).textContent = selected.length
    ? selected.join(", ")
    : "Spielart wählen";
}

function setGameTypes(prefix, storedValue = "") {
  const inputs = [...document.querySelectorAll(`[data-game-type-for="${prefix}"]`)];
  inputs.forEach((input) => { input.checked = false; });

  const manual = [];
  storedValue.split(/\s*\+\s*/).map((item) => item.trim()).filter(Boolean).forEach((item) => {
    const standard = standardGameTypes.find((value) => value.toLocaleLowerCase("de") === item.toLocaleLowerCase("de"));
    const input = inputs.find((candidate) => candidate.value === standard);
    if (input) input.checked = true;
    else if (item !== "Unbekannt") manual.push(item);
  });

  $(`${prefix}GameTypeCustom`).value = manual.join(", ");
  $(`${prefix}GameTypeMenu`).removeAttribute("open");
  updateGameTypeSummary(prefix);
}

function gameTypeValue(prefix) {
  return selectedGameTypes(prefix).join(" + ") || "Unbekannt";
}

["entry", "editEntry"].forEach((prefix) => {
  document.querySelectorAll(`[data-game-type-for="${prefix}"]`).forEach((input) => {
    input.addEventListener("change", () => updateGameTypeSummary(prefix));
  });
  $(`${prefix}GameTypeCustom`).addEventListener("input", () => updateGameTypeSummary(prefix));
});

function setEntryMode(mode) {
  const isManual = mode === "manual";
  document.querySelectorAll("[data-entry-mode]").forEach((item) => {
    const selected = item.dataset.entryMode === mode;
    item.classList.toggle("active", selected);
    item.setAttribute("aria-pressed", String(selected));
  });
  $("entryModeHint").textContent = isManual
    ? "Daten des alten Scheins manuell eintragen. Nur die Quittungsnummer ist verpflichtend."
    : "Nur die Quittungsnummer ist verpflichtend. Alle weiteren Daten werden manuell eingetragen.";
}

document.querySelectorAll("[data-entry-mode]").forEach((button) => {
  button.addEventListener("click", () => {
    setEntryMode(button.dataset.entryMode);
    $("entryDate").focus();
  });
});

function openNewEntry() {
  $("newEntryForm").reset();
  $("entryDate").value = todayIso();
  $("newEntryError").textContent = "";
  setGameTypes("entry");
  setEntryMode("current");
  show($("newEntryModal"));
  $("entryReceipt").focus();
}

function closeNewEntry() {
  $("entryGameTypeMenu").removeAttribute("open");
  hide($("newEntryModal"));
}

$("openNewEntryBtn").addEventListener("click", openNewEntry);
$("closeNewEntryBtn").addEventListener("click", closeNewEntry);
$("cancelNewEntryBtn").addEventListener("click", closeNewEntry);

// ---------- Admin: Neuer Datensatz ----------
$("newEntryForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  $("newEntryError").textContent = "";

  const drawDates = parseDrawDates($("entryDrawDates").value);

  const payload = {
    entry_date: $("entryDate").value || todayIso(),
    receipt_number: $("entryReceipt").value.trim(),
    game_type: gameTypeValue("entry"),
    draw_dates: drawDates,
    cost: parseFloat($("entryCost").value) || 0,
    gewinn: parseFloat($("entryGewinn").value) || 0,
    created_by: currentProfile.id,
  };

  const { error } = await supabaseClient.from("entries").insert(payload);
  if (error) {
    $("newEntryError").textContent = "Fehler: " + error.message;
    return;
  }

  $("newEntryForm").reset();
  $("entryDate").value = todayIso();
  closeNewEntry();
  await loadEntries();
  await loadOverview();
});

// ---------- Admin: Spielschein bearbeiten ----------
function openEditEntry(entry) {
  $("editEntryId").value = entry.id;
  $("editEntryReceipt").value = entry.receipt_number;
  $("editEntryDate").value = entry.entry_date || "";
  setGameTypes("editEntry", entry.game_type || "");
  $("editEntryCost").value = Number(entry.cost || 0);
  $("editEntryGewinn").value = Number(entry.gewinn || 0);
  $("editEntryDrawDates").value = (entry.draw_dates || []).join(", ");
  $("editEntryStatus").textContent = "Änderungen an Kosten oder Gewinn werden automatisch neu aufgeteilt.";
  show($("editEntryModal"));
  $("editEntryReceipt").focus();
}

function closeEditEntry() {
  $("editEntryGameTypeMenu").removeAttribute("open");
  hide($("editEntryModal"));
  $("editEntryForm").reset();
}

$("closeEditEntryBtn").addEventListener("click", closeEditEntry);
$("cancelEditEntryBtn").addEventListener("click", closeEditEntry);
$("closeEntryDetailsBtn").addEventListener("click", closeEntryDetails);
$("closeEntryDetailsActionBtn").addEventListener("click", closeEntryDetails);

$("editEntryForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const submitButton = $("saveEditEntryBtn");
  submitButton.disabled = true;
  $("editEntryStatus").textContent = "Änderungen werden gespeichert …";

  const payload = {
    entry_date: $("editEntryDate").value || todayIso(),
    receipt_number: $("editEntryReceipt").value.trim(),
    game_type: gameTypeValue("editEntry"),
    draw_dates: parseDrawDates($("editEntryDrawDates").value),
    cost: parseFloat($("editEntryCost").value) || 0,
    gewinn: parseFloat($("editEntryGewinn").value) || 0,
  };

  const { error } = await supabaseClient
    .from("entries")
    .update(payload)
    .eq("id", $("editEntryId").value);

  submitButton.disabled = false;
  if (error) {
    $("editEntryStatus").textContent = "Fehler: " + error.message;
    return;
  }

  closeEditEntry();
  await loadEntries();
  await loadOverview();
});

[$("newEntryModal"), $("editEntryModal"), $("depositModal"), $("entryDetailsModal")].forEach((overlay) => {
  overlay.addEventListener("click", (event) => {
    if (event.target !== overlay) return;
    if (overlay === $("newEntryModal")) closeNewEntry();
    else if (overlay === $("editEntryModal")) closeEditEntry();
    else if (overlay === $("entryDetailsModal")) closeEntryDetails();
    else closeDeposit();
  });
});

document.addEventListener("keydown", (event) => {
  if (event.key !== "Escape") return;
  if (!$("appDialogModal").classList.contains("hidden")) {
    closeAppDialog(false);
    return;
  }
  if (!$("depositModal").classList.contains("hidden")) closeDeposit();
  if (!$("newEntryModal").classList.contains("hidden")) closeNewEntry();
  if (!$("editEntryModal").classList.contains("hidden")) closeEditEntry();
  if (!$("entryDetailsModal").classList.contains("hidden")) closeEntryDetails();
});

// ---------- Settings Modal ----------
$("settingsBtn").addEventListener("click", async () => {
  show($("settingsModal"));
  $("topbarRight").classList.remove("open");
  $("menuToggleBtn").classList.remove("open");
  await loadSettingsPlayers();
});
$("closeSettingsBtn").addEventListener("click", () => hide($("settingsModal")));

async function loadSettingsPlayers() {
  const { data: profiles, error } = await supabaseClient
    .from("profiles")
    .select("*")
    .order("name");
  if (error) return;

  const body = $("settingsPlayersBody");
  body.innerHTML = "";
  profiles.forEach((p) => {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td data-label="Name">${p.name}${p.active ? "" : " <span class=\"muted\">(deaktiviert)</span>"}</td>
      <td data-label="Rolle">
        <select data-role-for="${p.id}">
          <option value="user" ${p.role === "user" ? "selected" : ""}>User</option>
          <option value="admin" ${p.role === "admin" ? "selected" : ""}>Admin</option>
        </select>
      </td>
      <td data-label="Kontostand">
        <div class="inline-input">
          <input type="number" step="0.01" data-balance-for="${p.id}" value="${p.balance}" />
          <button class="btn btn-secondary btn-small" data-save-balance="${p.id}">Speichern</button>
        </div>
      </td>
      <td data-label="Status">
        <button class="btn btn-ghost btn-small" data-toggle-active="${p.id}" data-current="${p.active}">
          ${p.active ? "Deaktivieren" : "Aktivieren"}
        </button>
      </td>
    `;
    body.appendChild(tr);
  });

  body.querySelectorAll("select[data-role-for]").forEach((sel) => {
    sel.addEventListener("change", async () => {
      const id = sel.getAttribute("data-role-for");
      const { error } = await supabaseClient.rpc("admin_set_role", { target_id: id, new_role: sel.value });
      if (error) await showAppDialog({ title: "Rolle konnte nicht geändert werden", message: error.message });
    });
  });

  body.querySelectorAll("button[data-save-balance]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const id = btn.getAttribute("data-save-balance");
      const input = body.querySelector(`input[data-balance-for="${id}"]`);
      const newBalance = parseFloat(input.value);
      const { error } = await supabaseClient.rpc("admin_correct_balance", {
        target_id: id,
        new_balance: newBalance,
        correction_note: "Manuelle Korrektur in den Einstellungen",
      });
      if (error) {
        await showAppDialog({ title: "Kontostand konnte nicht geändert werden", message: error.message });
        return;
      }
      await loadOverview();
      await showAppDialog({ title: "Kontostand aktualisiert", message: "Die Korrektur wurde erfolgreich gespeichert." });
    });
  });

  body.querySelectorAll("button[data-toggle-active]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const id = btn.getAttribute("data-toggle-active");
      const isCurrentlyActive = btn.getAttribute("data-current") === "true";
      const newActive = !isCurrentlyActive;
      const label = newActive ? "aktivieren" : "deaktivieren";
      const confirmed = await showAppDialog({
        title: `Spieler ${label}?`,
        message: `Möchtest du diesen Spieler wirklich ${label}?`,
        confirmLabel: newActive ? "Aktivieren" : "Deaktivieren",
        cancelLabel: "Abbrechen",
        danger: !newActive,
      });
      if (!confirmed) return;

      const { error } = await supabaseClient.rpc("admin_set_active", {
        target_id: id,
        new_active: newActive,
      });
      if (error) {
        await showAppDialog({ title: "Status konnte nicht geändert werden", message: error.message });
        return;
      }
      await loadSettingsPlayers();
      await loadOverview();
    });
  });
}

// ---------- Mobile Menü ----------
$("menuToggleBtn").addEventListener("click", () => {
  $("topbarRight").classList.toggle("open");
  $("menuToggleBtn").classList.toggle("open");
});

// ---------- Beim Laden prüfen ob bereits eingeloggt ----------
(async function init() {
  const { data: { session } } = await supabaseClient.auth.getSession();
  if (session) await bootstrapApp();
})();
