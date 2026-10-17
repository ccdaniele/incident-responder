import { readFile } from "node:fs/promises";

process.loadEnvFile();

const file = process.argv[2];
if (!file) {
  console.error("Usage: npm run replay -- <file>");
  process.exit(1);
}

const token = process.env.WEBHOOK_TOKEN ?? "";
const body = await readFile(file);
const response = await fetch("http://localhost:4000/alerts", {
  method: "POST",
  headers: {
    "content-type": "application/json",
    "x-webhook-token": token,
  },
  body,
});

console.log(response.status);
