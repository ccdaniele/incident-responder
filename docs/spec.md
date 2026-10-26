# incident-responder — spec

## Incident lifecycle
- Only alerts with transition "Triggered" start an incident; others are saved and ignored.
- Incident id: `INC-` + last 6 characters of cycle_key. Same cycle_key = same
  incident (duplicates are ignored).
- POST /alerts responds 202 immediately; the pipeline runs in the background.
- Each incident lives in `incidents/<incident_id>/`:
  - alert.json — the raw alert
  - incident.json — status, timeline, agent ids, run ids
  - evidence.json — evidence bundle (stage 2)
  - triage.json — triage result (stage 3)
  - decision.json — gate decision (stage 4)
  - fix.json — fix result (stage 5), only after the gate allows a fix
  - verify.json — CI check runs (stage 6), only when a PR exists
- incident.json status: received → evidence → triage → decided → (needs_human | fixing → pr_opened | needs_human) → reported, or failed. verified and handed_to_human remain for later stages.
- incident.json keeps agent_id (set as soon as a fix agent is created, before the prompt is sent) and run_id (set as soon as the fix run starts). Status updates must keep those fields.

## services.yaml
Maps a service tag to its repository:
```yaml
paymas-checkout:
  repo: ccdaniele/paymas-checkout
  branch: main
```

## Evidence bundle (evidence.json)
```json
{
  "incident_id": "INC-323663",
  "service": "paymas-checkout",
  "repo": "ccdaniele/paymas-checkout",
  "monitor": { "id": "333686229", "title": "...", "query": "..." },
  "alert_time": "ISO",
  "window": { "from": "ISO", "to": "ISO" },
  "versions": { "bad": "afbfc00", "previous": "3910d28", "previous_source": "logs" },
  "commits": [{ "sha": "...", "message": "...", "author": "...", "date": "ISO" }],
  "diff": { "base": "...", "head": "...", "files": [{ "path": "...", "additions": 0, "deletions": 0, "patch": "..." }] },
  "logs": { "count": 0, "by_event": {}, "by_error_code": {}, "samples": [] },
  "impact": { "failed_requests": 0, "affected_customers": 0, "affected_merchants": 0, "amount_cents": 0 }
}
```
- versions.bad = most common `version` in the alert's matching logs.
- versions.previous = the most recent different version in logs over the 7 days
  before the window (`service:<name> -version:<bad>`). If none is found, the
  short sha of the first parent of `<bad>`
  (`GET /repos/<repo>/commits/<bad>`). versions.previous_source is `logs` or
  `git_parent`. The stage fails only when both are unavailable.
- If compare of a log-derived previous returns 404, retry once with that first
  parent. versions.previous becomes the parent short sha, and
  versions.previous_source is
  `git_parent (log version <sha> not found on GitHub)`.
- GitHub errors include the base and head shas.
- Window = 15 minutes before the alert time until the alert time.
- samples: at most 20 masked log lines.
- Masking: customer_id "V-14582093" → "V-XXXX2093"; customer_name → "[name]".

## Triage result (triage.json)
```json
{
  "root_cause": "one or two sentences",
  "suspect_commit": "sha from evidence.commits",
  "suspect_files": ["src/..."],
  "evidence": ["short facts that support the root cause"],
  "affected_area": "checkout | collections | credit | other",
  "confidence": 0.0,
  "proposed_fix": "one or two sentences, no code"
}
```
Plus metadata added by code: agent_id, run_id, request_id, duration_ms, usage.

## policy.yaml
```yaml
min_confidence: 0.8
max_changed_files: 3
protected_paths: [src/credit/, src/collections/, .cursor/]
protected_services: []
```

## Gate decision (decision.json)
```json
{ "decision": "allow | block", "checks": [{ "rule": "...", "passed": true, "detail": "..." }] }
```
Checks, all must pass to allow:
1. triage output is valid against the schema
2. suspect_commit is one of evidence.commits
3. every suspect_file appears in evidence.diff.files
4. confidence >= min_confidence
5. files changed in the real diff <= max_changed_files
6. no file in the real diff is under a protected path
7. service is not in protected_services
Any missing input or error → block.

## Fix result (fix.json)
Written only after the gate allows a fix and a cloud run has been sent.
A blocked gate writes no fix.json; incident status becomes `needs_human` and the fix stage stops. The report stage still runs.
```json
{
  "agent_id": "bc-...",
  "run_id": "run-...",
  "status": "finished",
  "pr_url": "https://github.com/ccdaniele/paymas-checkout/pull/1",
  "branch": "cursor/fix-...",
  "duration_ms": 74000,
  "cost_usd": 0.42
}
```
- `status` is the run status: `finished`, `error`, or `cancelled`.
- `pr_url` and `branch` come from the run's git metadata. Both are null when no pull request was opened. `run_id` is null when the run never started.
- `duration_ms` is the run duration.
- `cost_usd` is the charged dollar cost from `agent.getUsage()` for that run. Cost can lag the run, so the stage retries for about 30 seconds. Null when cost is still unavailable. `0` is a real charge (plan-included or credit usage), not a missing value.
- Incident status becomes `pr_opened` only when the run status is `finished` and `pr_url` is present. A timeout (15 minutes, then cancel), any other run status, or a finished run with no pull request URL sets `needs_human`.
- The cloud agent is `composer-2.5`, started from the service branch in services.yaml, with `autoCreatePR` and metadata `incident_id` and `service`.

## CI verification (verify.json)
Written after the fix stage when `fix.json` has a `pr_url`. Skipped otherwise.
Polls GitHub check runs on the PR head commit every 15 seconds for up to 10
minutes, until every check run has completed. An empty list keeps polling
(CI may not have started). Timeout does not fail the pipeline.
```json
{
  "head_sha": "d416cbcae4a5afb456ad245d38c5c0bf66bdb2c1",
  "timed_out": false,
  "checks": [
    { "name": "test", "conclusion": "success" },
    { "name": "regression-proof", "conclusion": "success" }
  ]
}
```
- `name` and `conclusion` come from each check run. `conclusion` is null when
  a check has not finished (timeout).
- `npm run report -- <incident-id>` re-runs this stage, then rebuilds the
  report. No agents.

## Incident report (runs/<incident_id>/report.md)
Written after the gate (and the fix and verify stages when they ran). Always saved to
`runs/<incident_id>/report.md`. Markdown includes: incident id, alert title and
time, timeline (alert received, evidence gathered, triage done, gate decision,
fix agent finished), suspect commit and changed files, triage summary and
confidence, gate decision with each check marked pass or fail, fix agent id /
run id / duration / cost when available, CI verification (each check marked
✓ or ✗, plus “Regression test fails on main and passes on the fix” when both
the regression-proof and test jobs succeeded, or “CI still running” on
timeout), and customer impact. PII is masked the same way as evidence
(customer ids and names).

Posting:
- Gate ALLOWED and a PR exists: comment on that PR. PR number comes from
  `fix.json` `pr_url`.
- Gate BLOCKED: create an issue in `ccdaniele/paymas-checkout` titled
  `[Incident <id>] <alert title> — needs human review`, with labels `incident`
  and `needs-human` (created if missing). The body is the report plus a
  “Why it was blocked” section listing the failed checks.

If building the report fails, log the error and do not post.
Rebuild from saved run data with `npm run report -- <incident-id>` (re-runs CI
verification when a PR exists; no agents).