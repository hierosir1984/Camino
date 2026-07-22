# 18 · GUI origin isolation: the per-launch ephemeral origin

**Status:** design complete — implementation placement awaits David's ruling (see §6).
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
  secure/trustworthy context (the RFC 6761 special-use name as implemented by Chromium,
  Firefox, and current Safari). No DNS, hosts-file entry, or TLS material is needed, and the
  TCP listener stays `127.0.0.1`-bound exactly as today.
- The **origin** changes every launch (the host component differs), so a worker registered
  on `a.localhost:4670` is inert when the next launch addresses `b.localhost:4670`.
- The **port stays fixed** (4670), preserving the configured-port contract, firewall
  expectations, and the EADDRINUSE single-instance refusal.
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
| Another process binds 4670 while the daemon is down; the browser visits a stale URL | The page loads on a *dead* origin (old nonce or bare IP). Anything it plants — workers, storage — binds that dead origin. The next real launch mints a fresh origin it cannot touch. |
| The same, and the user types the token into the imposter page | Out of scope for origin isolation: the token is per-launch and was minted by the *previous* daemon run, so it is already invalid; the real exposure is user deception, which no addressing scheme prevents. |
| A worker was planted on `127.0.0.1:4670` *before* this design ships | It stays bound to the bare-IP origin. Since the GUI is never again served there, it never re-activates in front of Camino traffic. |
| The browser cannot resolve `*.localhost` (unusual resolver/proxy setups) | Launch-time fallback: the daemon detects the failed first GUI fetch is impossible to distinguish server-side, so the fallback is user-facing — the hint page and docs name the alternative `CAMINO_GUI_HOST=127.0.0.1` escape hatch, which restores today's behavior *and today's residual*, explicitly opted into. |

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
2. `server.ts`: `selfHosts()` returns the nonce authority only; the not-found/hint paths
   answer legacy authorities with the launch-hint page; everything else — token, CSRF,
   single-value headers, origin-pair binding — is untouched.
3. `main.ts` / future launcher: print (and eventually auto-open) the nonce URL.
4. Tests: the WP-102 policy suites re-pinned to the nonce authority, plus a new fixture
   asserting a request bearing a *previous* launch's authority is refused.

The diff is deliberately narrow, but it rewrites the Host-allowlist heart of the WP-102
policy stack — the module that went through seven falsification rounds. That is the review
surface consideration behind §6.

## 5. What this does not cover (named residuals)

- A local process serving deceptive content on any port it binds, on any origin, while the
  daemon is down. Origin isolation removes its *persistence into real sessions*, not its
  ability to render pixels.
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
