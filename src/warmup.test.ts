import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { formatWarmupError, parseWarmupOutput } from "./warmup";

describe("parseWarmupOutput", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2025-01-15T10:00:00.000Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("parses valid JSON with all fields", () => {
    const stdout = JSON.stringify({
      session_id: "sess_123",
      usage: {
        input_tokens: 100,
        output_tokens: 50,
        cache_creation_input_tokens: 10,
        cache_read_input_tokens: 5,
      },
      total_cost_usd: 0.05,
    });

    const { warmupResult, sessionArgs } = parseWarmupOutput(stdout);

    expect(warmupResult).toEqual({
      success: true,
      session_id: "sess_123",
      usage: {
        input_tokens: 100,
        output_tokens: 50,
        cache_creation_input_tokens: 10,
        cache_read_input_tokens: 5,
      },
      cost_usd: 0.05,
    });

    expect(sessionArgs[1]).toBe("sess_123"); // session_id
    expect(sessionArgs[2]).toBe("2025-01-15T10:00:00.000Z"); // started_at
    expect(sessionArgs[3]).toBe("2025-01-15T15:00:00.000Z"); // expires_at (5h later)
    expect(sessionArgs[4]).toBe(100); // input_tokens
    expect(sessionArgs[5]).toBe(50); // output_tokens
    expect(sessionArgs[6]).toBe(10); // cache_creation_tokens
    expect(sessionArgs[7]).toBe(5); // cache_read_tokens
    expect(sessionArgs[8]).toBe(0.05); // cost_usd
  });

  it("defaults missing session_id to unknown", () => {
    const stdout = JSON.stringify({ usage: {}, total_cost_usd: 0 });
    const { sessionArgs } = parseWarmupOutput(stdout);
    expect(sessionArgs[1]).toBe("unknown");
  });

  it("defaults missing usage fields to 0", () => {
    const stdout = JSON.stringify({ session_id: "s1" });
    const { sessionArgs } = parseWarmupOutput(stdout);
    expect(sessionArgs[4]).toBe(0); // input_tokens
    expect(sessionArgs[5]).toBe(0); // output_tokens
    expect(sessionArgs[6]).toBe(0); // cache_creation_tokens
    expect(sessionArgs[7]).toBe(0); // cache_read_tokens
  });

  it("defaults missing cost to 0", () => {
    const stdout = JSON.stringify({ session_id: "s1" });
    const { sessionArgs } = parseWarmupOutput(stdout);
    expect(sessionArgs[8]).toBe(0);
  });

  it("throws on invalid JSON", () => {
    expect(() => parseWarmupOutput("not json")).toThrow();
  });

  it("throws when Claude returns an API error payload", () => {
    const stdout = JSON.stringify({
      type: "result",
      subtype: "success",
      is_error: true,
      api_error_status: 429,
      result: "You've hit your session limit",
      session_id: "sess_limited",
      usage: {
        input_tokens: 0,
        output_tokens: 0,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
      },
      total_cost_usd: 0,
    });

    expect(() => parseWarmupOutput(stdout)).toThrow("You've hit your session limit");
  });
});

describe("formatWarmupError", () => {
  it("uses stderr when available", () => {
    expect(formatWarmupError("", "command failed", 1)).toBe("command failed");
  });

  it("extracts Claude error JSON from stdout", () => {
    const stdout = JSON.stringify({
      is_error: true,
      api_error_status: 401,
      result: "Failed to authenticate. API Error: 401 Invalid bearer token",
    });

    expect(formatWarmupError(stdout, "", 1)).toBe(
      "Failed to authenticate. API Error: 401 Invalid bearer token"
    );
  });

  it("falls back to exit code when no output is available", () => {
    expect(formatWarmupError("", "", 1)).toBe("exit code 1");
  });
});
