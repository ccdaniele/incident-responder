import { collectEvidence, evidenceSummary } from "./evidence/collect.js";
import { updateIncidentStatus, writeIncidentJson } from "./incidents/store.js";
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
  await writeIncidentJson(incidentId, "decision.json", { todo: true });
  await updateIncidentStatus(incidentId, "decided", "gate complete");
}
