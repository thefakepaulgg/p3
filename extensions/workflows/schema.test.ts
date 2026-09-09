import { expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { hashWorkflow, loadWorkflowDefinitions, parseWorkflowYaml, resolveWorkflowInput, validateWorkflowText } from "./schema.ts";

const yaml = (overrides = "") => `
version: pi-workflow/v1
id: synthetic
name: Synthetic
description: A bounded synthetic workflow
inputs:
  goal: { type: string, required: true }
defaults: { retry: 1 }
steps:
  - id: research
    name: Research
    route: luna
    phase: other
    prompt: "Research {{inputs.goal}}"
  - id: implement
    name: Implement
    route: luna
    phase: implement
    needs: [research]
    context: [steps.research.output]
    prompt: "Implement {{steps.research.output}}"
${overrides}`;

test("normalizes, hashes, and snapshots a generic workflow", () => {
  const loaded = parseWorkflowYaml(yaml(), "/tmp/synthetic.yaml");
  expect(loaded.version).toBe("pi-workflow/v1");
  expect(loaded.steps[1].context).toEqual(["steps.research.output"]);
  const first = loaded.hash;
  loaded.steps[0].name = "changed";
  expect(hashWorkflow(loaded)).not.toBe(first);
});

test("reports malformed YAML and invalid graph/context references", () => {
  expect(validateWorkflowText("not: [valid", "/tmp/bad.yaml")).toHaveLength(1);
  expect(() => parseWorkflowYaml(yaml().replace("needs: [research]", "needs: [missing]"))).toThrow("unknown step");
  expect(() => parseWorkflowYaml(yaml().replace("needs: [research]", "needs: [research]").replace("steps.research.output", "steps.unknown.output"))).toThrow("must refer to a dependency");
  expect(() => parseWorkflowYaml(yaml().replace("  - id: research\n", "  - id: research\n    needs: [implement]\n"))).toThrow("cycle");
});

test("accepts optional inputs and rejects removed execution fields", () => {
  const optional = parseWorkflowYaml(yaml().replace("  goal: { type: string, required: true }", "  goal: { type: string, required: true }\n  scope: { type: string, required: false }"));
  expect(optional.inputs.scope.required).toBe(false);
  expect(resolveWorkflowInput(optional, { goal: "goal text" })).toEqual({ goal: "goal text" });
  expect(() => resolveWorkflowInput(optional, { goal: "goal text", scpoe: "typo" })).toThrow("unknown workflow input scpoe");
  expect(() => parseWorkflowYaml(yaml().replace("Research {{inputs.goal}}", "Research {{inputs.typo}}"))).toThrow("unknown input");
  expect(() => parseWorkflowYaml(yaml().replace("name: Research", `name: ${"x".repeat(81)}`))).toThrow("80 character limit");
  expect(() => parseWorkflowYaml(yaml().replace("defaults: { retry: 1 }", "defaults: { surface: herdr, retry: 1 }"))).toThrow("defaults.surface is no longer supported");
  expect(() => parseWorkflowYaml(yaml().replace("    phase: implement", "    phase: implement\n    surface: herdr"))).toThrow("steps[1].surface is no longer supported");
  expect(() => parseWorkflowYaml(yaml().replace("    phase: implement", "    phase: implement\n    isolation: worktree"))).toThrow("steps[1].isolation is no longer supported");
});

test("accepts an approval message only alongside approval.after", () => {
  const withMessage = parseWorkflowYaml(yaml().replace("    phase: implement", "    phase: implement\n    approval: { after: true, message: \"Read the PR, then /workflow continue\" }"));
  expect(withMessage.steps[1].approvalAfter).toBe(true);
  expect(withMessage.steps[1].approvalMessage).toBe("Read the PR, then /workflow continue");
  expect(withMessage.steps[0].approvalMessage).toBeUndefined();
  expect(hashWorkflow(withMessage)).not.toBe(parseWorkflowYaml(yaml().replace("    phase: implement", "    phase: implement\n    approval: { after: true }")).hash);
  expect(() => parseWorkflowYaml(yaml().replace("    phase: implement", "    phase: implement\n    approval: { message: \"orphan\" }"))).toThrow("requires approval.after");
  expect(() => parseWorkflowYaml(yaml().replace("    phase: implement", "    phase: implement\n    approval: { after: true, message: 7 }"))).toThrow("must be a string");
});

test("discovers trusted project workflows and rejects duplicate IDs deterministically", () => {
  const root = mkdtempSync(join(tmpdir(), "workflow-loader-"));
  const home = join(root, "home"); const globalDir = join(home, ".pi", "agent", "workflows"); const projectDir = join(root, ".pi", "workflows");
  mkdirSync(globalDir, { recursive: true }); mkdirSync(projectDir, { recursive: true });
  writeFileSync(join(globalDir, "one.yaml"), yaml().replace("id: synthetic", "id: duplicate"));
  writeFileSync(join(projectDir, "two.yaml"), yaml().replace("id: synthetic", "id: duplicate"));
  writeFileSync(join(projectDir, "three.yaml"), yaml().replace("id: synthetic", "id: project-only"));
  const trusted = loadWorkflowDefinitions({ cwd: root, trusted: true, home, includeBundled: false });
  expect(trusted.workflows.map((item) => item.id)).toEqual(["project-only"]);
  expect(trusted.diagnostics.some((item) => item.message.includes("duplicate workflow id duplicate"))).toBe(true);
  const untrusted = loadWorkflowDefinitions({ cwd: root, trusted: false, home, includeBundled: false });
  expect(untrusted.workflows).toHaveLength(1);
  expect(untrusted.workflows[0].id).toBe("duplicate");
});
