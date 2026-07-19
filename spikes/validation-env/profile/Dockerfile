# Validation-environment egress profile — WP-005 (CAM-VAL-03 egress half).
#
# One small image, two roles in the suite:
#   - default entrypoint = the egress profile: installs default-deny egress
#     rules with an allowlist, then drops to the unprivileged `camino` user
#     and execs the workload (which cannot alter the rules it runs under);
#   - the test endpoints and the unrestricted control override the entrypoint,
#     so no firewall is installed for those roles.
#
# The profile shape (allowlist as runtime data, root-setup-then-drop) is what
# WP-107 (worker egress) and WP-115 (validation runner) productize.
FROM alpine:3.20

# iptables: rule installation; busybox-extras: httpd for the test endpoints;
# su-exec: privilege drop to the workload user.
RUN apk add --no-cache iptables busybox-extras su-exec \
  && adduser -D -u 1000 camino

COPY entrypoint.sh /usr/local/bin/egress-profile-entrypoint
RUN chmod 0755 /usr/local/bin/egress-profile-entrypoint

ENTRYPOINT ["/usr/local/bin/egress-profile-entrypoint"]
CMD ["/bin/sh"]
