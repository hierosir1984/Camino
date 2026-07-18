#!/bin/sh
# Egress probe workload — WP-005 test instrumentation, mounted read-only into
# the profiled container and run as the unprivileged workload user.
#
# Emits one JSON line per probe on stdout with the RAW observation (exit code
# + truncated output). The vitest harness decides pass/fail — the workload
# only produces evidence, it never decides (WP-004 convention).
#
# Expected env (set by the harness):
#   CAMINO_PROBE_ALLOWED_HOST / CAMINO_PROBE_ALLOWED_PORT — allowlisted endpoint
#   CAMINO_PROBE_DENIED_HOST  — non-allowlisted sibling endpoint (name)
#   CAMINO_PROBE_DENIED_IP / CAMINO_PROBE_DENIED_PORT — same endpoint by IP,
#     so the packet-level denial is probed independently of name resolution.
set -u

run_probe() {
  name=$1
  shift
  out=$("$@" 2>&1)
  code=$?
  clean=$(printf '%s' "$out" | tr '\n' ' ' | sed 's/\\/\\\\/g; s/"/\\"/g' | cut -c1-200)
  printf '{"probe":"%s","exit":%d,"out":"%s"}\n' "$name" "$code" "$clean"
}

# Identity: the workload is not root, so it cannot lift the rules.
run_probe uid id -u

# Selective ALLOW leg: full HTTP round-trip to the allowlisted endpoint, by
# name (resolution via the /etc/hosts pin — DNS itself is closed).
run_probe allowed-endpoint-http \
  wget -T 5 -q -O - "http://$CAMINO_PROBE_ALLOWED_HOST:$CAMINO_PROBE_ALLOWED_PORT/"
run_probe allowed-name-resolution getent hosts "$CAMINO_PROBE_ALLOWED_HOST"

# Selective DENY leg: the sibling endpoint on the SAME network, probed by IP
# (the unrestricted control proves it is alive and serving).
run_probe non-allowlisted-sibling-tcp nc -w 3 "$CAMINO_PROBE_DENIED_IP" "$CAMINO_PROBE_DENIED_PORT"

# Non-allowlisted names neither resolve (DNS closed, no pin) …
run_probe non-allowlisted-name-resolution getent hosts "$CAMINO_PROBE_DENIED_HOST"
# … nor is the resolver channel open at all.
run_probe dns-lookup nslookup cloudflare.com

# External leg: a real, listening public endpoint — if the profile were
# allow-all AND the host had internet, this would connect and the harness
# would catch it; under the profile it is rejected in-container, so the
# probe also works offline.
run_probe non-allowlisted-external-tcp nc -w 5 1.1.1.1 443

# The workload cannot alter the rules it runs under.
run_probe rules-locked iptables -A OUTPUT -j ACCEPT
