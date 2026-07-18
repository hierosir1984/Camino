#!/bin/sh
# Egress-profile entrypoint — WP-005 (CAM-VAL-03 egress half; reused by
# WP-107 worker egress and WP-115 validation runner).
#
# Runs as root inside the container, in this order:
#   1. resolve every allowlist entry and pin it into /etc/hosts (DNS is closed
#      afterwards, so pinning is how allowlisted names stay resolvable);
#   2. install default-deny OUTPUT rules with one accept per allowlist entry;
#   3. drop to the unprivileged `camino` user and exec the workload.
# The workload runs without CAP_NET_ADMIN, so it cannot alter the rules.
#
# Contract:
#   CAMINO_EGRESS_ALLOWLIST — required (may be empty = deny-all). Space-
#   separated host:port entries, TCP, IPv4. Hostnames resolve via the
#   container network's DNS at setup time only.
#
# Fail-closed: any setup error aborts the container before the workload runs.
set -eu

# Required-but-may-be-empty: ${VAR?} (no colon) fails only when unset.
: "${CAMINO_EGRESS_ALLOWLIST?CAMINO_EGRESS_ALLOWLIST must be set (space-separated host:port entries; empty string = deny-all)}"

ALLOW_RULES=""
for entry in $CAMINO_EGRESS_ALLOWLIST; do
  host=${entry%:*}
  port=${entry##*:}
  if [ "$host" = "$entry" ] || [ -z "$host" ] || [ -z "$port" ]; then
    echo "egress-profile: malformed allowlist entry '$entry' (want host:port)" >&2
    exit 64
  fi
  case $port in
    *[!0-9]*) echo "egress-profile: non-numeric port in '$entry'" >&2; exit 64 ;;
  esac
  if [ "$port" -lt 1 ] || [ "$port" -gt 65535 ]; then
    echo "egress-profile: port out of range in '$entry'" >&2
    exit 64
  fi

  # Resolve now (rules are not installed yet, so the network's DNS still
  # answers). Pipeline status is awk's, so failure shows as empty output.
  ips=$(getent hosts "$host" | awk '{ print $1 }')
  v4=""
  for ip in $ips; do
    case $ip in
      *.*.*.*) v4="$v4 $ip" ;;
    esac
  done
  if [ -z "$v4" ]; then
    echo "egress-profile: cannot resolve '$host' to an IPv4 address — refusing to start (fail-closed)" >&2
    exit 65
  fi
  for ip in $v4; do
    ALLOW_RULES="${ALLOW_RULES}${ip} ${port}
"
    # Pin so the workload can still resolve the allowlisted name once DNS
    # is closed. Rules are IP-based; the pin is name convenience only.
    echo "$ip $host" >>/etc/hosts
  done
done

# ---- IPv4 rules -----------------------------------------------------------
iptables -F OUTPUT
# DNS is closed: the embedded resolver (127.0.0.11) forwards queries upstream
# from outside this network namespace, which would leave an open resolver
# channel under an otherwise default-deny posture. Docker DNAT-redirects
# resolver traffic to a dynamic port before the filter chain sees it, so the
# address must be rejected on EVERY port — a --dport 53 match alone misses it
# (observed during WP-005 shakedown). Allowlisted names are pinned in
# /etc/hosts above instead; generic port-53 rules cover standard resolvers.
iptables -A OUTPUT -d 127.0.0.11 -j REJECT
iptables -A OUTPUT -o lo -p udp --dport 53 -j REJECT
iptables -A OUTPUT -o lo -p tcp --dport 53 -j REJECT
iptables -A OUTPUT -o lo -j ACCEPT
# Replies on connections that already passed the allowlist (and inbound-
# initiated ones; this profile's workload has no listener — WP-107 closes
# INPUT as well).
iptables -A OUTPUT -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT
printf '%s' "$ALLOW_RULES" | while read -r ip port; do
  [ -n "$ip" ] || continue
  iptables -A OUTPUT -d "$ip" -p tcp --dport "$port" -j ACCEPT
done
# Everything else fails fast (REJECT, not silent DROP: deterministic workload
# failures instead of timeouts), with policy DROP as the backstop.
iptables -A OUTPUT -j REJECT
iptables -P OUTPUT DROP

# ---- IPv6: no allowlist entries in this profile — closed entirely ---------
if [ -e /proc/net/if_inet6 ]; then
  ip6tables -F OUTPUT
  ip6tables -A OUTPUT -o lo -p udp --dport 53 -j REJECT
  ip6tables -A OUTPUT -o lo -p tcp --dport 53 -j REJECT
  ip6tables -A OUTPUT -o lo -j ACCEPT
  ip6tables -A OUTPUT -j REJECT
  ip6tables -P OUTPUT DROP
fi

# Post-install verification (fail-closed): the deny backstops must be present
# in the live rule set before any workload runs.
iptables -S OUTPUT | grep -q -- '^-P OUTPUT DROP$' || {
  echo "egress-profile: IPv4 deny policy missing after install — refusing to start" >&2
  exit 66
}
iptables -S OUTPUT | grep -q -- '-j REJECT' || {
  echo "egress-profile: IPv4 reject rule missing after install — refusing to start" >&2
  exit 66
}

# Evidence for the harness: the exact rules the workload runs under.
echo "egress-profile: rules installed" >&2
iptables -S OUTPUT >&2

exec su-exec camino:camino "$@"
