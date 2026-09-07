import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const script = join(dirname(fileURLToPath(import.meta.url)), "retry.sh");
const bashPath = (value) => process.platform === "win32"
  ? value.replace(/^([A-Za-z]):\\/, (_match, drive) => `/mnt/${drive.toLowerCase()}/`).replaceAll("\\", "/")
  : value;

test("captures one bounded log per retry attempt", () => {
  const directory = mkdtempSync(join(tmpdir(), "cloud-plugin-retry-"));
  const attemptDirectory = join(directory, "attempts");
  const counter = join(directory, "counter");
  const helper = join(directory, "increment.sh");
  try {
    writeFileSync(helper, [
      '#!/usr/bin/env bash',
      `counter='${bashPath(counter)}'`,
      'count=0',
      '[ ! -f "$counter" ] || count="$(tr -d \'[:space:]\' <"$counter")"',
      'count=$((count + 1))',
      'printf \'%s\\n\' "$count" >"$counter"',
      'printf \'attempt %s\\n\' "$count"',
      '[ "$count" -ge 3 ]',
      '',
    ].join('\n'), 'utf8');
    execFileSync(
      "bash",
      [
        bashPath(script),
        "--attempts",
        "3",
        "--delay",
        "0",
        "--max-delay",
        "0",
        "--label",
        "captured retry",
        "--attempt-dir",
        bashPath(attemptDirectory),
        "--",
        "bash",
        bashPath(helper),
      ],
      {
        env: process.env,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    assert.equal(readFileSync(counter, "utf8").trim(), "3");
    assert.equal(readFileSync(join(attemptDirectory, "1.log"), "utf8").trim(), "attempt 1");
    assert.equal(readFileSync(join(attemptDirectory, "2.log"), "utf8").trim(), "attempt 2");
    assert.equal(readFileSync(join(attemptDirectory, "3.log"), "utf8").trim(), "attempt 3");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("preserves the final command exit code while retaining exhausted-attempt logs", () => {
  const directory = mkdtempSync(join(tmpdir(), "cloud-plugin-retry-failure-"));
  try {
    const result = spawnSync(
      "bash",
      [
        bashPath(script),
        "--attempts",
        "3",
        "--delay",
        "0",
        "--max-delay",
        "0",
        "--label",
        "failed retry",
        "--attempt-dir",
        bashPath(directory),
        "--",
        "bash",
        "-c",
        'printf "retry failed\\n"; exit 7',
      ],
      {
        env: process.env,
        encoding: "utf8",
      },
    );
    assert.equal(result.status, 7);
    for (const attempt of [1, 2, 3]) {
      assert.equal(readFileSync(join(directory, `${attempt}.log`), "utf8").trim(), "retry failed");
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
