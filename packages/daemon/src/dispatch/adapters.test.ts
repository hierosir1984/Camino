import { execFileSync } from "node:child_process";
import { rmSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { claudeAdapter } from "./adapters/claude.js";
import { codexAdapter } from "./adapters/codex.js";
import { grokAdapter } from "./adapters/grok.js";
import { classifyByQuotaSignal, classifyErrorTextForQuota } from "./quota.js";
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

  it("genuine STRUCTURED rate-limit signatures ARE flagged prose-safely", () => {
    for (const bad of [
      "429 Too Many Requests",
      "HTTP 429",
      "Error: 429",
      "status 429",
      '{"status_code":429}',
      '{"statusCode": 429}',
      "rate_limit_exceeded",
      "rate_limit_error",
      "overloaded_error",
      "insufficient_quota",
      "resource_exhausted",
      "retry-after: 30",
      "retry_after 10s",
      "Retry-After: Wed, 21 Oct 2015 07:28:00 GMT",
    ]) {
      expect(classifyByQuotaSignal(bad), bad).toBe(true);
    }
  });

  it("does NOT flag benign 429/retry-after/exhaustion PROSE with the structured classifier (round-2 finding 5)", () => {
    for (const benign of [
      "Resolved GitHub issue #429 about caching",
      "issue 429 was closed",
      "the 429th commit landed",
      "Implemented Retry-After header parsing",
      "Fixed bug in retry-after config docs",
      "rate limiting strategy documentation",
      // The provider exhaustion PHRASES are prose-risky, so the prose-safe
      // classifier deliberately does NOT match them — only the error-context
      // classifier does (see below).
      "Customer's credit balance is too low for financing",
      "Documentation: usage limit reached in older tiers",
      "You've hit your usage limit.",
      "Credit balance is too low",
    ]) {
      expect(classifyByQuotaSignal(benign), benign).toBe(false);
    }
  });

  it("the ERROR-CONTEXT classifier flags provider exhaustion phrases (round-2 finding 5)", () => {
    for (const real of [
      "You've hit your usage limit.", // installed Codex CLI
      "Credit balance is too low", // Anthropic spent-balance block
      "usage limit reached",
      "usage limit exceeded",
      "quota exceeded",
      "HTTP 429 Too Many Requests", // structured signatures still count
    ]) {
      expect(classifyErrorTextForQuota(real), real).toBe(true);
    }
    // …but even in error context, genuinely unrelated failures are not quota.
    for (const notQuota of ["file not found", "syntax error on line 3", "the operation failed"]) {
      expect(classifyErrorTextForQuota(notQuota), notQuota).toBe(false);
    }
  });

  it("an assistant message that merely MENTIONS an exhaustion phrase is not flagged as quota", () => {
    // The claude parser routes assistant content through the prose-safe path;
    // only an ERROR result trusts the phrase (round-2 finding 5).
    const assistant = claudeAdapter().parseLine(
      '{"type":"assistant","message":{"content":[{"type":"text","text":"Their credit balance is too low, so suggest topping up."}]}}',
      "stdout",
    );
    expect(assistant?.kind).toBe("assistant");
    expect(assistant?.quotaSignal).toBeUndefined();

    const errorResult = claudeAdapter().parseLine(
      '{"type":"result","subtype":"error","is_error":true,"result":"Credit balance is too low"}',
      "stdout",
    );
    expect(errorResult?.kind).toBe("error");
    expect(errorResult?.quotaSignal).toBe(true); // trusted in the error result
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
