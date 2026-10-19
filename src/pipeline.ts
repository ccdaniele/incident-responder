import {
  updateIncidentStatus,
  writeIncidentJson,
  type IncidentStatus,
} from "./incidents/store.js";

const stages: { label: string; file: string; status: IncidentStatus }[] = [
  { label: "evidence", file: "evidence.json", status: "evidence" },
  { label: "triage", file: "triage.json", status: "triage" },
  { label: "gate", file: "decision.json", status: "decided" },
];

export async function runPipeline(incidentId: string): Promise<void> {
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
