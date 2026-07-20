import { execFileSync } from "node:child_process";
import { rmSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { claudeAdapter } from "./adapters/claude.js";
import { codexAdapter } from "./adapters/codex.js";
import { grokAdapter } from "./adapters/grok.js";
import { classifyByQuotaSignal } from "./quota.js";
import { committedSince, headSha, makeWorkspace } from "./workspace.js";

// Per-provider quota classification (CAM-EXEC-06), provoked without spending
// real quota: each adapter must flag its provider's actual rate-limit line, and
// must NOT flag benign text containing topic words (WP-001 review #2, #7).
describe("per-provider quota classification", () => {
  const cases: Array<{ name: string; adapter: ReturnType<typeof claudeAdapter>; line: string }> = [
    {
      name: "claude",
      adapter: claudeAdapter(),
      line: '{"type":"result","subtype":"error","is_error":true,"result":"429 rate_limit_error: usage limit reached"}',
    },
    {
      name: "codex",
      adapter: codexAdapter(),
      line: '{"type":"item.completed","item":{"type":"error","message":"stream error: 429 Too Many Requests; retry-after 30"}}',
    },
    {
      name: "grok",
      adapter: grokAdapter(),
      line: '{"type":"text","data":"error: rate_limit_exceeded — please retry_after 10s"}',
    },
  ];

  for (const c of cases) {
    it(`${c.name}: real rate-limit line → quotaSignal`, () => {
      const ev = c.adapter.parseLine(c.line, "stdout");
      expect(ev?.quotaSignal, `${c.name} must flag its rate-limit line`).toBe(true);
    });
  }

  it("claude: a rate-limit signal on non-JSON stderr is not lost", () => {
    const ev = claudeAdapter().parseLine("HTTP 429 too many requests", "stderr");
    expect(ev?.quotaSignal).toBe(true);
  });

  it("benign text with topic words is NOT flagged as quota", () => {
    for (const benign of [
      "This requirement needs capacity planning",
      "The service is not overloaded",
      "No quota issue detected here",
      "rate limiting strategy documentation",
    ]) {
      expect(classifyByQuotaSignal(benign), benign).toBe(false);
    }
  });

  it("genuine rate-limit phrasings ARE flagged", () => {
    for (const bad of [
      "429 Too Many Requests",
      "rate_limit_exceeded",
      "usage limit reached",
      "quota exceeded",
      "overloaded_error",
      "retry-after: 30",
    ]) {
      expect(classifyByQuotaSignal(bad), bad).toBe(true);
    }
  });
});

// Parser robustness: syntactically valid events with malformed shapes, and
// non-JSON lines, must never throw (WP-001 review #5).
describe("parser robustness", () => {
  const malformed = [
    "not json at all",
    "{ broken json",
    '{"type":"assistant","message":{"content":"not-an-array"}}',
    '{"type":"assistant","message":{"content":[null]}}',
    '{"type":"assistant","message":{"content":[{"type":"tool_use","name":"x"}]}}',
    '{"type":"assistant"}',
    '{"type":"result"}',
    "{}",
  ];
  for (const adapter of [claudeAdapter(), codexAdapter(), grokAdapter()]) {
    it(`${adapter.name} never throws on malformed lines`, () => {
      for (const line of malformed) {
        expect(() => adapter.parseLine(line, "stdout")).not.toThrow();
        expect(() => adapter.parseLine(line, "stderr")).not.toThrow();
      }
    });
  }

  it("claude maps a tool_use block to a tool event", () => {
    const ev = claudeAdapter().parseLine(
      '{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Write"}]}}',
      "stdout",
    );
    expect(ev?.kind).toBe("tool");
  });
});

// Subscription custody at the plan level (CAM-SEC-06): the official-CLI
// adapters pass no env at all — auth is the CLI's own, under HOME.
describe("subscription adapter plans carry no env", () => {
  for (const adapter of [claudeAdapter(), codexAdapter(), grokAdapter()]) {
    it(`${adapter.name} plan() sets no env keys`, () => {
      const plan = adapter.plan({ workdir: "/tmp/ws", prompt: "p", model: "m" });
      expect(Object.keys(plan.env ?? {})).toEqual([]);
      expect(plan.stdin).toBeUndefined();
    });
  }
});

// committedSince must only report genuine forward progress (WP-001 review #10).
describe("committedSince ancestry", () => {
  it("reports a real new commit but not a rollback to an ancestor", () => {
    const ws = makeWorkspace();
    try {
      const before = headSha(ws)!;
      execFileSync("bash", [
        "-c",
        `cd "${ws}" && echo x > a.txt && git add -A && git commit -q -m second`,
      ]);
      const after = headSha(ws)!;
      expect(committedSince(ws, before)).toBe(after); // genuine advance

      execFileSync("git", ["-C", ws, "reset", "--hard", "--quiet", before]);
      // HEAD is now the OLD commit; that is not a "new" worker commit.
      expect(committedSince(ws, after)).toBeNull();
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });
});
