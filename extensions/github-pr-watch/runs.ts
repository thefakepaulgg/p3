export type Exec = (command: string, args: string[], options?: { timeout?: number }) => Promise<{ code: number; stdout: string; stderr: string }>;

export interface RunSnapshot {
  attempt: number;
  status: string;
  conclusion?: string;
  jobs: Record<string, string>;
  waiting: string[];
  release?: string;
}

export interface RunSubscription {
  repository: string;
  /** Unset while a ref+workflow subscription waits for its run to appear. */
  runId?: number;
  subscribedAt?: number;
  name: string;
  url: string;
  ref?: string;
  workflow?: string;
  release?: boolean;
  snapshot?: RunSnapshot;
}

interface WorkflowRun {
  id: number;
  name: string;
  html_url: string;
  status: string;
  conclusion: string | null;
  run_attempt: number;
  head_branch: string | null;
  created_at?: string;
  run_started_at?: string;
  updated_at: string;
}

interface Step { name: string; status: string; conclusion: string | null }
interface Job { id: number; name: string; status: string; conclusion: string | null; html_url: string; steps?: Step[] }
interface Release { tag_name: string; name: string | null; draft: boolean; prerelease: boolean; assets: unknown[]; html_url: string }

export interface RunData {
  run: WorkflowRun;
  jobs: Job[];
  waiting: string[];
  release?: Release;
}

export type RunChanges = { wake: string[]; routine: string[] };

const FAILED = ["failure", "timed_out", "startup_failure", "action_required"];
const quote = (value: string) => JSON.stringify(value);

/** How long a ref+workflow subscription waits for GitHub to create its run. */
export const RUN_APPEAR_TIMEOUT_MS = 30 * 60_000;
/** Tolerance for clock skew between this machine and GitHub when matching a newly created run. */
const CLOCK_SKEW_MS = 2 * 60_000;

export const runKey = ({ repository, runId, ref, workflow }: Pick<RunSubscription, "repository" | "runId" | "ref" | "workflow">) =>
  runId ? `${repository.toLowerCase()} run ${runId}` : `${repository.toLowerCase()} ${workflow}@${ref}`;

/** Baseline for a run first seen after subscribing, so its current approval waits, failures and completion are reported. */
export const emptySnapshot = (attempt: number): RunSnapshot => ({ attempt, status: "queued", jobs: {}, waiting: [] });

async function ghJson<T>(exec: Exec, path: string): Promise<T> {
  const result = await exec("gh", ["api", path], { timeout: 30_000 });
  if (result.code !== 0) throw new Error(result.stderr.trim() || `gh api ${path} failed`);
  return JSON.parse(result.stdout) as T;
}

/** Newest run of the workflow for the ref, optionally only one created at or after a time. */
export async function resolveRunId(exec: Exec, repository: string, ref: string, workflow: string, createdAfter?: number): Promise<number | undefined> {
  const response = await ghJson<{ workflow_runs: WorkflowRun[] }>(exec,
    `repos/${repository}/actions/workflows/${encodeURIComponent(workflow)}/runs?branch=${encodeURIComponent(ref)}&per_page=1`);
  const run = response.workflow_runs[0];
  if (!run) return;
  if (createdAfter !== undefined && Date.parse(run.created_at ?? "") < createdAfter - CLOCK_SKEW_MS) return;
  return run.id;
}

export async function fetchRun(exec: Exec, subscription: { repository: string; runId: number; release?: boolean }): Promise<RunData> {
  const base = `repos/${subscription.repository}/actions/runs/${subscription.runId}`;
  const run = await ghJson<WorkflowRun>(exec, base);
  const { jobs } = await ghJson<{ jobs: Job[] }>(exec, `${base}/jobs?filter=latest&per_page=100`);
  const waiting = run.status === "waiting"
    ? (await ghJson<Array<{ environment: { name: string } }>>(exec, `${base}/pending_deployments`)).map((deployment) => deployment.environment.name)
    : [];
  const release = subscription.release && run.head_branch
    ? (await ghJson<Release[]>(exec, `repos/${subscription.repository}/releases?per_page=30`)).find((candidate) => candidate.tag_name === run.head_branch)
    : undefined;
  return { run, jobs, waiting, release };
}

export function snapshotOfRun(data: RunData): RunSnapshot {
  return {
    attempt: data.run.run_attempt,
    status: data.run.status,
    conclusion: data.run.conclusion ?? undefined,
    jobs: Object.fromEntries(data.jobs.map((job) => [String(job.id), `${job.status}/${job.conclusion ?? ""}`])),
    waiting: [...data.waiting].sort(),
    release: data.release ? `${data.release.draft}:${data.release.prerelease}:${data.release.assets.length}` : undefined,
  };
}

export function formatDuration(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  return [hours ? `${hours}h` : "", hours || minutes ? `${minutes}m` : "", `${seconds % 60}s`].filter(Boolean).join(" ");
}

const describeRelease = (release: Release) =>
  `${quote(release.name ?? release.tag_name)} (${release.draft ? "draft" : "published"}${release.prerelease ? ", prerelease" : ""}, ${release.assets.length} asset${release.assets.length === 1 ? "" : "s"})\n${release.html_url}`;

const approvalLine = (environments: string[], url: string) =>
  `Waiting for deployment approval: ${environments.map(quote).join(", ")}. A human must approve it at ${url}`;

function jobFailure(job: Job): string {
  const step = job.steps?.find((candidate) => candidate.conclusion && FAILED.includes(candidate.conclusion));
  return `Job ${quote(job.name)} ${job.conclusion}${step ? ` at step ${quote(step.name)}` : ""}\n${job.html_url}`;
}

export function completionReport(data: RunData, release: boolean | undefined): string {
  const { run } = data;
  const started = Date.parse(run.run_started_at ?? run.updated_at);
  const failed = data.jobs.filter((job) => job.conclusion && FAILED.includes(job.conclusion));
  return [
    `Run completed: ${run.conclusion ?? "unknown"} in ${formatDuration(Date.parse(run.updated_at) - started)} (attempt ${run.run_attempt})`,
    ...failed.map(jobFailure),
    ...(release ? [data.release ? `Release ${describeRelease(data.release)}` : `No GitHub Release for ${quote(run.head_branch ?? "")} yet`] : []),
  ].join("\n");
}

/** Current state for a new subscription, including any approval it is already waiting on. */
export function summarizeRun(data: RunData, release: boolean | undefined): string {
  if (data.run.status === "completed") return completionReport(data, release);
  const done = data.jobs.filter((job) => job.status === "completed").length;
  const lines = [`Status ${data.run.status}, attempt ${data.run.run_attempt}; ${done}/${data.jobs.length} jobs finished`];
  if (data.waiting.length) lines.push(approvalLine(data.waiting, data.run.html_url));
  lines.push(...data.jobs.filter((job) => job.conclusion && FAILED.includes(job.conclusion)).map(jobFailure));
  if (release && data.release) lines.push(`Release ${describeRelease(data.release)}`);
  return lines.join("\n");
}

export function describeRunChanges(previous: RunSnapshot, data: RunData, release: boolean | undefined): RunChanges {
  const wake: string[] = [];
  const routine: string[] = [];
  const { run } = data;

  if (run.run_attempt !== previous.attempt) {
    wake.push(`Attempt ${previous.attempt} ended and re-run attempt ${run.run_attempt} started`);
  }
  const newlyWaiting = data.waiting.filter((environment) => !previous.waiting.includes(environment));
  if (newlyWaiting.length) wake.push(approvalLine(newlyWaiting, run.html_url));

  for (const job of data.jobs) {
    const value = `${job.status}/${job.conclusion ?? ""}`;
    if (job.status !== "completed" || previous.jobs[String(job.id)] === value) continue;
    if (job.conclusion && FAILED.includes(job.conclusion)) {
      if (run.status !== "completed") wake.push(jobFailure(job));
    }
    else routine.push(`job ${quote(job.name)} ${job.conclusion === "success" ? "succeeded" : job.conclusion ?? "finished"}`);
  }

  const releaseState = snapshotOfRun(data).release;
  if (release && data.release && releaseState !== previous.release) {
    const verb = !previous.release ? "created" : previous.release.startsWith("true:") && !data.release.draft ? "published" : "updated";
    routine.push(`release ${verb}: ${describeRelease(data.release)}`);
  }

  if (run.status === "completed") wake.push(completionReport(data, release));
  return { wake, routine };
}

/** Append routine events to this run's held summary line. */
export function queueRunRoutine(pending: string[], key: string, events: string[]): string[] {
  const prefix = `${key}: `;
  const older = pending.find((line) => line.startsWith(prefix));
  const next = pending.filter((line) => line !== older);
  next.push(`${prefix}${[...(older ? [older.slice(prefix.length)] : []), ...events].join("; ")}`);
  return next;
}

/** Remove this run's held routine line and return its events, so a wake message keeps them in order. */
export function takeRunRoutine(pending: string[], key: string): { pending: string[]; held: string[] } {
  const prefix = `${key}: `;
  const older = pending.find((line) => line.startsWith(prefix));
  return { pending: pending.filter((line) => line !== older), held: older ? [older.slice(prefix.length)] : [] };
}
