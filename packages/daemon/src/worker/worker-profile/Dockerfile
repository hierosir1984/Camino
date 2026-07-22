# Worker-container isolation profile — WP-107 (CAM-EXEC-02/03), productized
# from the WP-005 validation-egress image (spikes/validation-env/profile).
#
# One small image, two roles in the worker suite:
#   - default entrypoint = the worker profile: installs default-deny egress
#     rules with the per-repo allowlist, verifies them, clears the bootstrap
#     env, then drops to the unprivileged `camino` user and execs the
#     workload (which cannot alter the rules it runs under);
#   - the test endpoints and the unrestricted control override the entrypoint,
#     so no firewall is installed for those roles.
#
# BOUNDARY, stated (round-3 finding 13): this image is the ISOLATION HARNESS
# (entrypoint + rule tools + git for workspace operations). The real worker
# TOOLCHAIN image (node, vendor CLIs) is layered on top by the attempt runner
# (WP-114). The run-time guarantees (cap-drop, no-new-privs, pinned entrypoint,
# refused bootstrap-path mounts) hold for a CAMINO-BUILT image; they do NOT
# survive a maliciously-BUILT image that replaced the entrypoint binary's
# contents. Image PROVENANCE is WP-114's build boundary, not the composer's.
FROM alpine:3.20

# iptables: rule installation; busybox-extras: httpd/nc for the test
# endpoints and probes; su-exec: privilege drop to the workload user;
# git: workspace operations inside the container.
RUN apk add --no-cache iptables busybox-extras su-exec git \
  && adduser -D -u 1000 camino

COPY entrypoint.sh /usr/local/bin/worker-profile-entrypoint
RUN chmod 0755 /usr/local/bin/worker-profile-entrypoint

ENTRYPOINT ["/usr/local/bin/worker-profile-entrypoint"]
CMD ["/bin/sh"]
