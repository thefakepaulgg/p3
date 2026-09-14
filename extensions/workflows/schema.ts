import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { routes, type RouteName } from "../routing/policy.ts";
import type { RoutedWorkerCapability } from "../routing/herdr.ts";
import type { TaskPhase } from "../routing/workflow.ts";


const parseYaml: (content: string) => unknown = (() => {
  const anchors = [__filename, process.argv[1], join(homedir(), ".pi", "agent", "npm", "package.json")].filter((value): value is string => !!value);
  let lastError: unknown;
  for (const anchor of anchors) {
    try { return (createRequire(anchor)("yaml") as { parse: (content: string) => unknown }).parse; }
    catch (error) { lastError = error; }
  }
  throw new Error(`Workflow YAML parser is unavailable: ${lastError instanceof Error ? lastError.message : String(lastError)}`);
})();

export const WORKFLOW_VERSION = "pi-workflow/v1" as const;
export const MAX_WORKFLOWS = 64;
export const MAX_STEPS = 32;
export const MAX_INPUTS = 32;
export const MAX_ID_LENGTH = 96;
export const MAX_TEXT_LENGTH = 24_000;
export const MAX_PROMPT_LENGTH = 20_000;

export type InputDefinition = { type: "string"; required: boolean; default?: string };
export type WorkflowDefaults = { retry: number };
export type WorkflowContextRef = `inputs.${string}` | `steps.${string}.output`;

export interface WorkflowStep {
  id: string;
  name: string;
  route: RouteName;
  phase: TaskPhase;
  capabilities: RoutedWorkerCapability[];
  needs: string[];
  prompt: string;
  context: WorkflowContextRef[];
  approvalAfter: boolean;
  approvalMessage?: string;
  completionRequire: string[];
  ownershipPaths: string[];
  trackGit: boolean;
}

export interface WorkflowDefinition {
  version: typeof WORKFLOW_VERSION;
  id: string;
  name: string;
  description: string;
  inputs: Record<string, InputDefinition>;
  defaults: WorkflowDefaults;
  steps: WorkflowStep[];
}

export interface LoadedWorkflow extends WorkflowDefinition {
  sourcePath: string;
  hash: string;
}

export interface WorkflowDiagnostic {
  sourcePath?: string;
  id?: string;
  level: "error" | "warning";
  message: string;
}

export interface WorkflowLoadResult {
  workflows: LoadedWorkflow[];
  diagnostics: WorkflowDiagnostic[];
  files: string[];
}

const routesSet = new Set<string>(Object.keys(routes));
const phases = new Set<TaskPhase>(["plan", "implement", "review", "other"]);
const gates = new Set(["routed-task-completed", "output-nonempty"]);
const capabilities = new Set<RoutedWorkerCapability>(["memory"]);

const fail = (message: string): never => { throw new Error(message); };
const object = (value: unknown, label: string): Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(`${label} must be an object`);
  return value as Record<string, unknown>;
};
const text = (value: unknown, label: string, max = MAX_TEXT_LENGTH): string => {
  if (typeof value !== "string" || !value.trim()) fail(`${label} must be a non-empty string`);
  const result = (value as string).trim();
  if (result.length > max) fail(`${label} exceeds the ${max} character limit`);
  return result;
};
const id = (value: unknown, label: string): string => {
  const result = text(value, label, MAX_ID_LENGTH);
  if (!/^[A-Za-z][A-Za-z0-9_-]*$/.test(result)) fail(`${label} must match /^[A-Za-z][A-Za-z0-9_-]*$/`);
  return result;
};
const list = (value: unknown, label: string, max: number): string[] => {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > max) fail(`${label} must be an array of at most ${max} items`);
  const values = value as unknown[];
  return values.map((item, index) => text(item, `${label}[${index}]`, MAX_TEXT_LENGTH));
};

function parseInputs(value: unknown): Record<string, InputDefinition> {
  const raw = object(value ?? { goal: { type: "string", required: true } }, "inputs");
  const names = Object.keys(raw).sort();
  if (!names.length || names.length > MAX_INPUTS) fail(`inputs must contain between 1 and ${MAX_INPUTS} entries`);
  const result: Record<string, InputDefinition> = {};
  for (const name of names) {
    const inputId = id(name, "input name");
    const spec = raw[name];
    if (typeof spec === "string") {
      if (spec !== "string") fail(`inputs.${name}.type must be string`);
      result[inputId] = { type: "string", required: true };
      continue;
    }
    const item = object(spec, `inputs.${name}`);
    if (item.type !== undefined && item.type !== "string") fail(`inputs.${name}.type must be string`);
    const requiredValue = item.required;
    if (requiredValue !== undefined && typeof requiredValue !== "boolean") fail(`inputs.${name}.required must be boolean`);
    const required = requiredValue === undefined ? true : requiredValue as boolean;
    const valueDefault = item.default;
    if (valueDefault !== undefined && typeof valueDefault !== "string") fail(`inputs.${name}.default must be a string`);
    if (required && valueDefault !== undefined) fail(`inputs.${name} cannot be required and have a default`);
    const defaultValue = valueDefault === undefined ? undefined : valueDefault as string;
    result[inputId] = { type: "string", required, ...(defaultValue === undefined ? {} : { default: defaultValue }) };
  }
  if (!result.goal || result.goal.type !== "string" || !result.goal.required) fail("inputs.goal is required and must be a required string");
  return result;
}

function parseContext(value: unknown, label: string): WorkflowContextRef[] {
  if (value === undefined) return [];
  if (Array.isArray(value)) return value.map((ref, index) => normalizeRef(ref, `${label}[${index}]`));
  const item = object(value, label);
  const refs: WorkflowContextRef[] = [];
  for (const input of list(item.inputs, `${label}.inputs`, MAX_INPUTS)) refs.push(normalizeRef(`inputs.${input}`, `${label}.inputs`));
  for (const step of list(item.steps, `${label}.steps`, MAX_STEPS)) refs.push(normalizeRef(`steps.${step}.output`, `${label}.steps`));
  return [...new Set(refs)];
}

function normalizeRef(value: unknown, label: string): WorkflowContextRef {
  const ref = text(value, label, 160).replace(/^\$\{/, "").replace(/\}\}$/, "").replace(/^\{\{\s*/, "").replace(/\s*\}\}$/, "");
  if (/^inputs\.[A-Za-z][A-Za-z0-9_-]*$/.test(ref)) return ref as WorkflowContextRef;
  if (/^steps\.[A-Za-z][A-Za-z0-9_-]*\.output$/.test(ref)) return ref as WorkflowContextRef;
  return fail(`${label} must reference inputs.<id> or steps.<id>.output`);
}

function promptRefs(prompt: string): WorkflowContextRef[] {
  const refs: WorkflowContextRef[] = [];
  const pattern = /(?:\{\{|\$\{)\s*((?:inputs\.[A-Za-z][A-Za-z0-9_-]*)|(?:steps\.[A-Za-z][A-Za-z0-9_-]*\.output))\s*\}\}?/g;
  for (const match of prompt.matchAll(pattern)) refs.push(normalizeRef(match[1], "prompt context reference"));
  return [...new Set(refs)];
}

function parseStep(value: unknown, index: number, _defaults: WorkflowDefaults): WorkflowStep {
  const raw = object(value, `steps[${index}]`);
  if (raw.surface !== undefined) fail(`steps[${index}].surface is no longer supported; workflow workers always run in Herdr`);
  if (raw.isolation !== undefined) fail(`steps[${index}].isolation is no longer supported; supply an existing worktree as cwd`);
  const stepId = id(raw.id, `steps[${index}].id`);
  const stepName = text(raw.name ?? raw.id, `steps[${index}].name`, 80);
  const route = text(raw.route, `steps[${index}].route`, 64) as RouteName;
  if (!routesSet.has(route)) fail(`steps[${index}].route ${route} is unknown`);
  const phase = text(raw.phase, `steps[${index}].phase`, 32) as TaskPhase;
  if (!phases.has(phase)) fail(`steps[${index}].phase ${phase} is unknown`);
  const stepCapabilities = list(raw.capabilities, `steps[${index}].capabilities`, capabilities.size) as RoutedWorkerCapability[];
  for (const capability of stepCapabilities) if (!capabilities.has(capability)) fail(`steps[${index}].capabilities ${capability} is unknown`);
  const needs = list(raw.needs, `steps[${index}].needs`, MAX_STEPS);
  const prompt = text(raw.prompt, `steps[${index}].prompt`, MAX_PROMPT_LENGTH);
  const context = [...new Set([...parseContext(raw.context, `steps[${index}].context`), ...promptRefs(prompt)])];
  const approvalRaw = raw.approval && typeof raw.approval === "object" && !Array.isArray(raw.approval)
    ? object(raw.approval, `steps[${index}].approval`) : undefined;
  const approvalValue = approvalRaw?.after;
  if (approvalValue !== undefined && typeof approvalValue !== "boolean") fail(`steps[${index}].approval.after must be boolean`);
  const approvalAfter = approvalValue === undefined ? false : approvalValue as boolean;
  const approvalMessageValue = approvalRaw?.message;
  if (approvalMessageValue !== undefined && typeof approvalMessageValue !== "string") fail(`steps[${index}].approval.message must be a string`);
  const approvalMessage = approvalMessageValue === undefined ? undefined : text(approvalMessageValue, `steps[${index}].approval.message`, 600);
  if (approvalMessage !== undefined && !approvalAfter) fail(`steps[${index}].approval.message requires approval.after: true`);
  const completionRaw = raw.completion && typeof raw.completion === "object" && !Array.isArray(raw.completion)
    ? object(raw.completion, `steps[${index}].completion`).require : undefined;
  const completionRequire = completionRaw === undefined ? ["routed-task-completed", "output-nonempty"] : list(completionRaw, `steps[${index}].completion.require`, 4);
  for (const gate of completionRequire) if (!gates.has(gate)) fail(`steps[${index}].completion.require ${gate} is not a built-in gate`);
  const ownership = raw.ownership && typeof raw.ownership === "object" && !Array.isArray(raw.ownership)
    ? object(raw.ownership, `steps[${index}].ownership`) : {};
  const sideEffects = raw.sideEffects && typeof raw.sideEffects === "object" && !Array.isArray(raw.sideEffects)
    ? object(raw.sideEffects, `steps[${index}].sideEffects`) : {};
  const trackGitValue = sideEffects.trackGit;
  if (trackGitValue !== undefined && typeof trackGitValue !== "boolean") fail(`steps[${index}].sideEffects.trackGit must be boolean`);
  const trackGit = trackGitValue === undefined ? false : trackGitValue as boolean;
  return {
    id: stepId, name: stepName, route, phase, capabilities: [...new Set(stepCapabilities)], needs: [...new Set(needs)], prompt, context, approvalAfter, ...(approvalMessage === undefined ? {} : { approvalMessage }),
    completionRequire: [...new Set(completionRequire)], ownershipPaths: list(ownership.paths, `steps[${index}].ownership.paths`, 32), trackGit,
  };
}

function validateGraph(steps: WorkflowStep[], inputs: Record<string, InputDefinition>): void {
  const byId = new Map<string, WorkflowStep>();
  for (const step of steps) {
    if (byId.has(step.id)) fail(`duplicate step id ${step.id}`);
    byId.set(step.id, step);
  }
  for (const step of steps) {
    for (const need of step.needs) if (!byId.has(need)) fail(`step ${step.id} depends on unknown step ${need}`);
    for (const ref of step.context) {
      if (ref.startsWith("inputs.")) {
        const inputName = ref.slice("inputs.".length);
        if (!Object.prototype.hasOwnProperty.call(inputs, inputName)) fail(`step ${step.id} context reference ${ref} refers to an unknown input`);
        continue;
      }
      const dependency = ref.slice("steps.".length, -".output".length);
      if (!step.needs.includes(dependency)) fail(`step ${step.id} context reference ${ref} must refer to a dependency`);
    }
  }
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (stepId: string) => {
    if (visiting.has(stepId)) fail(`workflow dependency graph contains a cycle at ${stepId}`);
    if (visited.has(stepId)) return;
    visiting.add(stepId);
    for (const need of byId.get(stepId)!.needs) visit(need);
    visiting.delete(stepId); visited.add(stepId);
  };
  for (const step of steps) visit(step.id);
}

function parseDefaults(value: unknown): WorkflowDefaults {
  const raw = object(value ?? {}, "defaults");
  if (raw.surface !== undefined) fail("defaults.surface is no longer supported; workflow workers always run in Herdr");
  const retryValue = raw.retry ?? 0;
  if (typeof retryValue !== "number" || !Number.isInteger(retryValue) || retryValue < 0 || retryValue > 8) fail("defaults.retry must be an integer from 0 to 8");
  return { retry: retryValue as number };
}

export function normalizeWorkflow(value: unknown, sourcePath = "<memory>"): WorkflowDefinition {
  const raw = object(value, sourcePath);
  if (raw.version !== WORKFLOW_VERSION) fail(`version must be ${WORKFLOW_VERSION}`);
  const workflowId = id(raw.id, "id");
  const defaults = parseDefaults(raw.defaults);
  const inputs = parseInputs(raw.inputs);
  const rawSteps = raw.steps;
  if (!Array.isArray(rawSteps) || rawSteps.length < 1 || rawSteps.length > MAX_STEPS) fail(`steps must contain between 1 and ${MAX_STEPS} entries`);
  const steps = (rawSteps as unknown[]).map((step, index) => parseStep(step, index, defaults));
  validateGraph(steps, inputs);
  return {
    version: WORKFLOW_VERSION, id: workflowId, name: text(raw.name, "name", 240), description: text(raw.description, "description", 4000),
    inputs, defaults, steps,
  };
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value as Record<string, unknown>).sort().map((key) => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function hashWorkflow(definition: WorkflowDefinition): string {
  return createHash("sha256").update(canonical(definition)).digest("hex");
}

export function parseWorkflowYaml(content: string, sourcePath = "<memory>"): LoadedWorkflow {
  const value = parseYaml(content);
  const definition = normalizeWorkflow(value, sourcePath);
  return { ...definition, sourcePath, hash: hashWorkflow(definition) };
}

function discoverFiles(cwd: string, trusted: boolean, home = homedir(), includeBundled = true): string[] {
  const bundledWorkflows = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "workflows");
  const dirs = includeBundled ? [bundledWorkflows] : [];
  dirs.push(join(home, ".pi", "agent", "workflows"));
  if (trusted) dirs.push(resolve(cwd, ".pi", "workflows"));
  const files = new Set<string>();
  for (const dir of dirs) {
    let names: string[];
    try { names = readdirSync(dir).filter((name) => /\.ya?ml$/i.test(name)).sort(); } catch { continue; }
    for (const name of names) files.add(resolve(dir, name));
  }
  return [...files].sort();
}

export function loadWorkflowDefinitions(options: { cwd: string; trusted: boolean; home?: string; includeBundled?: boolean; readFile?: (path: string) => string }): WorkflowLoadResult {
  const files = discoverFiles(options.cwd, options.trusted, options.home, options.includeBundled);
  const diagnostics: WorkflowDiagnostic[] = [];
  const parsed: LoadedWorkflow[] = [];
  const read = options.readFile ?? ((path: string) => readFileSync(path, "utf8"));
  for (const sourcePath of files) {
    try { parsed.push(parseWorkflowYaml(read(sourcePath), sourcePath)); }
    catch (error) { diagnostics.push({ sourcePath, level: "error", message: error instanceof Error ? error.message : String(error) }); }
  }
  const counts = new Map<string, LoadedWorkflow[]>();
  for (const workflow of parsed) counts.set(workflow.id, [...(counts.get(workflow.id) ?? []), workflow]);
  const workflows = parsed.filter((workflow) => {
    const duplicate = (counts.get(workflow.id)?.length ?? 0) > 1;
    if (duplicate && counts.get(workflow.id)![0].sourcePath === workflow.sourcePath) {
      diagnostics.push({ id: workflow.id, sourcePath: workflow.sourcePath, level: "error", message: `duplicate workflow id ${workflow.id}: ${counts.get(workflow.id)!.map((item) => item.sourcePath).join(", ")}` });
    }
    return !duplicate;
  });
  return { workflows, diagnostics, files };
}

export function validateWorkflowText(content: string, sourcePath = "<memory>"): WorkflowDiagnostic[] {
  try { parseWorkflowYaml(content, sourcePath); return []; }
  catch (error) { return [{ sourcePath, level: "error", message: error instanceof Error ? error.message : String(error) }]; }
}

export function resolveWorkflowInput(definition: WorkflowDefinition, values: Record<string, unknown>): Record<string, string> {
  const result: Record<string, string> = {};
  for (const name of Object.keys(values)) if (!Object.prototype.hasOwnProperty.call(definition.inputs, name)) fail(`unknown workflow input ${name}`);
  for (const [name, spec] of Object.entries(definition.inputs)) {
    const candidate = values[name] ?? spec.default;
    if (candidate === undefined) {
      if (spec.required) fail(`input ${name} is required`);
      continue;
    }
    if (typeof candidate !== "string") fail(`input ${name} must be a string`);
    const stringCandidate = candidate as string;
    if (!stringCandidate.trim() && spec.required) fail(`input ${name} is required`);
    result[name] = stringCandidate;
  }
  return result;
}

export function isWorkflowFilePath(path: string): boolean { return isAbsolute(path) && /\.ya?ml$/i.test(path); }
