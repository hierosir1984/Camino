import { execFileSync } from "node:child_process";
import { rmSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { claudeAdapter } from "./adapters/claude.js";
import { codexAdapter } from "./adapters/codex.js";
import { grokAdapter } from "./adapters/grok.js";
import { classifyByQuotaSignal, classifyErrorTextForQuota, sumUsageTokens } from "./quota.js";
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
      // A rate limit is an ERROR event, not the token-streamed "text" answer
      // (round-3 finding 2).
      line: '{"type":"error","message":"rate_limit_exceeded — please retry_after 10s"}',
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

  it("genuine STRUCTURED rate-limit signatures ARE flagged in a prose-resistant way", () => {
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
      // The provider exhaustion PHRASES are prose-risky, so the prose-resistant
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
    // The claude parser routes assistant content through the prose-resistant path;
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

// WP-107 CAM-EXEC-03 "tokens where reportable" (round-1 finding 6): the token
// figure a budget checks must count EVERY consumed-token variant, or a run
// riding cache-read tokens evades a small budget.
describe("sumUsageTokens (token-budget accounting)", () => {
  it("sums input + output + cache_creation + cache_read (Anthropic total)", () => {
    expect(
      sumUsageTokens({
        input_tokens: 1,
        output_tokens: 1,
        cache_read_input_tokens: 2000,
        cache_creation_input_tokens: 500,
      }),
    ).toBe(2502);
  });

  it("does not let cache-read tokens evade the count (the finding-6 receipt)", () => {
    // 2000 cache-read tokens + a 1000 budget must be over budget, not under.
    const total = sumUsageTokens({
      input_tokens: 1,
      output_tokens: 1,
      cache_read_input_tokens: 2000,
      cache_creation_input_tokens: 0,
    });
    expect(total).toBe(2002);
    expect(total).toBeGreaterThan(1000);
  });

  it("is undefined only when NO recognized field is present, never a throw", () => {
    expect(sumUsageTokens(undefined)).toBeUndefined();
    expect(sumUsageTokens(null)).toBeUndefined();
    expect(sumUsageTokens("nope")).toBeUndefined();
    expect(sumUsageTokens({})).toBeUndefined();
    expect(sumUsageTokens({ other: 5 })).toBeUndefined();
  });

  it("fails CLOSED on a hostile field: a present non-finite/negative field caps at MAX_SAFE_INTEGER (round-3 finding 10)", () => {
    // A PRESENT numeric field that is non-finite or negative must NOT be
    // silently dropped (that let the other fields sum small and evade the
    // budget). Any bad field caps the whole figure so it trips any budget.
    expect(sumUsageTokens({ input_tokens: Infinity, output_tokens: 1 })).toBe(
      Number.MAX_SAFE_INTEGER,
    ); // JSON `1e309` parses to Infinity
    expect(sumUsageTokens({ input_tokens: 10, output_tokens: -1 })).toBe(Number.MAX_SAFE_INTEGER);
    expect(sumUsageTokens({ input_tokens: 10, cache_read_input_tokens: NaN })).toBe(
      Number.MAX_SAFE_INTEGER,
    );
  });

  it("fails CLOSED on an overflowing sum — clamps to MAX_SAFE_INTEGER, never discards (round-2 finding 9)", () => {
    // Two finite fields whose SUM leaves the finite range.
    const total = sumUsageTokens({ input_tokens: 1e308, output_tokens: 1e308 });
    expect(total).toBe(Number.MAX_SAFE_INTEGER);
    expect(Number.isFinite(total)).toBe(true);
  });

  it("the claude result parser reports the cumulative total incl. cache tokens", () => {
    const ev = claudeAdapter().parseLine(
      '{"type":"result","result":"done","usage":{"input_tokens":10,"output_tokens":20,"cache_read_input_tokens":100,"cache_creation_input_tokens":5}}',
      "stdout",
    );
    expect(ev?.terminalSuccess).toBe(true);
    expect(ev?.tokensTotal).toBe(135);
  });
});

// Round-3 finding 2: quotaSignal is attached ONLY in an error context. A
// STRUCTURED signature OR an exhaustion phrase appearing in assistant/answer
// output is NOT a quota block; the same content in an error/stderr event IS.
describe("adapter quota gating is error-context-only (round-3 finding 2)", () => {
  it("assistant/answer events NEVER carry quotaSignal, even quoting a rate-limit line", () => {
    const claudeAssistant = claudeAdapter().parseLine(
      '{"type":"assistant","message":{"content":[{"type":"text","text":"I closed issues 428, 429, and 430; the server returned HTTP 429 earlier."}]}}',
      "stdout",
    );
    expect(claudeAssistant?.kind).toBe("assistant");
    expect(claudeAssistant?.quotaSignal).toBeUndefined();

    const codexAnswer = codexAdapter().parseLine(
      '{"type":"item.completed","item":{"type":"agent_message","text":"We rejected too many requests for new features; documented resource_exhausted handling."}}',
      "stdout",
    );
    expect(codexAnswer?.kind).toBe("result");
    expect(codexAnswer?.quotaSignal).toBeUndefined();

    const grokText = grokAdapter().parseLine(
      '{"type":"text","data":"Please retry after: lunch. HTTP 429 is the rate-limit status."}',
      "stdout",
    );
    expect(grokText?.kind).toBe("assistant");
    expect(grokText?.quotaSignal).toBeUndefined();
  });

  it("error/stderr events DO carry quotaSignal for a real signal (incl. exhaustion phrases)", () => {
    // claude non-JSON stderr exhaustion phrase — the round-3 false-negative.
    const claudeStderr = claudeAdapter().parseLine("Credit balance is too low", "stderr");
    expect(claudeStderr?.kind).toBe("error");
    expect(claudeStderr?.quotaSignal).toBe(true);

    // claude top-level error event.
    const claudeErr = claudeAdapter().parseLine(
      '{"type":"error","message":"429 Too Many Requests"}',
      "stdout",
    );
    expect(claudeErr?.kind).toBe("error");
    expect(claudeErr?.quotaSignal).toBe(true);

    // codex error item.
    const codexErr = codexAdapter().parseLine(
      '{"type":"item.completed","item":{"type":"error","message":"You\'ve hit your usage limit."}}',
      "stdout",
    );
    expect(codexErr?.kind).toBe("error");
    expect(codexErr?.quotaSignal).toBe(true);

    // grok error event carrying its text under `message` (not `data`).
    const grokErr = grokAdapter().parseLine(
      '{"type":"error","message":"rate_limit_exceeded"}',
      "stdout",
    );
    expect(grokErr?.kind).toBe("error");
    expect(grokErr?.quotaSignal).toBe(true);
  });

  it("a genuinely unrelated error is NOT quota (no false positive in error context)", () => {
    const codexErr = codexAdapter().parseLine(
      '{"type":"item.completed","item":{"type":"error","message":"compilation failed: undefined symbol"}}',
      "stdout",
    );
    expect(codexErr?.quotaSignal).toBeUndefined();
  });

  it("codex turn.failed carries quota via its NESTED error.message (round-4 finding 2)", () => {
    // Official Codex 0.144 schema: {type:"turn.failed", error:{message}}. The
    // type does not contain "error", so it must be handled explicitly.
    const ev = codexAdapter().parseLine(
      '{"type":"turn.failed","error":{"message":"You\'ve hit your usage limit."}}',
      "stdout",
    );
    expect(ev?.kind).toBe("error");
    expect(ev?.quotaSignal).toBe(true);
  });

  it("claude does NOT flag quota-looking non-JSON on STDOUT, only on stderr (round-4 finding 2)", () => {
    const stdout = claudeAdapter().parseLine(
      "Documentation example: HTTP 429 means rate limiting.",
      "stdout",
    );
    expect(stdout).toBeNull(); // stdout prose is not an error context

    const stderr = claudeAdapter().parseLine("HTTP 429 Too Many Requests", "stderr");
    expect(stderr?.kind).toBe("error");
    expect(stderr?.quotaSignal).toBe(true);
  });

  it("a truncated/malformed provider error on STDERR still yields a quota signal (round-4 finding 2)", () => {
    // Dropped-line protection, scoped to the error channel: a truncated JSON
    // error whose signal token survives the truncation still classifies.
    for (const adapter of [codexAdapter(), grokAdapter()]) {
      const ev = adapter.parseLine('{"error":{"message":"rate_limit_exceeded — truncat', "stderr");
      expect(ev?.quotaSignal, adapter.name).toBe(true);
    }
    // …but a malformed line on STDOUT is not treated as a quota error.
    expect(codexAdapter().parseLine('{"broken rate_limit_exceeded', "stdout")).toBeNull();
  });

  it("flags the installed provider exhaustion strings the raw scan used to catch (round-4 finding 3)", () => {
    for (const s of [
      "You hit your weekly limit.",
      "You hit your free usage limit.",
      "run out of credits",
      "over your spending limit",
      "usage balance exhausted",
      "Please retry after 10 seconds.",
      "You have exceeded your rate limit.",
    ]) {
      expect(classifyErrorTextForQuota(s), s).toBe(true);
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
