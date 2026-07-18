#!/bin/sh
# Egress-profile entrypoint — WP-005 (CAM-VAL-03 egress half; reused by
# WP-107 worker egress and WP-115 validation runner).
#
# Runs as root inside the container, in this order:
#   1. resolve every allowlist entry and pin it into /etc/hosts (DNS is closed
#      afterwards, so pinning is how allowlisted names stay resolvable);
#   2. install default-deny INPUT + OUTPUT rules with one accept per allowlist
#      entry;
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

# Absolute tool paths + a scrubbed loader environment: the bootstrap must not be
# steerable by a caller-supplied PATH / LD_* even though container params are
# Camino-composed (defence in depth for the WP-107/WP-115 reuse). The busybox
# applets and su-exec live in these fixed locations on the alpine base.
PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
export PATH
unset LD_PRELOAD LD_LIBRARY_PATH LD_AUDIT 2>/dev/null || true
IPTABLES=/sbin/iptables
IP6TABLES=/sbin/ip6tables
GETENT=/usr/bin/getent
SU_EXEC=/sbin/su-exec

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
  ips=$("$GETENT" hosts "$host" | awk '{ print $1 }')
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

# ---- IPv4 INPUT: default-deny -------------------------------------------
# Closing INPUT is load-bearing for the egress claim, not just ingress: with
# INPUT open, a workload could accept an inbound connection from a
# non-allowlisted peer and reply over it — and those replies are ESTABLISHED,
# so an OUTPUT `ESTABLISHED,RELATED` accept would let them bypass the
# destination allowlist. Allowing INPUT only for loopback and for replies to
# OUR OWN outbound connections means no externally-initiated connection can
# ever reach ESTABLISHED, so the OUTPUT established-accept below can only match
# connections that already passed the allowlist.
"$IPTABLES" -F INPUT
"$IPTABLES" -A INPUT -i lo -j ACCEPT
"$IPTABLES" -A INPUT -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT
"$IPTABLES" -A INPUT -j REJECT
"$IPTABLES" -P INPUT DROP

# ---- IPv4 OUTPUT: default-deny with the allowlist -----------------------
"$IPTABLES" -F OUTPUT
# DNS is closed: the embedded resolver (127.0.0.11) forwards queries upstream
# from outside this network namespace, which would leave an open resolver
# channel under an otherwise default-deny posture. Docker DNAT-redirects
# resolver traffic to a dynamic port before the filter chain sees it, so the
# address must be rejected on EVERY port — a --dport 53 match alone misses it
# (observed during WP-005 shakedown). Allowlisted names are pinned in
# /etc/hosts above instead; generic port-53 rules cover standard resolvers.
"$IPTABLES" -A OUTPUT -d 127.0.0.11 -j REJECT
"$IPTABLES" -A OUTPUT -o lo -p udp --dport 53 -j REJECT
"$IPTABLES" -A OUTPUT -o lo -p tcp --dport 53 -j REJECT
"$IPTABLES" -A OUTPUT -o lo -j ACCEPT
# Replies on connections WE initiated (INPUT default-deny above means an
# externally-initiated connection can never reach ESTABLISHED here).
"$IPTABLES" -A OUTPUT -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT
printf '%s' "$ALLOW_RULES" | while read -r ip port; do
  [ -n "$ip" ] || continue
  "$IPTABLES" -A OUTPUT -d "$ip" -p tcp --dport "$port" -j ACCEPT
done
# Everything else fails fast (REJECT, not silent DROP: deterministic workload
# failures instead of timeouts), with policy DROP as the backstop.
"$IPTABLES" -A OUTPUT -j REJECT
"$IPTABLES" -P OUTPUT DROP

# ---- IPv6: no allowlist entries in this profile — closed entirely ---------
HAVE_V6=0
if [ -e /proc/net/if_inet6 ]; then
  HAVE_V6=1
  "$IP6TABLES" -F INPUT
  "$IP6TABLES" -A INPUT -i lo -j ACCEPT
  "$IP6TABLES" -A INPUT -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT
  "$IP6TABLES" -A INPUT -j REJECT
  "$IP6TABLES" -P INPUT DROP
  "$IP6TABLES" -F OUTPUT
  "$IP6TABLES" -A OUTPUT -o lo -j ACCEPT
  "$IP6TABLES" -A OUTPUT -j REJECT
  "$IP6TABLES" -P OUTPUT DROP
fi

# Post-install verification (fail-closed): the deny backstops must be present
# in the live rule set before any workload runs — IPv4 OUTPUT and INPUT, and
# IPv6 too where the stack exists.
verify_chain() {
  # $1 = binary, $2 = chain
  "$1" -S "$2" | grep -q -- "^-P $2 DROP$" || {
    echo "egress-profile: $1 $2 deny policy missing after install — refusing to start" >&2
    exit 66
  }
  "$1" -S "$2" | grep -q -- '-j REJECT' || {
    echo "egress-profile: $1 $2 reject rule missing after install — refusing to start" >&2
    exit 66
  }
}
verify_chain "$IPTABLES" OUTPUT
verify_chain "$IPTABLES" INPUT
if [ "$HAVE_V6" -eq 1 ]; then
  verify_chain "$IP6TABLES" OUTPUT
  verify_chain "$IP6TABLES" INPUT
fi

# Evidence for the harness: the exact rules the workload runs under.
echo "egress-profile: rules installed" >&2
"$IPTABLES" -S OUTPUT >&2
"$IPTABLES" -S INPUT >&2

exec "$SU_EXEC" camino:camino "$@"
