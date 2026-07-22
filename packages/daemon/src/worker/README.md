# Worker isolation — WP-107 (CAM-EXEC-02 / CAM-EXEC-03 / CAM-EXEC-05)

Everything a worker attempt needs to run **contained**: an isolated clone with
no credentials, a container with allowlist-positive egress and per-attempt
budgets, and a single archival step that preserves history under quotas before
the workspace is destroyed. This is the product promotion of the WP-005
validation-egress spike (egress profile) and the WP-105 dispatch lifecycle
(kill-confirm, env posture), widened to the guarantees a real worker needs.

The pieces, by requirement:

| File                                                            | Requirement    | What it guarantees                                                                                                                                                                                                                        |
| --------------------------------------------------------------- | -------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`clone.ts`](clone.ts)                                          | CAM-EXEC-02    | A **full isolated clone** (`--no-local`, object store stands alone), hooks disabled by config at clone time, **zero GitHub credentials** — attested from disk (env + filesystem), not merely requested.                                   |
| [`egress.ts`](egress.ts) + [`worker-profile/`](worker-profile/) | CAM-EXEC-02/03 | The hardened `docker run` composer (cap-drop ALL + minimal bootstrap caps, `no-new-privileges`, pids-limit, PID namespace) and the profile image: **default-deny egress with a per-repo allowlist**, provider auth mounted **read-only**. |
| [`repo-config.ts`](repo-config.ts)                              | CAM-EXEC-03    | The `.camino/config.yml` egress allowlist, parsed **fail-closed** (absent = deny-all; malformed = refusal, never a silent deny).                                                                                                          |
| [`budget.ts`](budget.ts) + the lifecycle `budget` seam          | CAM-EXEC-03    | Per-attempt budgets (**wall-clock always**, **tokens where reportable**) → `killed-budget` → **kill-and-escalate, never an automatic retry** (Appendix A.3#5 / A.2#10).                                                                   |
| [`archive.ts`](archive.ts)                                      | CAM-EXEC-05    | The **single archival step** (A.4#5): archive under quota → ledger row referencing it → workspace destroyed, strictly ordered and fail-closed; registry-item-11 retention (90 days **or** last 10, whichever more).                       |

Registry item 11's quota values live once in
[`@camino/shared` `REGISTRY_ITEM_11_QUOTAS`](../../../shared/src/worker-quotas.ts)
— this module (and later WP-108 quarantine / WP-115 retention) consume that one
frozen source.

## How egress works (and why total denial cannot pass)

`renderWorkerRunArgs` composes a `docker run` whose entrypoint (as root, then
dropping to an unprivileged user) installs default-deny `INPUT`+`OUTPUT` with
one accept per allowlist entry, **rejects the embedded resolver `127.0.0.11`
by address** (Docker DNAT-redirects resolver traffic off port 53 before the
filter chain — the WP-005 shakedown finding, and why the test proves denial by
IP, not by name), and closes IPv6. The suite
([`egress.worker.test.ts`](egress.worker.test.ts)) proves **selective** allow:
an allowlisted per-repo endpoint completes a full HTTP round trip **while** a
sibling on the same network (probed by IP), external addresses, the resolver
address, and IPv6 all fail — so an allow-everything implementation fails the
deny legs and a total-denial implementation fails the allowed leg.

It closes the two WP-005 deferrals: a packet-level IPv6 proof, and the
**inbound** two-container round-trip (INPUT default-deny drops a peer's SYN, so
a workload can never accept an inbound connection and reply over it — the
established-egress bypass).

## Boundaries (stated, not hidden)

- **This module composes and attests isolation; it does not yet wire real
  attempts.** The scheduler that leases an attempt, provisions the clone, runs
  the container, and drives the archival step on terminal is **WP-114**. Every
  guarantee here is exercised against the product composer/image, not a mock.
- **Token budgets bind only where the vendor stream reports cumulative usage**
  (claude `result` usage, codex `turn.completed` usage). "Tokens where
  reportable" is literal: a harness that reports nothing is guarded by
  wall-clock alone (always enforced) — which is exactly why a token-only budget
  is refused. WP-106's quota-aware routing owns provider window models; this is
  the per-attempt hard cap, not the window.
- **The ledger-row seam is a callback** (`recordLedgerRow`): the durable
  event-store wiring is the caller's (WP-109 store). The archival step
  guarantees the _order_ and the _retention_, and fails closed (workspace
  retained) if the row is not recorded.
- **Container parameters are Camino-composed, not worker-supplied.** The
  composer refuses the reachable bootstrap-subversion shapes: a shared network;
  a mount that covers **or shadows an ancestor of** a bootstrap path
  (canonicalized, so `/tmp/../usr/local/bin` and mounting `/usr` are both
  rejected); a reserved or credential-shaped env key; a mount source that
  **resolves** (realpath, following symlinks) into the rw workspace and would
  alias a `:ro` mount; and an image whose ENTRYPOINT could skip the profile
  (the entrypoint is **pinned**). Image PROVENANCE — that the run uses a
  Camino-built image (the profile or a `FROM camino-worker-profile` toolchain
  image) rather than an attacker-supplied one — is **WP-114's image-build
  boundary**: pinning the entrypoint path defeats an ENTRYPOINT override, not a
  maliciously-built image. A worker's untrusted input is the _code_ that runs
  unprivileged after the rules install.
- **Credential attestation reads EFFECTIVE git config** (`git config
--includes --list`, which resolves `[include]` directives and never
  interprets a value as an option) plus a filesystem scan (credential files,
  credential-named symlinks, comment-aware token content). Literal content
  scanning cannot catch every ENCODING of a token a repo could commit — that
  regenerating surface is bounded by the real guarantee: the container **mounts
  no host HOME**, so a vendor CLI cannot reach the host's credentials whatever
  the workspace contains.
- **Archival assumes single-writer-per-issue and a fixed archiveRoot.** The
  WP-104 lock (WP-114 scheduler) serializes archival per issue; retention/
  exactly-once are scoped to the one daemon `archiveRoot`. The retention
  sequence is the attempt's authoritative ordinal (the caller passes it);
  archiveRoot is realpath-checked to reject a symlink into the workspace.
- **Egress is an IP:port allowlist (L3/L4), not an L7 host-identity filter.**
  Per-repo hosts are resolved to IPs at container setup and permitted by
  address; there is no HTTP Host / TLS SNI check. So a non-allowlisted virtual
  host sharing an allowed host's IP **and** port (a shared CDN/hosting IP)
  remains reachable, and IPs are pinned at setup (no re-resolution mid-run). An
  L7 filtering proxy would close the shared-IP gap and is a **deferred**
  follow-up (recorded for David), not part of WP-107 — the same L3/L4 posture
  the WP-005 spike established and that is the accepted v1 for a per-repo
  registry/docs allowlist.
- **Token budgets bind only where the vendor reports cumulative usage.** The
  figure sums every consumed-token variant Anthropic reports (input, output,
  cache-creation, cache-read), so a run riding cache-read tokens cannot slip a
  small budget; wall-clock is always enforced, measured from dispatch start.

## Running the suites

```sh
node --run test    # full repo gate, incl. the docker-backed worker suite
```

The docker-backed [`egress.worker.test.ts`](egress.worker.test.ts) **requires**
the Docker daemon (a WP-000 gate prerequisite) and refuses to skip — a silent
skip would let CI go green while proving nothing. The non-docker unit suites
(`clone`, `egress` composer, `repo-config`, `budget`, `archive`) need only git
and `tar`.

> Use `node --run` (Node 22 built-in), not `npm run`: this machine's global
> npm config enables workspaces, so `npm run <script>` fans out across
> packages.
