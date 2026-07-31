const supabaseClient = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

let currentProfile = null; // { id, name, role, balance }
let allEntries = [];
let activeEntryFilter = "month";

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
    $("entryDate").valueAsDate = new Date();
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
    td.colSpan = currentProfile.role === "admin" ? 6 : 5;
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
      <td data-label="Gewinn" class="mono ${e.gewinn > 0 ? "amount-positive" : ""}">${fmtMoney(e.gewinn)}</td>
    `;

    if (currentProfile.role === "admin") {
      const actionCell = document.createElement("td");
      actionCell.className = "entry-actions";
      actionCell.dataset.label = "Aktionen";
      actionCell.innerHTML = `<button type="button" class="btn btn-danger btn-small" data-delete-entry="${e.id}">Löschen</button>`;
      actionCell.querySelector("button").addEventListener("click", (event) => deleteEntry(e, event.currentTarget));
      tr.appendChild(actionCell);
    }

    body.appendChild(tr);
  });
}

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
    (Number(entry.gewinn) > 0 ? " Der gutgeschriebene Gewinn wird von den Kontoständen zurückgerechnet." : "")
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
$("queryWin2dayBtn").addEventListener("click", async () => {
  const receipt = $("entryReceipt").value.trim();
  const statusEl = $("win2dayStatus");
  if (!receipt) { statusEl.textContent = "Bitte zuerst eine Quittungsnummer eingeben."; return; }
  statusEl.textContent = "Frage bei Win2Day ab …";

  try {
    const { data, error } = await supabaseClient.functions.invoke("win2day-query", {
      body: { receiptNumber: receipt },
    });
    if (error) throw error;
    if (data.error) { statusEl.textContent = data.error; return; }

    if (data.gameType) $("entryGameType").value = data.gameType;
    if (typeof data.gewinn === "number") $("entryGewinn").value = data.gewinn;
    if (data.drawDates && data.drawDates.length) $("entryDrawDates").value = data.drawDates.join(", ");

    statusEl.textContent = data.note || "Daten übernommen – bitte prüfen.";
  } catch (err) {
    statusEl.textContent = "Automatische Abfrage nicht möglich. Bitte Daten manuell eintragen.";
  }
});

document.querySelectorAll("[data-entry-mode]").forEach((button) => {
  button.addEventListener("click", () => {
    const isManual = button.dataset.entryMode === "manual";
    document.querySelectorAll("[data-entry-mode]").forEach((item) => {
      const selected = item === button;
      item.classList.toggle("active", selected);
      item.setAttribute("aria-pressed", String(selected));
    });
    $("queryWin2dayBtn").classList.toggle("hidden", isManual);
    $("entryModeHint").textContent = isManual
      ? "Datum, ältere Quittungsnummer und Ziehungsdaten vollständig manuell eintragen."
      : "Quittungsnummer eingeben und Daten bei Win2Day abfragen.";
    $("entryDate").focus();
  });
});

// ---------- Admin: Neuer Datensatz ----------
$("newEntryForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  $("newEntryError").textContent = "";

  const drawDatesRaw = $("entryDrawDates").value.trim();
  const drawDates = drawDatesRaw
    ? drawDatesRaw.split(",").map((s) => s.trim()).filter(Boolean)
    : [];

  const payload = {
    entry_date: $("entryDate").value,
    receipt_number: $("entryReceipt").value.trim(),
    game_type: $("entryGameType").value,
    draw_dates: drawDates,
    gewinn: parseFloat($("entryGewinn").value) || 0,
    created_by: currentProfile.id,
  };

  const { error } = await supabaseClient.from("entries").insert(payload);
  if (error) {
    $("newEntryError").textContent = "Fehler: " + error.message;
    return;
  }

  $("newEntryForm").reset();
  $("entryDate").valueAsDate = new Date();
  $("win2dayStatus").textContent = "";
  await loadEntries();
  await loadOverview();
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
