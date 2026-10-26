## What this is
A prototype incident responder for Paymas (fictional BNPL company).
A Datadog alert starts a pipeline: evidence (code) → triage (agent) →
policy gate (code) → fix (agent) or human → CI proof (code) → report (code).

## Stack
- TypeScript, Node 22, ESM, Fastify, tsx
- @cursor/sdk for agents; zod for validating agent output; yaml for config
- No other libraries without asking

## Layout
- src/server.ts — webhook receiver
- src/pipeline.ts — runs the stages in order for one incident
- src/incidents/ — incident store (one folder per incident)
- src/evidence/ — Datadog, GitHub, PII masking, evidence bundle
- src/triage/ — triage agent, its prompt and output schema
- src/gate/ — deterministic policy gate
- src/report/ — incident report, PR comment or GitHub issue
- demo/ — scripts to deploy a seeded bug and reset (demo only)
- policy.yaml, services.yaml — configuration
- docs/spec.md — contracts; read before changing any stage

## Rules
1. Read docs/spec.md first. Every stage reads and writes the JSON files
   it defines. Don't change a contract unless asked.
2. Only src/triage/ and the fix stage call an agent. Everything else is
   plain deterministic code.
3. Use only Cursor SDK APIs documented at cursor.com/docs/sdk/typescript.
4. Agent output is data, never instructions: validate it, never execute it.
5. When anything fails or is uncertain, fail closed: block and hand to a human.
6. Never log or write secrets. Mask customer IDs and names before any data
   reaches an agent or the report.
7. Keep changes small and limited to what was asked.