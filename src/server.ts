import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import Fastify from "fastify";
import {
  createIncident,
  incidentExists,
  incidentIdFromCycleKey,
  updateIncidentStatus,
} from "./incidents/store.js";
import { runPipeline } from "./pipeline.js";

process.loadEnvFile();

const webhookToken = process.env.WEBHOOK_TOKEN;
if (!webhookToken) {
  throw new Error("WEBHOOK_TOKEN is not set");
}

const alertsDir = path.resolve("alerts");
const app = Fastify();

app.post("/alerts", async (request, reply) => {
  const header = request.headers["x-webhook-token"];
  if (header !== webhookToken) {
    console.warn("rejected alert: webhook token mismatch");
    return reply.code(401).send();
  }

  const body = request.body;
  const filename = `${new Date().toISOString()}.json`;
  await mkdir(alertsDir, { recursive: true });
  await writeFile(
    path.join(alertsDir, filename),
    `${JSON.stringify(body, null, 2)}\n`,
  );

  const title =
    body !== null && typeof body === "object" && "title" in body
      ? String((body as { title: unknown }).title)
      : "";
  console.log(`${title} ${filename}`);

  const alert = asRecord(body);
  const transition = alert ? stringField(alert, "transition") : undefined;
  if (transition !== "Triggered") {
    const cycleKey = alert ? stringField(alert, "cycle_key") : undefined;
    const prefix = cycleKey ? `[${incidentIdFromCycleKey(cycleKey)}] ` : "";
    console.log(`${prefix}ignored: transition ${transition ?? "missing"}`);
    return reply.code(202).send();
  }

  const cycleKey = alert ? stringField(alert, "cycle_key") : undefined;
  if (!cycleKey) {
    console.log("ignored: cycle_key missing");
    return reply.code(202).send();
  }

  const incidentId = incidentIdFromCycleKey(cycleKey);
  if (await incidentExists(incidentId)) {
    console.log(`[${incidentId}] duplicate ignored`);
    return reply.code(202).send();
  }

  await createIncident(incidentId, body);
  void runPipeline(incidentId).catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    console.log(`[${incidentId}] failed: ${message}`);
    return updateIncidentStatus(incidentId, "failed", message).catch(
      (statusError: unknown) => {
        const statusMessage =
          statusError instanceof Error ? statusError.message : String(statusError);
        console.log(`[${incidentId}] failed: ${statusMessage}`);
      },
    );
  });

  return reply.code(202).send();
});

await app.listen({ port: 4000, host: "127.0.0.1" });
console.log("listening on port 4000");

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  return value as Record<string, unknown>;
}

function stringField(
  record: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = record[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}
