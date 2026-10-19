import { execFile } from "node:child_process";
import { mkdir, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export async function prepareWorkspace(
  incidentId: string,
  repo: string,
  sha: string,
): Promise<string> {
  const token = process.env.GITHUB_TOKEN;
  if (!token) throw new Error("GITHUB_TOKEN is not set");
  if (!/^INC-[A-Za-z0-9]+$/.test(incidentId)) {
    throw new Error(`invalid incident id: ${incidentId}`);
  }
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo)) {
    throw new Error(`invalid repo: ${repo}`);
  }
  if (!/^[0-9a-f]{7,40}$/i.test(sha)) {
    throw new Error(`invalid version: ${sha}`);
  }

  const dest = path.resolve("workspaces", incidentId);
  const plain = `https://github.com/${repo}.git`;
  await rm(dest, { recursive: true, force: true });
  await mkdir(path.dirname(dest), { recursive: true });

  try {
    await git(
      [
        "clone",
        "--quiet",
        `https://x-access-token:${encodeURIComponent(token)}@github.com/${repo}.git`,
        dest,
      ],
      token,
    );
  } catch (error) {
    await rm(dest, { recursive: true, force: true });
    throw error;
  }

  try {
    await git(["checkout", "--quiet", sha], token, dest);
  } finally {
    await git(["remote", "set-url", "origin", plain], token, dest);
    await assertTokenRemoved(dest, token);
  }

  return dest;
}

async function git(
  args: string[],
  token: string,
  cwd?: string,
): Promise<void> {
  try {
    await execFileAsync("git", args, {
      cwd,
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    });
  } catch (error) {
    const command = args[0] ?? "git";
    const detail = redact(stderrOf(error), token).trim();
    throw new Error(detail ? `git ${command} failed: ${detail}` : `git ${command} failed`);
  }
}

async function assertTokenRemoved(dest: string, token: string): Promise<void> {
  const configPath = path.join(dest, ".git", "config");
  const config = await readFile(configPath, "utf8");
  const encoded = encodeURIComponent(token);
  if (config.includes(token) || (encoded !== token && config.includes(encoded))) {
    await rm(dest, { recursive: true, force: true });
    throw new Error("git config still contained the GitHub token");
  }
}

function stderrOf(error: unknown): string {
  if (error !== null && typeof error === "object" && "stderr" in error) {
    return String(error.stderr ?? "");
  }
  return "";
}

function redact(message: string, token: string): string {
  const encoded = encodeURIComponent(token);
  return message.split(token).join("[redacted]").split(encoded).join("[redacted]");
}
