import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  incidentExists,
  readIncidentJson,
  updateIncidentStatus,
} from "../incidents/store.js";
import { buildReport, type BuiltReport, type IncidentArtifacts } from "./build.js";
import { createBlockedIssue, postPullRequestComment } from "./github.js";

export async function runReport(incidentId: string): Promise<boolean> {
  console.log(`[${incidentId}] report: started`);
  try {
    if (!(await incidentExists(incidentId))) {
      throw new Error(`incident ${incidentId} not found`);
    }
    const report = buildReport(await loadArtifacts(incidentId));
    await saveReport(incidentId, report.markdown);
    const posted = await postReport(report);
    await updateIncidentStatus(incidentId, "reported", posted);
    console.log(`[${incidentId}] report: ${posted}`);
    return true;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.log(`[${incidentId}] report: failed: ${message}`);
    return false;
  }
}

async function loadArtifacts(incidentId: string): Promise<IncidentArtifacts> {
  return {
    incidentId,
    alert: await readOptional(incidentId, "alert.json"),
    incident: await readOptional(incidentId, "incident.json"),
    evidence: await readOptional(incidentId, "evidence.json"),
    triage: await readOptional(incidentId, "triage.json"),
    decision: await readOptional(incidentId, "decision.json"),
    fix: await readOptional(incidentId, "fix.json"),
  };
}

async function readOptional(incidentId: string, filename: string): Promise<unknown | undefined> {
  try {
    return await readIncidentJson(incidentId, filename);
  } catch {
    return undefined;
  }
}

async function saveReport(incidentId: string, markdown: string): Promise<void> {
  const dir = path.resolve("runs", incidentId);
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, "report.md"), markdown.endsWith("\n") ? markdown : `${markdown}\n`);
}

async function postReport(report: BuiltReport): Promise<string> {
  const dest = report.destination;
  if (dest.kind === "pr_comment") {
    const url = await postPullRequestComment(
      dest.owner,
      dest.repo,
      dest.number,
      report.markdown,
    );
    return `commented on PR #${dest.number} ${url}`;
  }
  if (dest.kind === "issue") {
    const url = await createBlockedIssue(
      dest.owner,
      dest.repo,
      dest.title,
      report.markdown,
    );
    return `opened issue ${url}`;
  }
  return "saved, no GitHub post";
}
