import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import Fastify from "fastify";

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

  return reply.code(202).send();
});

await app.listen({ port: 4000, host: "127.0.0.1" });
console.log("listening on port 4000");
