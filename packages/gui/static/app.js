// Camino GUI logic: the WP-102 client contract (token in sessionStorage
// only, Authorization: Bearer on every /api call, X-Camino-Csrf on every
// state-changing call) plus the WP-122 gap register.
//
// CAM-CORE-10, client half: the ONLY canon/requirement data this page
// ever holds is the /api/register response (a ledger projection computed
// daemon-side). Rendering is display-only — rows are shown verbatim
// (canonical state tokens, statements as textContent), filtered by exact
// field matches; nothing here derives, merges, or reinterprets
// requirement state, and no other source for it exists in the page.

const TOKEN_KEY = "camino-gui-token";

const el = (id) => document.getElementById(id);
const show = (id, visible) => {
  el(id).hidden = !visible;
};
const message = (text) => {
  el("message").textContent = text;
};

let csrfToken;
let registerSnapshot; // the last /api/register response (ledger projection)

function readTokenFromFragment() {
  const match = /[#&]token=([A-Za-z0-9_-]+)/.exec(location.hash);
  if (!match) return undefined;
  // Strip the fragment so the token does not linger in the location bar.
  history.replaceState(null, "", location.pathname + location.search);
  return match[1];
}

async function api(path, options = {}) {
  const token = sessionStorage.getItem(TOKEN_KEY);
  const headers = { authorization: `Bearer ${token}`, ...options.headers };
  const response = await fetch(path, { ...options, headers });
  if (response.status === 401) {
    sessionStorage.removeItem(TOKEN_KEY);
    render();
    throw new Error("token rejected");
  }
  if (!response.ok) {
    // Register refusals carry a JSON problem statement worth surfacing.
    let detail = "";
    try {
      const body = await response.json();
      if (typeof body.problem === "string") detail = `: ${body.problem}`;
      else if (typeof body.error === "string") detail = `: ${body.error}`;
    } catch {
      // Non-JSON error body — the status alone will do.
    }
    const error = new Error(`${path} → ${response.status}${detail}`);
    error.status = response.status;
    throw error;
  }
  return response.json();
}

async function connect() {
  const health = await api("/api/health");
  csrfToken = (await api("/api/csrf")).csrfToken;
  el("health").textContent = health.status;
  el("origin").textContent = location.origin;
  message("");
  await loadRegister();
}

// ——— Gap register (WP-122) ———

async function loadRegister() {
  registerSnapshot = await api("/api/register");
  renderRegister();
}

function currentFilters() {
  return {
    disposition: el("filter-disposition").value,
    implementation: el("filter-implementation").value,
    evidence: el("filter-evidence").value,
    text: el("filter-text").value.trim().toLowerCase(),
  };
}

function rowMatchesFilters(row, filters) {
  if (filters.disposition && row.disposition !== filters.disposition) return false;
  if (filters.implementation && row.tuple.implementation.kind !== filters.implementation) {
    return false;
  }
  if (filters.evidence && row.tuple.evidence !== filters.evidence) return false;
  if (filters.text) {
    const haystack = `${row.requirementId} ${row.statement}`.toLowerCase();
    if (!haystack.includes(filters.text)) return false;
  }
  return true;
}

function implementationLabel(implementation) {
  return implementation.kind === "present-on"
    ? `present-on(${implementation.branch})`
    : implementation.kind;
}

/** A short human line for one provenance fact (display only). */
function provenanceLine(fact) {
  const detail =
    typeof fact.payload.reason === "string"
      ? ` — ${fact.payload.reason}`
      : typeof fact.payload.outcome === "string"
        ? ` — ${fact.payload.outcome}`
        : "";
  return `seq ${fact.seq} · ${fact.kind} · ${fact.actor}${detail}`;
}

function cell(parent, className) {
  const td = document.createElement("td");
  td.className = className;
  parent.appendChild(td);
  return td;
}

function addLine(parent, className, text) {
  const div = document.createElement("div");
  div.className = className;
  div.textContent = text;
  parent.appendChild(div);
  return div;
}

function actionButton(parent, label, className, handler) {
  const button = document.createElement("button");
  button.type = "button";
  button.textContent = label;
  button.className = className;
  button.addEventListener("click", handler);
  parent.appendChild(button);
  return button;
}

async function actOnRow(path, body) {
  try {
    const result = await api(path, {
      method: "POST",
      headers: { "x-camino-csrf": csrfToken, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    registerSnapshot = result.snapshot;
    renderRegister();
    message("");
  } catch (error) {
    if (error.status === 403) {
      // A daemon restart rotates the per-process CSRF token, so a held token is
      // rejected with 403 (round 3, finding 7). Re-fetch it and reload the
      // register once, so an open tab recovers without a manual page reload.
      try {
        csrfToken = (await api("/api/csrf")).csrfToken;
        await loadRegister();
        message("Reconnected to the daemon — re-try the action.");
        return;
      } catch {
        // Fall through to surfacing the original error below.
      }
    }
    if (error.status === 409) {
      // The register advanced or the action was refused: re-read so the
      // table shows the current ledger projection, then surface the reason.
      await loadRegister().catch(() => {});
    }
    message(String(error.message ?? error));
  }
}

function renderRow(row, tbody) {
  const tr = document.createElement("tr");
  tr.className = "register-row";
  tr.dataset.requirementId = row.requirementId;
  tr.dataset.disposition = row.disposition;
  tr.dataset.implementation = row.tuple.implementation.kind;
  tr.dataset.evidence = row.tuple.evidence;
  tr.dataset.intentDisposition = row.tuple.disposition;
  tr.dataset.waivable = row.waivableThroughSeq === null ? "false" : "true";
  // Exact machine values, so the CAM-CORE-10 agreement test compares the whole
  // row — not just its presence — against the ledger projection.
  tr.dataset.waivableThroughSeq =
    row.waivableThroughSeq === null ? "" : String(row.waivableThroughSeq);
  if (row.tuple.implementation.kind === "present-on") {
    tr.dataset.implementationBranch = row.tuple.implementation.branch;
  }
  tr.dataset.provenanceSeqs = row.provenance.map((f) => f.seq).join(",");
  tr.dataset.detectorSeqs = row.detectorFindings.map((f) => f.seq).join(",");
  if (row.dispositionRecord !== null) {
    tr.dataset.dispositionRecordSeq = String(row.dispositionRecord.seq);
    tr.dataset.dispositionRecordEvent = row.dispositionRecord.event;
  }

  const requirement = cell(tr, "col-requirement");
  addLine(requirement, "requirement-id", row.requirementId);
  addLine(requirement, "requirement-statement", row.statement);
  if (row.assumption !== null) {
    addLine(requirement, "requirement-assumption", `assumption: ${row.assumption}`);
  }

  const tuple = cell(tr, "col-tuple");
  addLine(tuple, "tuple-intent", row.tuple.disposition);
  addLine(tuple, "tuple-implementation", implementationLabel(row.tuple.implementation));
  addLine(tuple, "tuple-evidence", row.tuple.evidence);

  const provenance = cell(tr, "col-provenance");
  if (row.provenance.length === 0) {
    addLine(provenance, "provenance-empty", "no recorded facts in this context");
  } else {
    for (const fact of row.provenance) {
      addLine(provenance, "provenance-fact", provenanceLine(fact));
    }
  }

  const disposition = cell(tr, "col-disposition");
  addLine(disposition, "disposition-value", row.disposition);
  if (row.dispositionRecord !== null) {
    addLine(disposition, "disposition-reason", row.dispositionRecord.reason);
  }

  const actions = cell(tr, "col-actions");
  const reason = document.createElement("input");
  reason.type = "text";
  reason.placeholder = "reason";
  reason.className = "action-reason";
  actions.appendChild(reason);
  const withReason = (fn) => () => {
    if (reason.value.trim().length === 0) {
      message("Every register action records a reason — fill the reason field first.");
      return;
    }
    fn(reason.value.trim());
  };
  const dispositionPath = `/api/register/${row.requirementId}/disposition`;
  const post = (body) => actOnRow(dispositionPath, { ...body, asOf: registerSnapshot.asOf });
  actionButton(
    actions,
    "Queue fix",
    "action-fix-queued",
    withReason((value) => post({ action: "fix-queued", reason: value })),
  );
  actionButton(
    actions,
    "Dispute",
    "action-disputed",
    withReason((value) => post({ action: "disputed", reason: value })),
  );
  if (row.waivableThroughSeq !== null) {
    // Rendered ONLY for rows whose outstanding suspicions are all
    // detector-authored; the daemon refuses it everywhere else — the
    // button's absence mirrors the CAM-CANON-05 rule, the server
    // enforces it.
    actionButton(
      actions,
      "Waive false positive",
      "action-waive",
      withReason((value) =>
        post({
          action: "false-positive-waived",
          reason: value,
          waivedThroughSeq: row.waivableThroughSeq,
        }),
      ),
    );
  }
  if (row.disposition !== "open") {
    actionButton(
      actions,
      "Reopen",
      "action-reopened",
      withReason((value) => post({ action: "reopened", reason: value })),
    );
  }
  actionButton(
    actions,
    "Descope requirement",
    "action-descope",
    withReason((value) =>
      actOnRow(`/api/register/${row.requirementId}/descope`, {
        reason: value,
        asOf: registerSnapshot.asOf,
      }),
    ),
  );

  tbody.appendChild(tr);
}

function renderRegister() {
  show("register", true);
  if (!registerSnapshot || registerSnapshot.available !== true) {
    show("register-unavailable", true);
    show("register-controls", false);
    return;
  }
  show("register-unavailable", false);
  show("register-controls", true);
  const filters = currentFilters();
  const visible = registerSnapshot.rows.filter((row) => rowMatchesFilters(row, filters));
  const tbody = el("register-rows");
  tbody.replaceChildren();
  for (const row of visible) renderRow(row, tbody);
  el("register-count").textContent =
    `${visible.length} of ${registerSnapshot.rows.length} register rows shown ` +
    `(ledger seq ${registerSnapshot.asOf.ledgerSeq}, facts seq ${registerSnapshot.asOf.factsSeq}, ` +
    `dispositions seq ${registerSnapshot.asOf.dispositionsSeq})`;
  show("register-empty", visible.length === 0);
  show("register-table", visible.length > 0);
}

for (const id of ["filter-disposition", "filter-implementation", "filter-evidence"]) {
  el(id).addEventListener("change", renderRegister);
}
el("filter-text").addEventListener("input", renderRegister);

// ——— Shell ———

function render() {
  const haveToken = sessionStorage.getItem(TOKEN_KEY) !== null;
  show("connect", !haveToken);
  show("status", haveToken);
  if (!haveToken) show("register", false);
  if (haveToken) {
    connect().catch((error) => message(String(error.message ?? error)));
  }
}

el("token-form").addEventListener("submit", (event) => {
  event.preventDefault();
  const value = el("token-input").value.trim();
  if (value.length === 0) return;
  sessionStorage.setItem(TOKEN_KEY, value);
  el("token-input").value = "";
  render();
});

el("shutdown").addEventListener("click", async () => {
  try {
    await api("/api/shutdown", { method: "POST", headers: { "x-camino-csrf": csrfToken } });
    message("Daemon is stopping.");
  } catch (error) {
    message(String(error.message ?? error));
  }
});

el("disconnect").addEventListener("click", () => {
  sessionStorage.removeItem(TOKEN_KEY);
  message("");
  render();
});

const fragmentToken = readTokenFromFragment();
if (fragmentToken !== undefined) {
  sessionStorage.setItem(TOKEN_KEY, fragmentToken);
}
render();
