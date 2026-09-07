import { spawn } from "child_process";
import { PRIMARY_ACCOUNT, SESSION_DURATION_MS } from "./config";
import type { Account } from "./config";
import { insertSession } from "./db";
import type { WarmupResult, Session } from "./types";

export function parseWarmupOutput(
  stdout: string,
  account = PRIMARY_ACCOUNT.name
): {
  warmupResult: WarmupResult;
  sessionArgs: Parameters<typeof insertSession>;
} {
  const json = JSON.parse(stdout);
  if (json.is_error || json.api_error_status) {
    const error =
      typeof json.result === "string" && json.result.trim()
        ? json.result
        : `Claude API error${json.api_error_status ? ` ${json.api_error_status}` : ""}`;
    throw new Error(error);
  }

  const now = new Date();
  const expiresAt = new Date(now.getTime() + SESSION_DURATION_MS);

  return {
    warmupResult: {
      success: true,
      session_id: json.session_id,
      usage: json.usage,
      cost_usd: json.total_cost_usd,
    },
    sessionArgs: [
      account,
      json.session_id ?? "unknown",
      now.toISOString(),
      expiresAt.toISOString(),
      json.usage?.input_tokens ?? 0,
      json.usage?.output_tokens ?? 0,
      json.usage?.cache_creation_input_tokens ?? 0,
      json.usage?.cache_read_input_tokens ?? 0,
      json.total_cost_usd ?? 0,
    ],
  };
}

export function formatWarmupError(
  stdout: string,
  stderr: string,
  code: number | null
): string {
  const stderrText = stderr.trim();
  if (stderrText) return stderrText;

  const stdoutText = stdout.trim();
  if (stdoutText) {
    try {
      const json = JSON.parse(stdoutText);
      if (typeof json.result === "string" && json.result.trim()) {
        return json.result;
      }
      if (json.api_error_status) {
        return `Claude API error ${json.api_error_status}`;
      }
    } catch {
      return stdoutText.slice(0, 1000);
    }
  }

  return `exit code ${code ?? "unknown"}`;
}

/**
 * Runs a warmup for one account. Accounts are isolated by giving the child its
 * own CLAUDE_CONFIG_DIR; an account without one (the single-account default)
 * inherits the ambient environment unchanged.
 */
export function warmup(
  account: Account = PRIMARY_ACCOUNT
): Promise<{ result: WarmupResult; session?: Session }> {
  return new Promise((resolve) => {
    const proc = spawn("claude", ["-p", "ready", "--output-format", "json"], {
      timeout: 60_000,
      stdio: ["ignore", "pipe", "pipe"],
      env: account.configDir
        ? { ...process.env, CLAUDE_CONFIG_DIR: account.configDir }
        : process.env,
    });

    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (d: Buffer) => (stdout += d.toString()));
    proc.stderr.on("data", (d: Buffer) => (stderr += d.toString()));

    proc.on("close", (code) => {
      if (code !== 0) {
        resolve({
          result: { success: false, error: formatWarmupError(stdout, stderr, code) },
        });
        return;
      }

      try {
        const { warmupResult, sessionArgs } = parseWarmupOutput(stdout, account.name);
        const session = insertSession(...sessionArgs);
        resolve({ result: warmupResult, session });
      } catch (err) {
        resolve({
          result: {
            success: false,
            error: err instanceof Error ? err.message : `Failed to parse output: ${stdout}`,
          },
        });
      }
    });

    proc.on("error", (err) => {
      resolve({ result: { success: false, error: err.message } });
    });
  });
}
