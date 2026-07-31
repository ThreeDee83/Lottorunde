const supabaseClient = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

let currentProfile = null; // { id, name, role, balance }
let allEntries = [];
let activeEntryFilter = "month";
let receiptLookupTimer = null;

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
    $("userBalanceAmount").textContent = fmtMoney(profile.balance);
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

  const body = $("overviewTableBody");
  body.innerHTML = "";
  profiles.forEach((p) => {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td data-label="Name">${p.name}</td>
      <td data-label="Rolle">${p.role === "admin" ? "Admin" : "User"}</td>
      <td data-label="Kontostand" class="mono">${fmtMoney(p.balance)}</td>
      <td data-label=""><button class="btn btn-secondary btn-small" data-id="${p.id}" data-name="${p.name}">Einzahlung</button></td>
    `;
    tr.querySelector("button").addEventListener("click", () => depositPrompt(p.id, p.name));
    body.appendChild(tr);
  });
}

async function depositPrompt(id, name) {
  const amountStr = prompt(`Einzahlungsbetrag für ${name} in €:`);
  if (amountStr === null) return;
  const amount = parseFloat(amountStr.replace(",", "."));
  if (isNaN(amount) || amount === 0) { alert("Ungültiger Betrag."); return; }

  const { error } = await supabaseClient.rpc("admin_deposit", {
    target_id: id,
    deposit_amount: amount,
    deposit_note: "Einzahlung über Website",
  });
  if (error) { alert("Fehler: " + error.message); return; }
  await loadOverview();
}

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
          <button type="button" class="btn btn-secondary btn-small" data-edit-entry="${e.id}">Bearbeiten</button>
          <button type="button" class="btn btn-danger btn-small" data-delete-entry="${e.id}">Löschen</button>
        </div>
      `;
      actionCell.querySelector("[data-edit-entry]").addEventListener("click", () => openEditEntry(e));
      actionCell.querySelector("[data-delete-entry]").addEventListener("click", (event) => deleteEntry(e, event.currentTarget));
      tr.appendChild(actionCell);
    }

    body.appendChild(tr);
  });
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
      $("userBalanceAmount").textContent = fmtMoney(profile.balance);
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
  const confirmed = confirm(
    `Spielschein ${entry.receipt_number} vom ${formatDate(entry.entry_date)} wirklich löschen?` +
    " Verrechnete Kosten und Gewinne werden in den Kontoständen zurückgerechnet."
  );
  if (!confirmed) return;

  button.disabled = true;
  button.textContent = "Lösche …";
  const { error } = await supabaseClient.rpc("admin_delete_entry", { target_entry_id: entry.id });
  if (error) {
    button.disabled = false;
    button.textContent = "Löschen";
    alert("Fehler beim Löschen: " + error.message);
    return;
  }

  await loadEntries();
  await loadOverview();
}

// ---------- Admin: Win2Day Abfrage ----------
async function queryReceiptData(fields, button, statusEl) {
  const receipt = $(fields.receipt).value.trim();
  if (!receipt) { statusEl.textContent = "Bitte zuerst eine Quittungsnummer eingeben."; return; }
  statusEl.textContent = "Lese Spielschein-Daten aus …";
  button.disabled = true;

  try {
    const { data, error } = await supabaseClient.functions.invoke("win2day-query", {
      body: { receiptNumber: receipt },
    });
    if (error) throw error;
    if (data.error) { statusEl.textContent = data.error; return; }
    if ($(fields.receipt).value.trim() !== receipt) return;

    if (data.gameType) $(fields.gameType).value = data.gameType;
    if (typeof data.cost === "number") $(fields.cost).value = data.cost;
    if (typeof data.gewinn === "number") $(fields.gewinn).value = data.gewinn;
    if (data.drawDates && data.drawDates.length) $(fields.drawDates).value = data.drawDates.join(", ");

    statusEl.textContent = data.note || "Daten übernommen – bitte prüfen.";
  } catch (err) {
    statusEl.textContent = "Automatische Abfrage nicht möglich. Bitte Daten manuell eintragen.";
  } finally {
    button.disabled = false;
  }
}

const newEntryFields = {
  receipt: "entryReceipt",
  gameType: "entryGameType",
  cost: "entryCost",
  gewinn: "entryGewinn",
  drawDates: "entryDrawDates",
};

$("queryWin2dayBtn").addEventListener("click", () => {
  clearTimeout(receiptLookupTimer);
  queryReceiptData(newEntryFields, $("queryWin2dayBtn"), $("win2dayStatus"));
});

$("entryReceipt").addEventListener("input", () => {
  clearTimeout(receiptLookupTimer);
  if ($("queryWin2dayBtn").classList.contains("hidden")) return;
  if ($("entryReceipt").value.replace(/\s+/g, "").length < 6) return;
  receiptLookupTimer = setTimeout(() => {
    if (!$("queryWin2dayBtn").classList.contains("hidden")) {
      queryReceiptData(newEntryFields, $("queryWin2dayBtn"), $("win2dayStatus"));
    }
  }, 900);
});

function setEntryMode(mode) {
  const isManual = mode === "manual";
  if (isManual) clearTimeout(receiptLookupTimer);
  document.querySelectorAll("[data-entry-mode]").forEach((item) => {
    const selected = item.dataset.entryMode === mode;
    item.classList.toggle("active", selected);
    item.setAttribute("aria-pressed", String(selected));
  });
  $("queryWin2dayBtn").classList.toggle("hidden", isManual);
  $("entryModeHint").textContent = isManual
    ? "Daten des alten Scheins manuell eintragen. Nur die Quittungsnummer ist verpflichtend."
    : "Nur die Quittungsnummer ist verpflichtend. Die übrigen Daten werden nach Möglichkeit automatisch ergänzt.";
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
  $("win2dayStatus").textContent = "";
  $("newEntryError").textContent = "";
  setEntryMode("current");
  show($("newEntryModal"));
  $("entryReceipt").focus();
}

function closeNewEntry() {
  clearTimeout(receiptLookupTimer);
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
    game_type: $("entryGameType").value.trim() || "Unbekannt",
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
  $("win2dayStatus").textContent = "";
  closeNewEntry();
  await loadEntries();
  await loadOverview();
});

// ---------- Admin: Spielschein bearbeiten ----------
function openEditEntry(entry) {
  $("editEntryId").value = entry.id;
  $("editEntryReceipt").value = entry.receipt_number;
  $("editEntryDate").value = entry.entry_date || "";
  $("editEntryGameType").value = entry.game_type || "";
  $("editEntryCost").value = Number(entry.cost || 0);
  $("editEntryGewinn").value = Number(entry.gewinn || 0);
  $("editEntryDrawDates").value = (entry.draw_dates || []).join(", ");
  $("editEntryStatus").textContent = "Änderungen an Kosten oder Gewinn werden automatisch neu aufgeteilt.";
  show($("editEntryModal"));
  $("editEntryReceipt").focus();
}

function closeEditEntry() {
  hide($("editEntryModal"));
  $("editEntryForm").reset();
}

$("closeEditEntryBtn").addEventListener("click", closeEditEntry);
$("cancelEditEntryBtn").addEventListener("click", closeEditEntry);
$("editQueryWin2dayBtn").addEventListener("click", () => {
  queryReceiptData({
    receipt: "editEntryReceipt",
    gameType: "editEntryGameType",
    cost: "editEntryCost",
    gewinn: "editEntryGewinn",
    drawDates: "editEntryDrawDates",
  }, $("editQueryWin2dayBtn"), $("editEntryStatus"));
});

$("editEntryForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const submitButton = $("saveEditEntryBtn");
  submitButton.disabled = true;
  $("editEntryStatus").textContent = "Änderungen werden gespeichert …";

  const payload = {
    entry_date: $("editEntryDate").value || todayIso(),
    receipt_number: $("editEntryReceipt").value.trim(),
    game_type: $("editEntryGameType").value.trim() || "Unbekannt",
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

[$("newEntryModal"), $("editEntryModal")].forEach((overlay) => {
  overlay.addEventListener("click", (event) => {
    if (event.target !== overlay) return;
    if (overlay === $("newEntryModal")) closeNewEntry();
    else closeEditEntry();
  });
});

document.addEventListener("keydown", (event) => {
  if (event.key !== "Escape") return;
  if (!$("newEntryModal").classList.contains("hidden")) closeNewEntry();
  if (!$("editEntryModal").classList.contains("hidden")) closeEditEntry();
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
      if (error) alert("Fehler: " + error.message);
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
      if (error) { alert("Fehler: " + error.message); return; }
      await loadOverview();
      alert("Kontostand aktualisiert.");
    });
  });

  body.querySelectorAll("button[data-toggle-active]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const id = btn.getAttribute("data-toggle-active");
      const isCurrentlyActive = btn.getAttribute("data-current") === "true";
      const newActive = !isCurrentlyActive;
      const label = newActive ? "aktivieren" : "deaktivieren";
      if (!confirm(`Diesen Spieler wirklich ${label}?`)) return;

      const { error } = await supabaseClient.rpc("admin_set_active", {
        target_id: id,
        new_active: newActive,
      });
      if (error) { alert("Fehler: " + error.message); return; }
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
