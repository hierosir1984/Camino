# WP-005 — Validation-environment egress + scrubbing tests

Phase-0 item 5 (PRD §7) — the last Phase-0 item. Requirement **CAM-VAL-03**
(both halves) plus **CAM-SEC-08** groundwork ("scrubbing before storage").
Closes [#7](https://github.com/hierosir1984/Camino/issues/7).

Two executable suites that persist as CI (they ride the root vitest glob, so
they run on every PR from this WP forward):

- **[`egress.test.ts`](egress.test.ts)** — from inside the containerised
  validation environment, connection attempts to non-allowlisted hosts fail
  **while an allowlisted test endpoint remains reachable**. A
  total-network-denial implementation cannot pass (the allowed leg fails); an
  allow-everything implementation cannot pass (the denied legs fail).
- **[`scrub.test.ts`](scrub.test.ts)** — seeded secret literals in
  logs/artifacts (text, XML, binary, file names) are redacted in the retained
  copies, clean files survive byte-identical, and the T3 residual is **stated
  executably**, not hidden.

Both are **spikes**: prototype-grade harness, reuse-shaped modules. WP-107 (worker egress) and WP-115 (validation runner)
productize the [`profile/`](profile/) composer+entrypoint pair and
[`scrub/scrub.ts`](scrub/scrub.ts) respectively.

## How the egress profile works

One small alpine image ([`profile/Dockerfile`](profile/Dockerfile)). The
container runs with `--cap-add NET_ADMIN`; the entrypoint, as root:

1. resolves every `host:port` allowlist entry (passed as **data** via
   `CAMINO_EGRESS_ALLOWLIST`) and pins the results into `/etc/hosts`;
2. installs default-deny IPv4 OUTPUT rules — loopback allowed, DNS closed
   (see below), conntrack-established allowed, one accept per allowlist
   entry, then reject-everything with policy `DROP` as backstop — and closes
   IPv6 entirely;
3. verifies the deny backstops are live, then drops to the unprivileged
   `camino` user and execs the workload.

The workload therefore **cannot alter the rules it runs under** (proven by a
probe: `iptables` append as the workload fails with permission denied).
Setup is fail-closed: unresolvable hosts, malformed entries, or an unset
allowlist abort the container before any workload runs (empty-but-set = the
deny-all baseline).

**DNS is closed by address, not just port.** The container's embedded
resolver (`127.0.0.11`) forwards queries upstream from outside the network
namespace — an open resolver channel under an otherwise default-deny
posture — and Docker DNAT-redirects resolver traffic to a dynamic port
before the filter chain sees it, so a `--dport 53` match alone misses it
(observed during this WP's shakedown; the fix rejects the resolver address
on every port). Allowlisted names stay resolvable via the `/etc/hosts` pin.

## Why the test proves _selective_ allow

- Two sibling `httpd` endpoints run on the same docker network; exactly one
  is allowlisted. An **unrestricted control** (same image, no profile) first
  proves both are alive and serving — so the later sibling denial is
  attributable to the profile, not a dead endpoint.
- The profiled run must complete a full HTTP round trip to the allowlisted
  endpoint **by name** while the sibling (probed **by IP**, independent of
  name resolution), a real external address, and the DNS channel all fail.
- A second profiled run with an **empty allowlist** shows the same endpoint
  become unreachable: the allowlist entry is precisely what opens the one
  permitted path.
- The probe workload only _produces_ evidence (raw exit codes); the vitest
  harness _decides_ (WP-004 convention). The suite is hermetic — no external
  internet is required for any assertion to hold.

## Scrubbing scope (and its stated residual)

[`scrub/scrub.ts`](scrub/scrub.ts) takes the **exact literals** the caller
injected (in production, the vault knows them — CAM-VAL-02) and clears every
retained byte **and file name** of: the raw literal; its base64 form
(canonical, plus all 3 stream alignments, so it is found inside larger blobs
— Basic-auth headers, config dumps); its URL-encoded form where different.
Redactions become `[SCRUBBED:<id>:<encoding>]` markers; per-file results
(`path`, `sha256`, `scrubbed`, occurrence counts) match the evidence-packet
artifact item shape (PRD registry item 8) for WP-115 to consume, and the
report itself never carries secret material.

Fail-closed: nothing lands in the retained dir unredacted; the retained tree
is re-verified afterwards (residue ⇒ file deleted + reported); symlinks,
special files, oversize files and beyond-depth trees are withheld, never
copied unscanned; short secrets and marker/value collisions are refused.

**Risk-model groundwork (design §5.3, documented in-product at WP-115):**

- **T1 — accidental leakage: defended.** That is this suite: no-egress
  environment except allowlisted endpoints + literal scrubbing of retained
  artifacts (raw + the encodings accidental leakage actually rides).
- **T2 — planted-instruction misbehaviour:** WP-004's corpus + its
  hardening path (not this WP).
- **T3 — deliberately transformed output: stated residual.** No literal
  scrub catches compressed, reversed, or chunked encodings.
  `scrub.test.ts` **asserts the misses**: a gzip of the secret is retained
  byte-identical and still decompresses to the literal; a reversed copy
  passes through. Two smaller stated bounds: base64 boundary quanta can
  leave ≤2 base64 chars (≤2 partial bytes) of an embedded value, and some
  alignments of very short secrets fall below the safe-match floor (the raw
  form is always covered).

## Known limitations (deliberate, spike scope)

- `INPUT`/`FORWARD` chains stay open — this workload has no listener;
  WP-107's worker profile closes ingress too.
- Allowlist entries are TCP + IPv4 only; IPv6 is closed wholesale.
- Allowlist IPs are resolved and pinned at container start; no
  re-resolution (endpoint IP drift across a long validation run is a WP-115
  lease/refresh concern).
- The resolver-address rejection targets Docker's embedded DNS
  (`127.0.0.11`); other runtimes' resolvers are covered by the generic
  port-53 rules plus default-deny.
- The scrub walk caps file size (default 32 MiB), entry count, and depth —
  oversize artifacts are withheld, not streamed (registry-item-11 quota
  handling is WP-107/WP-115).

## Commands

```sh
node --run spike:validation-env   # both suites (docker required for egress)
node --run test                   # full repo gate (these suites included)
```

> Use `node --run` (Node 22 built-in), not `npm run`: this machine's global
> npm config enables workspaces, so `npm run <script>` fans out across
> packages.

The egress suite **requires** the Docker daemon (a WP-000 gate prerequisite)
and refuses to skip when it is missing — a silent skip would let CI go green
while proving nothing.
