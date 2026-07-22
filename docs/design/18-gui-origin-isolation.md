# 18 · GUI origin isolation: the per-launch ephemeral origin

**Status: DESIGN SKETCH — direction settled, mechanics NOT yet complete.** Two falsification
rounds hardened the threat model but also proved the *implementation mechanics* need a
dedicated design pass (see §7, Open problems): a single Fastify instance cannot own both
loopback families by calling `listen()` twice; a fixed `*.localhost` override reuses an origin
and defeats the invariant; token rotation must be ordered against the writer lock; and the
`*.localhost` resolution probe is under-specified. The DIRECTION — a per-launch nonce origin a
local squatter cannot pre-seed — is sound and is the deliverable this WP owes; the remaining
mechanics belong to the WP that implements it (§6 placement ruling). This document is
deliberately not marked "complete." Do not build from §3 as-is; build from §3 **plus** §7.
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

- **Where it works**, a browser resolves a `*.localhost` name to the loopback interface and
  treats it as a secure/trustworthy context — the RFC 6761 special-use name. But **resolution
  is NOT universal and must not be assumed** (round 1, finding 12; round 4, finding 7): RFC
  6761 §6.3 *permits* (does not require) resolvers to map `.localhost` to loopback, and on
  Apple platforms it is the OS resolver, not the browser, that decides — WebKit bug 160504
  records `*.localhost` failing on macOS 15.7 and succeeding on macOS 26, so a given Safari
  version does not imply the behavior. The implementation therefore **probes resolution at
  launch and falls back** (below), rather than asserting cross-browser support.
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

1. `config.ts`: mint the nonce label at startup. The `CAMINO_GUI_HOST` override is **only
   `127.0.0.1`** — the explicit opt-OUT of isolation (round 2, finding 6). It must NOT accept a
   fixed `*.localhost` value: a fixed nonce-looking host is *reused* every launch, so a worker
   planted there persists and captures the rotated token, defeating the whole invariant. The
   nonce is always daemon-minted and never user-supplied.
2. `server.ts` / `startDaemonServer`: own both loopback families exclusively on the port. This
   is NOT achievable by calling one Fastify instance's `listen()` twice (round 2, finding 5:
   `FST_ERR_REOPENED_SERVER`); see §7 for the open mechanics. Whatever the mechanism, one
   coherent server must answer both families with the SAME CSRF token and shut both down
   together, and startup must fail closed if either family's port is taken. `selfHosts()`
   returns the nonce authority only; the not-found/hint paths answer legacy authorities with
   the launch-hint page; token, CSRF, single-value headers, and origin-pair binding are
   otherwise untouched.
3. `main.ts` / future launcher: print (and eventually auto-open) the nonce URL; probe
   `*.localhost` reachability and fall back to `CAMINO_GUI_HOST=127.0.0.1` when it fails (probe
   specification is open — §7).
4. **`token.ts`: rotate the GUI token per launch, AFTER acquiring the single-writer lock**
   (round 1, finding 9; round 2, finding 7). Today `loadOrCreateToken` reuses the on-disk
   token; the stale-origin analysis assumes a captured token is already dead, which holds only
   if each launch mints (and 0600-persists) a fresh token. The ORDERING matters: rotating
   before the writer lock is acquired lets a second, losing launch overwrite the token on disk
   and then fail the lock, leaving the running daemon's in-memory token out of sync with disk.
   Rotation must happen only once the launch owns the writer lock, so exactly the daemon that
   will run is the one that rotates.
5. Tests: the WP-102 policy suites re-pinned to the nonce authority; a fixture asserting a
   request bearing a *previous* launch's authority is refused; a dual-stack fixture asserting
   startup refuses when either loopback family's port is pre-bound; a token-rotation fixture
   asserting a prior launch's token no longer authenticates AND that a losing concurrent launch
   does not corrupt the winner's token; and a resolution-fallback fixture.

The diff is deliberately narrow in intent, but it rewrites the Host-allowlist heart of the
WP-102 policy stack — the module that went through seven falsification rounds — touches token
custody, and (per §7) changes how the daemon binds its listener. That is the review surface
consideration behind §6.

## 7. Open problems (surfaced by falsification round 2 — must be closed by the implementing WP)

The direction in §3 is sound; these mechanics are NOT yet solved and are why this document is
a sketch, not a complete design:

1. **Dual-stack ownership with one coherent server.** One Fastify instance cannot `listen()`
   on two addresses. Candidate approaches, each with an open question:
   - *One socket bound to `::` with IPv4-mapped addresses.* Simple, but `::`/`0.0.0.0` are not
     loopback-scoped — the listener would accept non-loopback traffic unless the OS/dual-stack
     settings restrict it, contradicting CAM-CORE-01's loopback-only invariant. Needs proof
     that binding is loopback-restricted.
   - *Two listeners feeding one Fastify app* (e.g. a second `net.Server` handing sockets to the
     same request pipeline), so CSRF/token state and shutdown are shared. Needs a concrete
     wiring that keeps the single-instance policy guarantees.
   - Node's `exclusive: true` is NOT proof of OS-wide port ownership (a raw probe bound
     `127.0.0.1`, `::1`, `0.0.0.0`, and `::` on one port simultaneously); the design must state
     what "exclusive" actually guarantees on each target OS.
   - `127.0.0.1` is not the whole loopback: RFC 1122 reserves all of `127/8`. The design must
     state which resolved addresses `*.localhost` can produce on the target platforms and that
     the daemon owns exactly those (browsers resolve `*.localhost` to `127.0.0.1`/`::1` in
     practice, but this must be verified, not assumed).
2. **`*.localhost` resolution probe.** Unspecified: who probes (launcher vs. browser), which
   resolved addresses count as success, what response authenticates the daemon (not just a
   TCP connect — a squatter answers too), and the timeout/fallback transition. An OS DNS
   lookup is not equivalent to successful, daemon-authenticated browser navigation — the
   macOS/WebKit discrepancy (round 1, finding 12) is exactly why.
3. **Token-rotation lifecycle** (see §4.4): rotate only after the writer lock is held; define
   what a still-open browser tab from the prior launch sees (a 401 → re-handoff), and how the
   printed/opened URL carries the new token. **Also unspecified (round 3, finding 9): the
   atomic-replacement / crash-recovery protocol for the token file itself** — a rotation that
   writes the new token but crashes before persisting (or is interrupted between unlink and
   rename) must leave a well-formed 0600 token on disk, never a truncated or absent one, or the
   next launch fails to authenticate its own GUI. Write-to-temp-then-rename within the state
   dir, with the 0600 mode set before the rename, is the likely shape; it must be specified and
   tested.
4. **Legacy-origin eviction remains a named residual** (§5): none of the above evicts a worker
   already planted on a stale origin; it only keeps that worker off the current session.

None of these block WP-122 (which ships `worker-src 'none'` and introduces no worker/caching/
new-origin exposure). They are the scope of the implementing WP that §6's ruling places.

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

The DIRECTION above is settled; the mechanics are not (see §7 — this is a sketch, not a
complete design). Where should the implementation, and the remaining design work, land?

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
