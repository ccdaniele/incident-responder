import { readFile } from "node:fs/promises";
import path from "node:path";

export type ServiceRecord = {
  repo: string;
  branch?: string;
};

export async function lookupService(name: string): Promise<ServiceRecord> {
  const text = await readFile(path.resolve("services.yaml"), "utf8");
  const services = parseServices(text);
  const service = services.get(name);
  if (!service) {
    throw new Error(`service ${name} is not in services.yaml`);
  }
  if (!service.repo) {
    throw new Error(`service ${name} has no repo in services.yaml`);
  }
  return service;
}

export function parseServices(text: string): Map<string, ServiceRecord> {
  const services = new Map<string, ServiceRecord>();
  let current: string | undefined;

  for (const line of text.split(/\r?\n/)) {
    if (!line.trim() || line.trimStart().startsWith("#")) continue;

    const service = /^([A-Za-z0-9_-]+):\s*$/.exec(line);
    if (service?.[1]) {
      current = service[1];
      services.set(current, { repo: "" });
      continue;
    }

    const field = /^ {2}([A-Za-z0-9_]+):\s*(\S+)\s*$/.exec(line);
    if (!field?.[1] || !field[2] || !current) {
      throw new Error(`could not parse services.yaml line: ${line}`);
    }
    const record = services.get(current);
    if (!record) {
      throw new Error(`could not parse services.yaml line: ${line}`);
    }
    if (field[1] === "repo") record.repo = field[2];
    else if (field[1] === "branch") record.branch = field[2];
  }

  return services;
}
