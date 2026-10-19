import { collectEvidence, evidenceSummary } from "./evidence/collect.js";
import {
  updateIncidentStatus,
  writeIncidentJson,
  type IncidentStatus,
} from "./incidents/store.js";

const stages: { label: string; file: string; status: IncidentStatus }[] = [
  { label: "triage", file: "triage.json", status: "triage" },
  { label: "gate", file: "decision.json", status: "decided" },
];

export async function runPipeline(incidentId: string): Promise<void> {
  console.log(`[${incidentId}] evidence: started`);
  const evidence = await collectEvidence(incidentId);
  await writeIncidentJson(incidentId, "evidence.json", evidence);
  await updateIncidentStatus(incidentId, "evidence", "evidence complete");
  console.log(evidenceSummary(incidentId, evidence));

  for (const stage of stages) {
    console.log(`[${incidentId}] ${stage.label}: started`);
    await writeIncidentJson(incidentId, stage.file, { todo: true });
    await updateIncidentStatus(
      incidentId,
      stage.status,
      `${stage.label} complete`,
    );
  }
}
