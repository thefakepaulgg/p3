import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { prepareEvidence } from "./evidence.ts";

let temp: string;
beforeEach(() => { temp = mkdtempSync(join(tmpdir(), "evidence-test-")); });
afterEach(() => { rmSync(temp, { recursive: true, force: true }); });

describe("prepareEvidence", () => {
  test("empty or undefined files returns empty result", () => {
    expect(prepareEvidence(undefined, temp)).toEqual({ text: "", files: [] });
    expect(prepareEvidence([], temp)).toEqual({ text: "", files: [] });
  });

  test("embeds small UTF-8 file with provenance and hash", () => {
    writeFileSync(join(temp, "a.txt"), "hello world");
    const result = prepareEvidence(["a.txt"], temp);
    expect(result.text).toContain("untrusted evidence");
    expect(result.text).toContain("hello world");
    expect(result.text).toContain('sha256="');
    expect(result.files).toHaveLength(1);
    expect(result.files[0].embedded).toBe(true);
    expect(result.files[0].sha256).toBeDefined();
    expect(result.files[0].bytes).toBe(11);
  });

  test("references binary file without embedding", () => {
    writeFileSync(join(temp, "bin"), Buffer.from([0x00, 0x01, 0x02]));
    const result = prepareEvidence(["bin"], temp);
    expect(result.text).toContain('embedded="false"');
    expect(result.files[0].embedded).toBe(false);
    expect(result.files[0].sha256).toBeUndefined();
  });

  test("references file larger than 32 KiB without embedding", () => {
    writeFileSync(join(temp, "big.txt"), "x".repeat(33 * 1024));
    const result = prepareEvidence(["big.txt"], temp);
    expect(result.files[0].embedded).toBe(false);
    expect(result.text).not.toContain("x".repeat(100));
  });

  test("deduplicates resolved paths", () => {
    writeFileSync(join(temp, "dup.txt"), "content");
    const result = prepareEvidence(["dup.txt", "./dup.txt"], temp);
    expect(result.files).toHaveLength(1);
  });

  test("resolves symlinks to canonical path and deduplicates", () => {
    writeFileSync(join(temp, "real.txt"), "sym content");
    symlinkSync(join(temp, "real.txt"), join(temp, "link.txt"));
    const result = prepareEvidence(["real.txt", "link.txt"], temp);
    expect(result.files).toHaveLength(1);
  });

  test("rejects missing files", () => {
    expect(() => prepareEvidence(["nonexistent.txt"], temp)).toThrow("not found");
  });

  test("rejects directories", () => {
    mkdirSync(join(temp, "subdir"));
    expect(() => prepareEvidence(["subdir"], temp)).toThrow("not a regular file");
  });

  test("rejects empty string path", () => {
    expect(() => prepareEvidence([""], temp)).toThrow("non-empty string");
  });

  test("rejects more than 32 files", () => {
    const paths: string[] = [];
    for (let i = 0; i < 33; i++) {
      const name = `f${i}.txt`;
      writeFileSync(join(temp, name), `file ${i}`);
      paths.push(name);
    }
    expect(() => prepareEvidence(paths, temp)).toThrow("32 files");
  });

  test("resolves result: refs via callback", () => {
    const outputPath = join(temp, "output.md");
    writeFileSync(outputPath, "worker output");
    const resolver = (ref: string) => ref === "result:00000000-0000-0000-0000-000000000001" ? outputPath : undefined;
    const result = prepareEvidence(["result:00000000-0000-0000-0000-000000000001"], temp, resolver);
    expect(result.text).toContain("worker output");
    expect(result.files[0].embedded).toBe(true);
  });

  test("rejects result: ref when resolver returns undefined", () => {
    const resolver = () => undefined;
    expect(() => prepareEvidence(["result:00000000-0000-0000-0000-000000000001"], temp, resolver)).toThrow("did not resolve");
  });

  test("rejects result: ref when no resolver provided", () => {
    expect(() => prepareEvidence(["result:00000000-0000-0000-0000-000000000001"], temp)).toThrow("no resolver");
  });

  test("escapes special characters in path attributes", () => {
    const name = 'file<"test">.txt';
    writeFileSync(join(temp, name), "content");
    const result = prepareEvidence([name], temp);
    expect(result.text).toContain("&lt;");
    expect(result.text).toContain("&quot;");
    expect(result.text).not.toContain('path="file<"');
  });

  test("rejects NUL bytes in otherwise UTF-8 file", () => {
    writeFileSync(join(temp, "nul.txt"), Buffer.from("hello\x00world"));
    const result = prepareEvidence(["nul.txt"], temp);
    expect(result.files[0].embedded).toBe(false);
  });

  test("frames output with boundary markers", () => {
    writeFileSync(join(temp, "framed.txt"), "data");
    const result = prepareEvidence(["framed.txt"], temp);
    const lines = result.text.split("\n");
    expect(lines[0]).toContain("evidence");
    expect(lines[lines.length - 1]).toContain("evidence");
  });
});
