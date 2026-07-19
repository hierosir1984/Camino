// Placeholder GUI logic (WP-102). Demonstrates the full client side of the
// CAM-CORE-01 contract: hold the token (sessionStorage only — never a cookie,
// never a query parameter), send it as Authorization: Bearer on every /api
// call, fetch the CSRF token once, and send it in X-Camino-Csrf on every
// state-changing call.

const TOKEN_KEY = "camino-gui-token";

const el = (id) => document.getElementById(id);
const show = (id, visible) => {
  el(id).hidden = !visible;
};
const message = (text) => {
  el("message").textContent = text;
};

let csrfToken;

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
  if (!response.ok) throw new Error(`${path} → ${response.status}`);
  return response.json();
}

async function connect() {
  const health = await api("/api/health");
  csrfToken = (await api("/api/csrf")).csrfToken;
  el("health").textContent = health.status;
  el("origin").textContent = location.origin;
  message("");
}

function render() {
  const haveToken = sessionStorage.getItem(TOKEN_KEY) !== null;
  show("connect", !haveToken);
  show("status", haveToken);
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
