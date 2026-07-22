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

# The embedded resolver 127.0.0.11 must be rejected BY ADDRESS, on a port other
# than 53 — Docker DNAT-redirects resolver traffic off port 53 before the
# filter chain, so a --dport 53 rule alone would miss it (the WP-005 finding).
run_probe resolver-address-tcp nc -w 3 127.0.0.11 5353

# IPv6 is closed at the packet level (WP-005 deferred a full v6 round-trip to
# here). A public IPv6 literal must be unreachable; if the stack has no v6 at
# all the connect still fails, which is also a pass for "v6 unreachable".
run_probe ipv6-external-tcp nc -w 5 2606:4700:4700::1111 443

# --- zero GitHub credentials, asserted in-container (CAM-EXEC-02) ------------
# No credential-shaped env key survives into the workload environment.
run_probe github-cred-env sh -c '
  env | grep -Eiq "GITHUB_TOKEN|GH_TOKEN|GH_ENTERPRISE_TOKEN|GITHUB_PAT|GIT_ASKPASS|GIT_TOKEN" && echo LEAK || echo clean
'
# No stored-credential material on disk anywhere the workload can see.
run_probe github-cred-fs sh -c '
  found=$(find / -xdev \( -name ".git-credentials" -o -name ".netrc" \) 2>/dev/null | head -1)
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
