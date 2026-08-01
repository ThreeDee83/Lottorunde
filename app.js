const supabaseClient = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

let currentProfile = null; // { id, name, role, balance }
let allEntries = [];
let allProfiles = [];
let activeEntryFilter = "month";
let appDialogResolver = null;
let pendingTransactionDelete = null;

// ---------- Helpers ----------
const fmtMoney = (n) =>
  Number(n || 0).toLocaleString("de-AT", { style: "currency", currency: "EUR" });

const $ = (id) => document.getElementById(id);

function show(el) { el.classList.remove("hidden"); }
function hide(el) { el.classList.add("hidden"); }

function formatDate(dateString) {
  if (!dateString) return "-";
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(dateString);
  if (!match) return "-";
  return `${match[3]}.${match[2]}.${match[1]}`;
}

function formatDateTime(value) {
  if (!value) return "-";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "-";
  const pad = (number) => String(number).padStart(2, "0");
  return `${pad(date.getDate())}.${pad(date.getMonth() + 1)}.${date.getFullYear()}, ${pad(date.getHours())}:${pad(date.getMinutes())}`;
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
    .filter(Boolean)
    .map((item) => {
      const displayDate = /^(\d{2})\.(\d{2})\.(\d{4})$/.exec(item);
      return displayDate ? `${displayDate[3]}-${displayDate[2]}-${displayDate[1]}` : item;
    });
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
    tr.className = "profile-history-card";
    tr.tabIndex = 0;
    tr.setAttribute("role", "button");
    tr.setAttribute("aria-label", `Einzahlungsverlauf von ${p.name} öffnen`);
    tr.innerHTML = `
      <td data-label="Name" class="profile-card-name">${p.name}</td>
      <td data-label="Kontostand" class="mono profile-card-balance ${balanceToneClass(p.balance)}">${fmtMoney(p.balance)}</td>
    `;
    tr.addEventListener("click", () => openPlayerDeposits(p));
    tr.addEventListener("keydown", (event) => {
      if (event.key !== "Enter" && event.key !== " ") return;
      event.preventDefault();
      openPlayerDeposits(p);
    });
    body.appendChild(tr);
  });
}

function appendTableRow(body, cells, rowClass = "") {
  const tr = document.createElement("tr");
  if (rowClass) tr.className = rowClass;
  cells.forEach(({ label, text, className = "" }) => {
    const td = document.createElement("td");
    td.dataset.label = label;
    if (className) td.className = className;
    td.textContent = text;
    tr.appendChild(td);
  });
  body.appendChild(tr);
  return tr;
}

function renderHistoryEmpty(body, colSpan, message) {
  const tr = document.createElement("tr");
  tr.className = "empty-row";
  const td = document.createElement("td");
  td.colSpan = colSpan;
  td.textContent = message;
  tr.appendChild(td);
  body.appendChild(tr);
}

async function openPlayerDeposits(profile) {
  if (currentProfile?.role !== "admin") return;
  $("playerDepositsTitle").textContent = `Einzahlungen – ${profile.name}`;
  $("playerDepositsTotal").textContent = fmtMoney(0);
  $("playerDepositsStatus").textContent = "Einzahlungen werden geladen …";
  $("playerDepositsBody").innerHTML = "";
  show($("playerDepositsModal"));
  $("closePlayerDepositsBtn").focus();

  const { data, error } = await supabaseClient
    .from("transactions")
    .select("id, amount, note, created_at")
    .eq("profile_id", profile.id)
    .eq("type", "deposit")
    .eq("hidden", false)
    .order("created_at", { ascending: false });

  if (error) {
    $("playerDepositsStatus").textContent = "Einzahlungsverlauf konnte nicht geladen werden.";
    renderHistoryEmpty($("playerDepositsBody"), 4, "Keine Daten verfügbar.");
    return;
  }

  const deposits = data || [];
  const total = deposits.reduce((sum, item) => sum + Number(item.amount || 0), 0);
  $("playerDepositsTotal").textContent = fmtMoney(total);
  $("playerDepositsStatus").textContent = `${deposits.length} ${deposits.length === 1 ? "Einzahlung" : "Einzahlungen"}`;

  if (!deposits.length) {
    renderHistoryEmpty($("playerDepositsBody"), 4, "Für diesen Spieler sind noch keine Einzahlungen vorhanden.");
    return;
  }

  deposits.forEach((deposit) => {
    const row = appendTableRow($("playerDepositsBody"), [
      { label: "Datum", text: formatDateTime(deposit.created_at) },
      { label: "Betrag", text: fmtMoney(deposit.amount), className: "mono transaction-deposit" },
      { label: "Beschreibung", text: deposit.note || "Einzahlung" },
    ], "transaction-row transaction-row-deposit");
    addTransactionDeleteControls(row, {
      ...deposit,
      type: "deposit",
      profileName: profile.name,
    }, () => openPlayerDeposits(profile));
  });
}

function closePlayerDeposits() {
  hide($("playerDepositsModal"));
}

function transactionTypeMeta(type) {
  const types = {
    deposit: { label: "Einzahlung", className: "transaction-deposit", rowClass: "transaction-row-deposit" },
    win_share: { label: "Gewinn", className: "transaction-win", rowClass: "transaction-row-win" },
    stake_share: { label: "Scheinkosten", className: "transaction-stake", rowClass: "transaction-row-stake" },
    correction: { label: "Korrektur", className: "transaction-correction", rowClass: "transaction-row-correction" },
  };
  return types[type] || { label: type, className: "", rowClass: "" };
}

async function openTransactionsLog() {
  if (currentProfile?.role !== "admin") return;
  $("transactionsLogStatus").textContent = "Transaktionen werden geladen …";
  $("transactionsLogBody").innerHTML = "";
  show($("transactionsLogModal"));
  $("closeTransactionsLogBtn").focus();

  const { data, error } = await supabaseClient
    .from("transactions")
    .select("id, profile_id, amount, type, note, created_at")
    .eq("hidden", false)
    .order("created_at", { ascending: false });

  if (error) {
    $("transactionsLogStatus").textContent = "Transaktionslog konnte nicht geladen werden.";
    renderHistoryEmpty($("transactionsLogBody"), 6, "Keine Daten verfügbar.");
    return;
  }

  const transactions = data || [];
  const profileNames = new Map(allProfiles.map((profile) => [profile.id, profile.name]));
  $("transactionsLogStatus").textContent = `${transactions.length} ${transactions.length === 1 ? "Transaktion" : "Transaktionen"}`;

  if (!transactions.length) {
    renderHistoryEmpty($("transactionsLogBody"), 6, "Es sind noch keine Transaktionen vorhanden.");
    return;
  }

  transactions.forEach((transaction) => {
    const meta = transactionTypeMeta(transaction.type);
    const profileName = profileNames.get(transaction.profile_id) || "Unbekannter Spieler";
    const row = appendTableRow($("transactionsLogBody"), [
      { label: "Datum", text: formatDateTime(transaction.created_at) },
      { label: "Spieler", text: profileName },
      { label: "Art", text: meta.label, className: `transaction-badge ${meta.className}` },
      { label: "Betrag", text: fmtMoney(transaction.amount), className: `mono ${meta.className}` },
      { label: "Beschreibung", text: transaction.note || "-" },
    ], `transaction-row ${meta.rowClass}`);
    addTransactionDeleteControls(row, {
      ...transaction,
      profileName,
    }, openTransactionsLog);
  });
}

function closeTransactionsLog() {
  hide($("transactionsLogModal"));
}

function addTransactionDeleteControls(row, transaction, refresh) {
  const actionCell = document.createElement("td");
  actionCell.className = "history-actions";
  actionCell.dataset.label = "Aktion";
  const button = document.createElement("button");
  button.type = "button";
  button.className = "btn btn-danger btn-icon";
  button.setAttribute("aria-label", "Logzeile löschen");
  button.title = "Logzeile löschen";
  button.innerHTML = '<span class="material-symbols-rounded" aria-hidden="true">delete</span>';
  button.addEventListener("click", () => openTransactionDeleteConfirm(transaction, refresh));
  actionCell.appendChild(button);
  row.appendChild(actionCell);
  attachTransactionSwipe(row, () => openTransactionDeleteConfirm(transaction, refresh));
}

function attachTransactionSwipe(row, onDelete) {
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
    row.classList.add("log-swipe-tracking");
  }, { passive: true });

  row.addEventListener("touchmove", (event) => {
    if (event.touches.length !== 1) return;
    deltaX = event.touches[0].clientX - startX;
    const deltaY = event.touches[0].clientY - startY;
    isHorizontal = Math.abs(deltaX) > 10 && Math.abs(deltaX) > Math.abs(deltaY) * 1.2;
    if (!isHorizontal || deltaX > 0) return;
    row.style.transform = `translateX(${Math.max(-88, deltaX)}px)`;
    row.classList.add("log-swipe-delete");
  }, { passive: true });

  const finish = () => {
    row.classList.remove("log-swipe-tracking", "log-swipe-delete");
    row.style.transform = "";
    if (isHorizontal && deltaX < -72) onDelete();
    isHorizontal = false;
    deltaX = 0;
  };

  row.addEventListener("touchend", finish, { passive: true });
  row.addEventListener("touchcancel", () => {
    isHorizontal = false;
    finish();
  }, { passive: true });
}

function deletePhraseMatches(value) {
  return value.trim() === "LÖSCHEN";
}

function openTransactionDeleteConfirm(transaction, refresh) {
  const meta = transactionTypeMeta(transaction.type);
  pendingTransactionDelete = { transaction, refresh };
  $("deleteTransactionMessage").textContent = `${meta.label} über ${fmtMoney(transaction.amount)} für ${transaction.profileName} vom ${formatDateTime(transaction.created_at)} löschen?`;
  $("deleteTransactionConfirmText").value = "";
  $("deleteTransactionStatus").textContent = "";
  $("confirmDeleteTransactionBtn").disabled = true;
  show($("deleteTransactionModal"));
  $("deleteTransactionConfirmText").focus();
}

function closeTransactionDeleteConfirm() {
  hide($("deleteTransactionModal"));
  pendingTransactionDelete = null;
  $("deleteTransactionForm").reset();
}

function populateClearLogScopes() {
  const select = $("clearLogScope");
  select.innerHTML = "";
  const placeholder = document.createElement("option");
  placeholder.value = "";
  placeholder.textContent = "Spieler oder gesamten Log wählen";
  placeholder.disabled = true;
  placeholder.selected = true;
  select.appendChild(placeholder);

  const allOption = document.createElement("option");
  allOption.value = "all";
  allOption.textContent = "Gesamter Transaktionslog";
  select.appendChild(allOption);

  allProfiles.forEach((profile) => {
    const option = document.createElement("option");
    option.value = profile.id;
    option.textContent = `Nur ${profile.name}`;
    select.appendChild(option);
  });
}

function updateClearLogButton() {
  $("confirmClearLogBtn").disabled = !$("clearLogScope").value || !deletePhraseMatches($("clearLogConfirmText").value);
}

function openClearLog() {
  if (currentProfile?.role !== "admin") return;
  $("clearLogForm").reset();
  $("clearLogStatus").textContent = "";
  populateClearLogScopes();
  updateClearLogButton();
  show($("clearLogModal"));
  $("closeClearLogBtn").focus();
}

function closeClearLog() {
  hide($("clearLogModal"));
  $("clearLogForm").reset();
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
  $("editEntryDrawDates").value = (entry.draw_dates || []).map(formatDate).join(", ");
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

$("closePlayerDepositsBtn").addEventListener("click", closePlayerDeposits);
$("closePlayerDepositsActionBtn").addEventListener("click", closePlayerDeposits);
$("openTransactionsLogBtn").addEventListener("click", openTransactionsLog);
$("closeTransactionsLogBtn").addEventListener("click", closeTransactionsLog);
$("closeTransactionsLogActionBtn").addEventListener("click", closeTransactionsLog);
$("openClearLogBtn").addEventListener("click", openClearLog);
$("closeClearLogBtn").addEventListener("click", closeClearLog);
$("cancelClearLogBtn").addEventListener("click", closeClearLog);
$("clearLogScope").addEventListener("change", updateClearLogButton);
$("clearLogConfirmText").addEventListener("input", updateClearLogButton);
$("closeDeleteTransactionBtn").addEventListener("click", closeTransactionDeleteConfirm);
$("cancelDeleteTransactionBtn").addEventListener("click", closeTransactionDeleteConfirm);
$("deleteTransactionConfirmText").addEventListener("input", () => {
  $("confirmDeleteTransactionBtn").disabled = !deletePhraseMatches($("deleteTransactionConfirmText").value);
});

$("clearLogForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const scope = $("clearLogScope").value;
  if (!scope || !deletePhraseMatches($("clearLogConfirmText").value)) return;

  const button = $("confirmClearLogBtn");
  button.disabled = true;
  $("clearLogStatus").textContent = "Log wird gelöscht …";
  const { data, error } = await supabaseClient.rpc("admin_clear_transaction_log", {
    target_profile_id: scope === "all" ? null : scope,
  });

  if (error) {
    $("clearLogStatus").textContent = "Log konnte nicht gelöscht werden: " + error.message;
    updateClearLogButton();
    return;
  }

  closeClearLog();
  await showAppDialog({
    title: "Log gelöscht",
    message: `${Number(data || 0)} sichtbare Logzeilen wurden entfernt. Kontostände bleiben unverändert.`,
  });
});

$("deleteTransactionForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!pendingTransactionDelete || !deletePhraseMatches($("deleteTransactionConfirmText").value)) return;

  const pending = pendingTransactionDelete;
  const button = $("confirmDeleteTransactionBtn");
  button.disabled = true;
  $("deleteTransactionStatus").textContent = "Logzeile wird gelöscht …";
  const { error } = await supabaseClient.rpc("admin_hide_transaction", {
    target_transaction_id: pending.transaction.id,
  });

  if (error) {
    $("deleteTransactionStatus").textContent = "Logzeile konnte nicht gelöscht werden: " + error.message;
    button.disabled = false;
    return;
  }

  closeTransactionDeleteConfirm();
  await pending.refresh();
});

[$("newEntryModal"), $("editEntryModal"), $("depositModal"), $("entryDetailsModal"), $("playerDepositsModal"), $("transactionsLogModal"), $("clearLogModal"), $("deleteTransactionModal")].forEach((overlay) => {
  overlay.addEventListener("click", (event) => {
    if (event.target !== overlay) return;
    if (overlay === $("newEntryModal")) closeNewEntry();
    else if (overlay === $("editEntryModal")) closeEditEntry();
    else if (overlay === $("entryDetailsModal")) closeEntryDetails();
    else if (overlay === $("playerDepositsModal")) closePlayerDeposits();
    else if (overlay === $("transactionsLogModal")) closeTransactionsLog();
    else if (overlay === $("clearLogModal")) closeClearLog();
    else if (overlay === $("deleteTransactionModal")) closeTransactionDeleteConfirm();
    else closeDeposit();
  });
});

document.addEventListener("keydown", (event) => {
  if (event.key !== "Escape") return;
  if (!$("appDialogModal").classList.contains("hidden")) {
    closeAppDialog(false);
    return;
  }
  if (!$("deleteTransactionModal").classList.contains("hidden")) {
    closeTransactionDeleteConfirm();
    return;
  }
  if (!$("clearLogModal").classList.contains("hidden")) {
    closeClearLog();
    return;
  }
  if (!$("depositModal").classList.contains("hidden")) closeDeposit();
  if (!$("newEntryModal").classList.contains("hidden")) closeNewEntry();
  if (!$("editEntryModal").classList.contains("hidden")) closeEditEntry();
  if (!$("entryDetailsModal").classList.contains("hidden")) closeEntryDetails();
  if (!$("playerDepositsModal").classList.contains("hidden")) closePlayerDeposits();
  if (!$("transactionsLogModal").classList.contains("hidden")) closeTransactionsLog();
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
