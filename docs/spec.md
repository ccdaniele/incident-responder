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
- incident.json status: received → evidence → triage → decided → (fixing → verified | handed_to_human) → reported, or failed.

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
  "versions": { "bad": "afbfc00", "previous": "3910d28" },
  "commits": [{ "sha": "...", "message": "...", "author": "...", "date": "ISO" }],
  "diff": { "base": "...", "head": "...", "files": [{ "path": "...", "additions": 0, "deletions": 0, "patch": "..." }] },
  "logs": { "count": 0, "by_event": {}, "by_error_code": {}, "samples": [] },
  "impact": { "failed_requests": 0, "affected_customers": 0, "affected_merchants": 0, "amount_cents": 0 }
}
```
- versions.bad = most common `version` in the alert's matching logs;
  versions.previous = most recent different version seen before the window.
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