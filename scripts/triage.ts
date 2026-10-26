import { readIncidentJson } from "../src/incidents/store.js";
import type { EvidenceBundle } from "../src/evidence/types.js";
import { runTriage } from "../src/triage/run.js";

process.loadEnvFile();

const incidentId = process.argv[2];
if (!incidentId) {
  console.error("Usage: npm run triage -- <incident-id>");
  process.exit(1);
}

const evidence = asEvidence(await readIncidentJson(incidentId, "evidence.json"));
await runTriage(incidentId, evidence);

function asEvidence(value: unknown): EvidenceBundle {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("evidence.json is not an object");
  }
  return value as EvidenceBundle;
}
