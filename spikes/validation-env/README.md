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
container runs with `--cap-add NET_ADMIN`; the entrypoint, as root (with a
fixed `PATH`, absolute tool paths, and `LD_*` cleared so a caller environment
cannot steer the bootstrap):

1. resolves every `host:port` allowlist entry (passed as **data** via
   `CAMINO_EGRESS_ALLOWLIST`) and pins the results into `/etc/hosts`;
2. installs default-deny IPv4 **INPUT and OUTPUT** rules — loopback allowed,
   DNS closed (see below), conntrack-established allowed, one OUTPUT accept
   per allowlist entry, then reject-everything with policy `DROP` as backstop
   — and closes IPv6 entirely;
3. verifies the deny backstops are live on every chain, then drops to the
   unprivileged `camino` user and execs the workload.

The workload therefore **cannot alter the rules it runs under** (proven by a
probe: `iptables` append as the workload fails with permission denied).
Setup is fail-closed: unresolvable hosts, malformed entries, or an unset
allowlist abort the container before any workload runs (empty-but-set = the
deny-all baseline).

**INPUT is closed too, and that is load-bearing for _egress_.** With INPUT
open, a workload could accept an inbound connection from a non-allowlisted
peer and reply over it — and those replies are `ESTABLISHED`, so the OUTPUT
`ESTABLISHED,RELATED` accept would let them bypass the destination allowlist.
Default-deny INPUT (loopback + replies-to-our-own-outbound only) means no
externally-initiated connection can ever reach `ESTABLISHED`, so the OUTPUT
established-accept can only match connections the workload itself opened
through the allowlist.

**Composer refuses unsafe runs.** The container parameters (network, mounts,
env keys) are Camino-composed — the untrusted workload is the _code_ that runs
unprivileged after the rules install, never the container config. Even so,
[`egress-profile.ts`](profile/egress-profile.ts) fails closed on the reachable
ways a run could subvert the root bootstrap: a shared/reserved network
(`host`, `none`, `container:<id>` — whose namespace the bootstrap's
`iptables -F/-P DROP` would rewrite), a mount over a bootstrap path
(entrypoint or tools), or a caller `CAMINO_EGRESS_*` env key that would shadow
the composed allowlist. (Full privilege separation — a setup sidecar or
cap-drop init so the bootstrap shares nothing with the workload's env/mounts —
is the WP-107 productization.)

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
- **Detector health:** a positive `nc` control to the allowed endpoint (by IP)
  must SUCCEED — so a missing/broken `nc`, which would make every denial probe
  fail for the wrong reason, is caught instead of being mistaken for denial.
- **Port specificity:** the allowed endpoint also listens on a second,
  never-allowlisted port; a probe to it must fail. Because something IS
  listening there, the failure is attributable to the firewall — proving the
  accept is host+port, not host-wide.
- **Rule order** is asserted from the printed ruleset: DNS closed before the
  loopback accept, allow before the catch-all, and the catch-all `REJECT`
  **last** — so no early exception can slip a packet past the allowlist.
- A second profiled run with an **empty allowlist** shows the same endpoint
  become unreachable **by name and by IP**: the allowlist entry is precisely
  what opens the one permitted path (the by-IP leg means a DNS failure alone
  cannot satisfy the baseline).
- The probe workload only _produces_ evidence (raw exit codes); the vitest
  harness _decides_ (WP-004 convention). Once the image is built, the
  assertions need no external internet — every endpoint is in-network; the
  image _build_ pulls Alpine + `apk add`, so a cold runner needs registry
  access for that step.

## Scrubbing scope (and its stated residual)

[`scrub/scrub.ts`](scrub/scrub.ts) takes the **exact literals** the caller
injected (in production, the vault knows them — CAM-VAL-02) and clears every
retained byte **and file name** of: the raw literal; its **base64** form —
standard (`+/`) **and url-safe (`-_`, JWT segments)**, canonical plus all 3
stream alignments, so it is found inside larger blobs (Basic-auth headers,
config dumps); and its **URL-encoded** forms — canonical `encodeURIComponent`
plus the lowercase-hex and space-as-`+` (form) dialects. Redactions become
`[SCRUBBED:<id>:<encoding>]` markers; the per-file result (`path`, `sha256`,
`scrubbed`, occurrence counts) is a **precursor to** the evidence-packet
artifact item (PRD registry item 8) that WP-115 completes with
`type`/`sha`/`base_sha`/`class`. The report itself never carries secret
material.

Fail-closed: nothing lands in the retained dir unredacted; the **whole
retained tree** is re-walked afterwards — bytes and names — plus the
serialized report (residue ⇒ file deleted + reported, `verifiedClean` drops);
files are read through an **`O_NOFOLLOW` descriptor and fstat'd on that same
descriptor** (no lstat→read symlink/size TOCTOU); symlinks, special files,
oversize files and beyond-depth trees are withheld, never copied unscanned;
short secrets are refused, and any secret id whose marker would reproduce a
variant of any secret is refused. Redaction is a single linear pass per
needle, so an artifact packed with millions of occurrences cannot drive a
quadratic hang.

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
  passes through. Two smaller stated bounds: base64 boundary quanta can leave
  the base64 chars covering up to 2 residual bytes (up to 3 base64 chars) of
  an embedded value, and some alignments of very short secrets fall below the
  safe-match floor (the raw form is always covered).

## Known limitations (deliberate, spike scope)

- `FORWARD` stays open (containers do not route); `INPUT`+`OUTPUT` are
  default-deny. IPv6 is closed wholesale and **rule-presence-verified**, but
  the packet-level egress proof runs on the IPv4 test network only — a full
  IPv6 packet round-trip is deferred to WP-107's worker-egress suite.
- The inbound-peer egress bypass (finding 4) is closed structurally
  (default-deny INPUT, asserted present); a full two-container inbound
  round-trip test is a WP-107 addition.
- Allowlist entries are TCP + IPv4 only.
- Allowlist IPs are resolved and pinned at container start; no
  re-resolution (endpoint IP drift across a long validation run is a WP-115
  lease/refresh concern).
- The resolver-address rejection targets Docker's embedded DNS
  (`127.0.0.11`); other runtimes' resolvers are covered by the generic
  port-53 rules plus default-deny.
- Container parameters are trusted as Camino-composed; the composer fails
  closed on the reachable bootstrap-subversion cases (network, mounts,
  reserved env), and full privilege separation of bootstrap from workload is
  the WP-107 productization.
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
