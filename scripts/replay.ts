import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";

process.loadEnvFile();

const args = process.argv.slice(2);
const fresh = args.includes("--fresh");
const file = args.find((arg) => arg !== "--fresh");
if (!file) {
  console.error("Usage: npm run replay -- <file> [--fresh]");
  process.exit(1);
}

const token = process.env.WEBHOOK_TOKEN ?? "";
const raw = await readFile(file);
const body = fresh ? withFreshCycleKey(raw) : raw;
const response = await fetch("http://localhost:4000/alerts", {
  method: "POST",
  headers: {
    "content-type": "application/json",
    "x-webhook-token": token,
  },
  body,
});

console.log(response.status);

function withFreshCycleKey(raw: Buffer): string {
  const alert = JSON.parse(raw.toString()) as Record<string, unknown>;
  alert.cycle_key = randomUUID();
  return JSON.stringify(alert);
}
