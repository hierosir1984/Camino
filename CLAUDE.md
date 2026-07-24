# Camino — agent session rules

## CPU load testing

Never start ad-hoc background load processes (e.g. `(yes > /dev/null &)`) — a
2026-07-22 incident leaked 40 of them for two days because the shell cleanup
silently failed. Use the owned-process-group helper instead:

```bash
# Run a command under CPU load (load tears down when the command exits):
npm run load-test -- --workers 8 -- ./node_modules/.bin/vitest run <suite>

# Timed load:
npm run load-test -- --workers 8 --duration 90s
```

The helper owns every process it starts (dedicated process group, cleanup on
all exit paths incl. SIGKILL of the controller via leader backstops), verifies
teardown, and records evidence JSON under `.camino/load-test/`. If it refuses
to start because of leftovers, rerun with `--reap-leftovers`.
