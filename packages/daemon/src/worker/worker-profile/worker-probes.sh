#!/bin/sh
# Worker-isolation probe workload — WP-107 test instrumentation, mounted
# read-only into the profiled worker container and run as the unprivileged
# workload user. Emits one JSON line per probe on stdout with the RAW
# observation (exit code + truncated output). The vitest harness decides
# pass/fail — the workload only produces evidence (WP-004 convention).
#
# Covers three isolation claims from inside the running container:
#   - EGRESS (CAM-EXEC-03): allowlisted endpoint reachable, everything else
#     denied — including the embedded resolver 127.0.0.11 rejected BY ADDRESS,
#     and IPv6 closed at the packet level.
#   - ZERO GITHUB CREDENTIALS (CAM-EXEC-02): no credential-shaped env key and
#     no credential material on disk, asserted from inside the container.
#   - PROVIDER AUTH READ-ONLY (CAM-EXEC-02): the workspace is writable but the
#     provider-auth mount rejects writes.
#
# Instrumentation health: the harness asserts the POSITIVE nc control
# (allowed-endpoint-tcp) SUCCEEDS, so a missing/broken nc — which would make
# every denial probe fail for the wrong reason — is caught, not mistaken for
# denial. The `workspace-write` probe is the analogous control for the
# read-only assertion (writes CAN happen where allowed).
set -u

# This script's own path (run as `sh <path>`), so the content credential scan can
# exclude itself — it carries the very patterns it searches for (round-11 finding 9).
CAMINO_PROBE_SELF="$0"
export CAMINO_PROBE_SELF

run_probe() {
  name=$1
  shift
  out=$("$@" 2>&1)
  code=$?
  clean=$(printf '%s' "$out" | tr '\n' ' ' | sed 's/\\/\\\\/g; s/"/\\"/g' | cut -c1-200)
  printf '{"probe":"%s","exit":%d,"out":"%s"}\n' "$name" "$code" "$clean"
}

# --- identity: the workload is unprivileged and cannot lift the rules --------
run_probe uid id -u
run_probe rules-locked iptables -A OUTPUT -j ACCEPT

# --- egress: selective allow (CAM-EXEC-03) -----------------------------------
run_probe allowed-endpoint-http \
  wget -T 5 -q -O - "http://$CAMINO_PROBE_ALLOWED_HOST:$CAMINO_PROBE_ALLOWED_PORT/"
run_probe allowed-name-resolution getent hosts "$CAMINO_PROBE_ALLOWED_HOST"
# Positive nc control (by IP): proves nc works, so the DENY probes are trusted.
run_probe allowed-endpoint-tcp nc -w 5 "$CAMINO_PROBE_ALLOWED_IP" "$CAMINO_PROBE_ALLOWED_PORT"

# --- egress: selective deny --------------------------------------------------
run_probe non-allowlisted-sibling-tcp nc -w 3 "$CAMINO_PROBE_DENIED_IP" "$CAMINO_PROBE_DENIED_PORT"
run_probe allowed-host-wrong-port-tcp nc -w 3 "$CAMINO_PROBE_ALLOWED_IP" "$CAMINO_PROBE_WRONG_PORT"
run_probe non-allowlisted-name-resolution getent hosts "$CAMINO_PROBE_DENIED_HOST"
run_probe dns-lookup nslookup cloudflare.com
run_probe non-allowlisted-external-tcp nc -w 5 1.1.1.1 443

# IPv6 is closed at the packet level. The target is the ALLOWED endpoint's OWN
# IPv6 address, IN-NETWORK (its v4 is allowlisted): so a connection failure is
# attributable to the ip6tables OUTPUT DROP, not to a missing route — the v4
# leg to the same host succeeds above while this v6 leg to it must fail. The
# harness proves an UNRESTRICTED container reaches this same v6 address, so the
# denial is the profile's, not a dead endpoint. (Empty env → skipped cleanly on
# a host without container IPv6.)
if [ -n "${CAMINO_PROBE_ALLOWED_V6:-}" ]; then
  run_probe ipv6-peer-tcp nc -w 5 "$CAMINO_PROBE_ALLOWED_V6" "$CAMINO_PROBE_ALLOWED_PORT"
fi

# --- zero GitHub credentials, asserted in-container (CAM-EXEC-02) ------------
# No credential-shaped env KEY, and no GitHub-token-shaped VALUE under ANY key
# (round-12 finding 6), survives into the workload environment.
run_probe github-cred-env sh -c '
  env | grep -Eiq "GITHUB_TOKEN|GH_TOKEN|GH_ENTERPRISE_TOKEN|GITHUB_PAT|GIT_ASKPASS|GIT_TOKEN" && { echo LEAK; exit 0; }
  env | grep -Eq "gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}" && { echo LEAK; exit 0; }
  echo clean
'
# No stored-credential material on disk ANYWHERE the workload can see —
# including EVERY bind mount, whatever their number or paths (round-4 finding
# 3; generalized round-5 finding 5). Instead of -xdev + an enumerated mount
# list (which missed a second provider-auth mount), traverse the whole tree and
# PRUNE only the pseudo-filesystems (/proc, /sys, /dev) — so /workspace and any
# /auth/* mounts, on their own devices, are all covered without enumeration.
run_probe github-cred-fs sh -c '
  found=$(find / \
      -path /proc -prune -o -path /sys -prune -o -path /dev -prune -o \
      \( -name ".git-credentials" -o -name ".netrc" -o -name "_netrc" \) -print \
      2>/dev/null | head -1)
  [ -z "$found" ] && echo clean || echo "$found"
'
# Names are not enough (round-10 finding 7, hardened round-11 finding 9): a mounted
# gh hosts file holds a GitHub token under a host stanza, and a git-credentials URL
# embeds one (incl. a LEGACY 40-hex token as the URL password) — a read-only mount
# blocks WRITES, not disclosure. Scan the CONTENT of the credential-bearing roots
# for GitHub-SPECIFIC material, so the legitimately-mounted (non-GitHub) provider
# auth is not a false hit. Covers ALL auth mounts by scanning the whole /auth
# subtree (the allowlist forces every auth mount under it), the workspace and HOME;
# EXCLUDES this probe script (it contains the patterns). Binary files skipped (-I).
run_probe github-cred-content sh -c '
  roots=""
  for d in /auth "${CAMINO_WORKSPACE_DIR:-}" "${HOME:-}"; do
    [ -d "$d" ] && roots="$roots $d"
  done
  [ -z "$roots" ] && { echo clean; exit 0; }
  self="${CAMINO_PROBE_SELF:-/nonexistent}"
  # Pass 1: a modern gh token prefix anywhere; OR a userinfo URL to the github.com
  # HOST — case-INSENSITIVE host (GitHub.com), and BOUNDED so github.com.evil.tld
  # does NOT match; catches a legacy 40-hex token as the URL password (round-12
  # finding 6). `-l` lists matching files one per line; `while IFS= read -r`
  # reads each WHOLE line, so a path with spaces is preserved (no `-Z`, which the
  # profile grep does not support). A filename containing a newline is not covered.
  found=$(grep -rIliE "gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|://[^/@[:space:]]+:[^/@[:space:]]+@github\.com([:/]|$)" $roots 2>/dev/null \
    | while IFS= read -r f; do
        [ -n "$f" ] && [ "$f" != "$self" ] && { printf "%s" "$f"; break; }
      done)
  if [ -z "$found" ]; then
    # Pass 2: a github.com HOST stanza (bounded, case-insensitive) that also
    # carries a token line — the gh hosts.yml shape.
    found=$(grep -rIliE "(^|[^a-z0-9.])github\.com($|[:/])" $roots 2>/dev/null \
      | while IFS= read -r f; do
          [ -z "$f" ] && continue
          [ "$f" = "$self" ] && continue
          grep -Iiq -E "oauth_token|(^|[^a-z])token[[:space:]]*[:=]" "$f" 2>/dev/null && { printf "%s" "$f"; break; }
        done)
  fi
  [ -z "$found" ] && echo clean || echo "$found"
'

# --- workspace writable, provider auth NOT (CAM-EXEC-02) ---------------------
# Control: a write to the workspace SUCCEEDS (so a provider-auth write failure
# is attributable to :ro, not to a generally read-only filesystem).
run_probe workspace-write sh -c 'echo worker-output > "$CAMINO_WORKSPACE_DIR/probe-output.txt"'
# The provider-auth mount is read-only: a write attempt must FAIL.
run_probe provider-auth-write sh -c 'echo tampered > "$CAMINO_PROVIDER_AUTH_DIR/token"'
# …but the workload CAN read it (read-only, not inaccessible).
run_probe provider-auth-read cat "$CAMINO_PROVIDER_AUTH_DIR/token"
