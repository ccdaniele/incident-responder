export type EvidenceCommit = {
  sha: string;
  message: string;
  author: string;
  date: string;
};

export type EvidenceFile = {
  path: string;
  additions: number;
  deletions: number;
  patch: string;
};

export type LogSample = {
  time: string;
  event: string | null;
  error_code: string | null;
  route: string | null;
  plan: string | null;
  amount_cents: number | null;
  customer_id: string | null;
  customer_name: string | null;
  merchant_id: string | null;
  version: string | null;
};

export type EvidenceBundle = {
  incident_id: string;
  service: string;
  repo: string;
  monitor: { id: string; title: string; query: string };
  alert_time: string;
  window: { from: string; to: string };
  versions: {
    bad: string;
    previous: string;
    previous_source: string;
  };
  commits: EvidenceCommit[];
  diff: { base: string; head: string; files: EvidenceFile[] };
  logs: {
    count: number;
    by_event: Record<string, number>;
    by_error_code: Record<string, number>;
    samples: LogSample[];
  };
  impact: {
    failed_requests: number;
    affected_customers: number;
    affected_merchants: number;
    amount_cents: number;
  };
};
