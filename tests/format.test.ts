import { test } from "node:test";
import assert from "node:assert/strict";
import { formatBytes, formatDuration, sanitizeName, extensionOf } from "../src/lib/format";

test("formatBytes renders human sizes", () => {
  assert.equal(formatBytes(0), "0 B");
  assert.equal(formatBytes(512), "512 B");
  assert.equal(formatBytes(1024), "1.0 KB");
  assert.equal(formatBytes(1536), "1.5 KB");
  assert.equal(formatBytes(5 * 1024 * 1024), "5.0 MB");
  assert.equal(formatBytes(2 * 1024 * 1024 * 1024), "2.0 GB");
  assert.equal(formatBytes(NaN), "—");
  assert.equal(formatBytes(-1), "—");
});

test("formatBytes with zero fraction digits for the limits table", () => {
  assert.equal(formatBytes(250 * 1024 * 1024, 0), "250 MB");
});

test("formatDuration", () => {
  assert.equal(formatDuration(0), "any moment");
  assert.equal(formatDuration(45_000), "45s");
  assert.equal(formatDuration(125_000), "2m 5s");
  assert.equal(formatDuration(3_700_000), "1h 1m");
});

test("sanitizeName keeps ordinary filenames intact", () => {
  assert.equal(sanitizeName("report.pdf"), "report.pdf");
  assert.equal(sanitizeName("my file (final).docx"), "my file (final).docx");
});

test("sanitizeName reduces any path to its final segment", () => {
  assert.equal(sanitizeName("../../etc/passwd"), "passwd");
  assert.equal(sanitizeName("..\\..\\windows\\system.ini"), "system.ini");
  assert.equal(sanitizeName("../../../x"), "x");
});

test("sanitizeName strips control characters and leading dots", () => {
  assert.equal(sanitizeName("a\u0000b.txt"), "ab.txt");
  assert.equal(sanitizeName("...hidden"), "hidden");
});

test("sanitizeName falls back when nothing survives", () => {
  assert.equal(sanitizeName(""), "file");
  assert.equal(sanitizeName("///"), "file");
  assert.equal(sanitizeName("", "unnamed"), "unnamed");
});

test("sanitizeName truncates very long names", () => {
  const long = `${"a".repeat(400)}.txt`;
  assert.equal(sanitizeName(long).length, 180);
});

test("extensionOf", () => {
  assert.equal(extensionOf("archive.TAR.GZ"), "gz");
  assert.equal(extensionOf("noext"), "");
  assert.equal(extensionOf("dot."), "");
});
