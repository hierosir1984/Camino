# 18 · GUI origin isolation: the per-launch ephemeral origin

**Status:** design complete, corrected after falsification round 1 (dual-stack exclusive
binding, per-launch token rotation, `*.localhost` resolution probe, and the honest
stale-origin service-worker residual are now REQUIRED parts of the design, not assumptions) —
implementation placement awaits David's ruling (see §6).
**Origin of the obligation:** WP-102 review round 5, finding 1 (PR #46); David's 2026-07-19
decision deferred the complete fix "to the real GUI/launch work (WP-122+)" with the
`worker-src 'none'` partial mitigation left in place. WP-122 (this document) discharges the
*design* half of that obligation.

## 1. The residual, restated

The daemon serves the GUI at `http://127.0.0.1:<port>` (default 4670). That origin is not
exclusively the daemon's across restarts: while the daemon is stopped, any other local
process can bind the port. If the user's browser loads the origin during such a window, the
page served by that process runs *as the GUI's origin* and can register a **service
worker** — a script the browser persists per-origin and re-activates on every later visit,
even after the port returns to the real daemon. A worker planted this way can read what the
page holds (the per-launch GUI token as it is entered), intercept every request, and drive
the API with the user's own credentials.

This needs no filesystem write, so the token-file (0600) and GUI-tree (plain-tree + inode
pin) boundaries do not cover it. The WP-102 mitigation — `worker-src 'none'` in the CSP —
stops the *legitimate* origin from ever registering a worker (so a GUI XSS cannot plant
one), but CSP is a per-response property: it cannot evict a worker registered by a page the
daemon never served.

Two structural facts drive the design:

- **Service workers partition by origin** (scheme · host · port). Only a *different origin*
  is out of a planted worker's reach.
- **A path nonce does not partition.** A worker registered with scope `/` intercepts every
  path under the origin, including paths it never saw; serving the GUI under
  `/<random>/` changes nothing. The isolation unit must be the origin itself.

## 2. Design goal

An origin another local process cannot usefully pre-seed: every daemon launch addresses the
GUI at an origin that has never been used before and will never be used again. A worker
planted on any *previous* origin then binds only to an address the user will not revisit;
the current launch's origin has no history to inherit.

## 3. Chosen mechanism: per-launch `localhost` subdomain nonce

At startup the daemon mints a 128-bit random label `n` and serves the GUI at

```
http://<n>.localhost:<port>/#token=<per-launch token>
```

- Browsers resolve any `*.localhost` name to the loopback interface and treat it as a
  secure/trustworthy context — the RFC 6761 special-use name. **Resolution is NOT universal
  and must not be assumed** (round 1, finding 12): RFC 6761 §6.3 permits (does not require)
  resolvers to map `.localhost` to loopback, and on Apple platforms it is the OS resolver, not
  the browser, that decides — WebKit bug 160504 records `*.localhost` failing on macOS 15.7
  and succeeding on macOS 26, so a given Safari version does not imply the behavior. The
  implementation therefore **probes resolution at launch and falls back** (below), rather than
  asserting cross-browser support.
- **The listener must be dual-stack EXCLUSIVE** (round 1, finding 2, FALSIFIED the original
  IPv4-only plan): RFC 6761 §6.3 lets `.localhost` resolve to *either* `127.0.0.1` *or*
  `[::1]`, and Chromium prefers `[::1]` when both are offered. An IPv4-only listener leaves
  `[::1]:<port>` free for a local imposter to bind; the browser then loads the *fresh nonce
  origin* from the imposter and hands it the token fragment. So the daemon must **bind and
  hold BOTH `127.0.0.1:<port>` and `[::1]:<port>`, and refuse to start if either is taken**
  (the EADDRINUSE single-instance refusal now covers both families). Only when the daemon owns
  both loopback addresses on the port is the nonce origin actually the daemon's.
- The **origin** changes every launch (the host component differs), so a worker registered
  on `a.localhost:4670` is inert when the next launch addresses `b.localhost:4670`.
- The **port stays fixed** (4670), preserving the configured-port contract, firewall
  expectations, and the (now dual-stack) EADDRINUSE single-instance refusal.
- The daemon's Host/Origin allowlist (server.ts layer 3) admits **only the current nonce
  authority**. A stale bookmark (an old nonce, or the bare `127.0.0.1:4670`) is answered
  with the existing `host-not-allowed` refusal plus a static hint page telling the user to
  launch from the printed URL — never the GUI, never a redirect carrying secrets. The
  legacy bare-IP origin is thereby retired entirely.
- The printed startup line (today: `Camino daemon listening at http://127.0.0.1:4670/`)
  becomes the nonce URL with the token fragment, which the user opens (or a later launcher
  opens for them). The fragment-token handoff, sessionStorage custody, CSRF header, and
  every other WP-102 contract survive unchanged — the addressing contract is the only
  change.
- `worker-src 'none'` **stays**: the current origin still must not register workers, so a
  GUI XSS cannot re-open persistence on the live origin.

### Failure containment, walked

| Scenario | Outcome under this design |
| --- | --- |
| Another process binds the port on `[::1]` (or `127.0.0.1`) while the daemon is down; the browser visits the *current* nonce URL | With dual-stack **exclusive** binding the daemon refuses to start unless it owns BOTH loopback families on the port, so it never serves the current nonce origin alongside an imposter. If the imposter holds the port, the daemon fails EADDRINUSE and prints why — it does not silently share the origin. |
| A worker (or other browser-persisted state) was planted on a PAST origin (`old.localhost:4670`, or the legacy `127.0.0.1:4670`) and the user later revisits that stale URL | **The planted worker answers — the daemon is not consulted** (round 1, finding 8, corrected): a root-scoped service worker intercepts navigations to *its* origin from cache, so the daemon's `host-not-allowed` hint never fires for that origin. What the nonce scheme guarantees is only that this worker binds a **dead** origin the daemon will never serve again, so it cannot reach the *current* session. It does NOT make the stale origin safe to revisit. Mitigation is user-facing: the launcher opens the fresh nonce URL for the user so they do not navigate to stale ones, and the residual (a stale origin can serve cached imposter content to a user who revisits it) is stated in §5, not hidden. |
| The user types the token into an imposter page on a stale/loopback origin | The token is the real auth boundary here, and **it is NOT rotated per launch today** (round 1, finding 9: `loadOrCreateToken` reuses the on-disk 0600 token across launches). So a captured token may still be valid. This design does not fix that; §4 adds token rotation as a REQUIRED companion so "a stale-origin capture is a stale token" becomes true instead of assumed. User deception itself no addressing scheme prevents. |
| The browser cannot resolve `*.localhost` (older macOS, unusual resolver/proxy setups) | **Launch-time probe + fallback:** the daemon does not assume resolution. If a `*.localhost` origin is unreachable, the launcher/docs fall back to the documented `CAMINO_GUI_HOST=127.0.0.1` escape hatch, which restores today's bare-loopback behavior **and today's residual** (no per-launch origin isolation), explicitly opted into and labeled as such. |

### Alternatives considered and set aside

- **Ephemeral per-launch port (port 0).** Also rotates the origin, but breaks the fixed-port
  contract, and a process cycling through binds while the daemon is down can pre-seed many
  candidate ports; the OS may later assign one of them. Weaker isolation for more contract
  breakage. Kept only as a conceptual fallback where `*.localhost` resolution is unavailable.
- **Path nonce.** Does not partition service workers (scope `/` sees everything); rejected
  outright.
- **`Clear-Site-Data` on legacy-origin responses.** Best-effort only: a planted worker can
  answer navigations from cache without ever letting the header arrive. May be added as
  defense-in-depth on the hint page responses; never load-bearing.
- **TLS with a local CA (`https://` origin).** Real per-launch origins plus locked identity,
  but requires minting and trusting a local CA — a far larger custody surface than the
  problem it solves here. Out of v1 scope (consistent with design v5 §5.4's posture).

## 4. Contract changes when implemented

1. `config.ts`: mint the nonce label at startup; `CAMINO_GUI_HOST` override for the
   documented fallback (refusal on anything but `127.0.0.1` or a `*.localhost` label).
2. `server.ts` / `startDaemonServer`: **bind both loopback families exclusively** —
   `127.0.0.1:<port>` AND `[::1]:<port>` — and fail closed (EADDRINUSE) if either is taken
   (round 1, finding 2). `selfHosts()` returns the nonce authority only; the not-found/hint
   paths answer legacy authorities with the launch-hint page; everything else — token, CSRF,
   single-value headers, origin-pair binding — is untouched.
3. `main.ts` / future launcher: print (and eventually auto-open) the nonce URL; probe
   `*.localhost` reachability and fall back to `CAMINO_GUI_HOST=127.0.0.1` when it fails.
4. **`token.ts`: rotate the GUI token per launch** (round 1, finding 9). Today
   `loadOrCreateToken` reuses the on-disk token; this design's stale-origin analysis assumes a
   captured token is already dead, which is only true if each launch mints (and 0600-persists)
   a fresh token, invalidating outstanding copies. This is a REQUIRED companion change, not
   optional — without it the origin nonce narrows the attack surface but a phished token from a
   prior session still authenticates.
5. Tests: the WP-102 policy suites re-pinned to the nonce authority; a fixture asserting a
   request bearing a *previous* launch's authority is refused; a dual-stack fixture asserting
   startup refuses when `[::1]:<port>` is pre-bound; and a token-rotation fixture asserting a
   prior launch's token no longer authenticates.

The diff is deliberately narrow, but it rewrites the Host-allowlist heart of the WP-102
policy stack — the module that went through seven falsification rounds — and touches token
custody. That is the review surface consideration behind §6.

## 5. What this does not cover (named residuals)

- **A service worker (or other browser-persisted capability) planted on a PAST origin can
  serve cached deceptive content to a user who revisits that stale origin, indefinitely**
  (round 1, finding 8). The nonce scheme guarantees the planted worker cannot reach the
  *current* session's origin — it does not evict the worker from the dead origin, and the
  browser answers navigations to that origin from the worker's cache without consulting the
  daemon. Eviction is the user's action (clear site data) or a future `Clear-Site-Data`
  best-effort; neither is load-bearing. The mitigation is to keep users off stale origins (the
  launcher opens the fresh URL), not to make stale origins safe.
- A local process serving deceptive content on any port it binds, on any origin, while the
  daemon is down. Origin isolation removes its *persistence into real sessions*, not its
  ability to render pixels.
- Token custody once rotation (above) ships: a token captured DURING its live launch still
  authenticates that launch. The token is a bearer secret; per-launch rotation bounds the
  window, it does not eliminate in-session capture.
- Compromise of the user's own account/browser profile — the standing single-OS-user
  boundary (WP-102/WP-003 precedent).
- Non-browser API clients that deliberately set the nonce Host header; the token remains
  the authentication boundary for them, exactly as today.

## 6. Placement — David's ruling requested

The design above is complete and self-contained. Where should the implementation land?

- **Option B (recommended): a dedicated micro-WP** immediately after WP-122 merges, before
  WP-123 grows the GUI. Single-concern diff over `config.ts`/`server.ts`/`main.ts` + the
  re-pinned policy suites; reviewable in isolation from any feature work; the addressing
  contract is settled before the board/inbox (WP-123) and evidence viewer (WP-124) build
  daily-use habits on top of it.
- **Option A: fold into WP-123**, which already owns the GUI's operational surface. One
  fewer WP, but couples a security-contract rewrite to the largest GUI feature diff of the
  phase, diluting both reviews.
- **Option C: keep only `worker-src 'none'` until Phase-1 exit.** Not recommended: WP-126
  runs a real mission with real tokens through this GUI; the persistence residual should be
  closed before that, not after.

Until the ruling, the WP-102 posture (fixed bare-IP origin + `worker-src 'none'` + no
workers in the legitimate GUI) remains in force, and nothing in WP-122 widens it — the
register page introduces no workers, no caching, and no new origin exposure.
