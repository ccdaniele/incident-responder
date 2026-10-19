import { readFile } from "node:fs/promises";
import path from "node:path";
import { parse } from "yaml";
import { collectEvidence, evidenceSummary } from "./evidence/collect.js";
import { evaluateGate, type GateDecision } from "./gate/gate.js";
import { readIncidentJson, updateIncidentStatus, writeIncidentJson } from "./incidents/store.js";
import { runTriage } from "./triage/run.js";

export async function runPipeline(incidentId: string): Promise<void> {
  console.log(`[${incidentId}] evidence: started`);
  const evidence = await collectEvidence(incidentId);
  await writeIncidentJson(incidentId, "evidence.json", evidence);
  await updateIncidentStatus(incidentId, "evidence", "evidence complete");
  console.log(evidenceSummary(incidentId, evidence));

  console.log(`[${incidentId}] triage: started`);
  await runTriage(incidentId, evidence);
  await updateIncidentStatus(incidentId, "triage", "triage complete");

  console.log(`[${incidentId}] gate: started`);
  const triage = await readTriage(incidentId);
  const policy = await readPolicy();
  const decision = evaluateGate(evidence, triage, policy);
  await writeIncidentJson(incidentId, "decision.json", decision);
  logGate(incidentId, decision);
  await updateIncidentStatus(incidentId, "decided", "gate complete");
}

async function readTriage(incidentId: string): Promise<unknown> {
  try {
    return await readIncidentJson(incidentId, "triage.json");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { valid: false, error: message };
  }
}

async function readPolicy(): Promise<unknown> {
  try {
    const text = await readFile(path.resolve("policy.yaml"), "utf8");
    return parse(text);
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

function logGate(incidentId: string, decision: GateDecision): void {
  for (const check of decision.checks) {
    const mark = check.passed ? "✓" : "✗";
    console.log(`[${incidentId}] gate: ${mark} ${check.detail}`);
  }
  if (decision.decision === "allow") {
    console.log(`[${incidentId}] gate: ALLOW`);
    return;
  }
  const failed = decision.checks.find((check) => !check.passed);
  console.log(`[${incidentId}] gate: BLOCK (${failed?.rule ?? "unknown"})`);
}
