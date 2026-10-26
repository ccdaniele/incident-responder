import { runReport } from "../src/report/run.js";
import { runVerify } from "../src/verify/run.js";

process.loadEnvFile();

const incidentId = process.argv[2];
if (!incidentId) {
  console.error("Usage: npm run report -- <incident-id>");
  process.exit(1);
}

await runVerify(incidentId);
const ok = await runReport(incidentId);
if (!ok) process.exit(1);
