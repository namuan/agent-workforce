import { strict as assert } from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { recordTeamLesson, sharedTeamLessons } from "../src/team-learning.ts";

const execFileAsync = promisify(execFile);
const teamLearningModule = new URL("../src/team-learning.ts", import.meta.url)
  .href;

test("shared team learning stores safe lessons instead of raw errors", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "team-learning-"));
  const previousDataDirectory = process.env.DATA_DIR;
  process.env.DATA_DIR = directory;
  t.after(async () => {
    if (previousDataDirectory === undefined) {
      delete process.env.DATA_DIR;
    } else {
      process.env.DATA_DIR = previousDataDirectory;
    }
    await rm(directory, { force: true, recursive: true });
  });

  await recordTeamLesson(
    "software-development",
    new Error("Workspace paths must be relative: secret-sentinel")
  );
  await recordTeamLesson(
    "software-development",
    new Error("Model request timed out after 30000ms.")
  );

  assert.deepEqual(await sharedTeamLessons("software-development"), [
    "Keep the next model step focused after a timeout; do not repeat the same delegation in the same request.",
    "Workspace tool paths are relative to DEV_WORKSPACE_DIR, for example snake.html, never /workspace/snake.html.",
  ]);
  assert.doesNotMatch(
    await readFile(
      join(directory, "team-learning", "software-development.json"),
      "utf8"
    ),
    /secret-sentinel/
  );
});

test("shared team learning retains simultaneous process updates", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "team-learning-processes-"));
  t.after(() => rm(directory, { force: true, recursive: true }));
  const recordInProcess = async (message: string) =>
    execFileAsync(
      process.execPath,
      [
        "--experimental-strip-types",
        "--input-type=module",
        "--eval",
        `import { recordTeamLesson } from ${JSON.stringify(teamLearningModule)}; await recordTeamLesson("concurrent-team", new Error(${JSON.stringify(message)}));`,
      ],
      { env: { ...process.env, DATA_DIR: directory } }
    );

  await Promise.all([
    recordInProcess("Workspace paths must be relative"),
    recordInProcess("Model request timed out after 30000ms."),
    recordInProcess("Invalid tool input"),
  ]);

  const previousDataDirectory = process.env.DATA_DIR;
  process.env.DATA_DIR = directory;
  t.after(() => {
    if (previousDataDirectory === undefined) {
      delete process.env.DATA_DIR;
    } else {
      process.env.DATA_DIR = previousDataDirectory;
    }
  });
  assert.equal((await sharedTeamLessons("concurrent-team")).length, 3);
});

test("shared team learning ignores oversized and malformed persisted stores", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "team-learning-store-"));
  const learningDirectory = join(directory, "team-learning");
  await mkdir(learningDirectory);
  const previousDataDirectory = process.env.DATA_DIR;
  process.env.DATA_DIR = directory;
  t.after(async () => {
    if (previousDataDirectory === undefined) {
      delete process.env.DATA_DIR;
    } else {
      process.env.DATA_DIR = previousDataDirectory;
    }
    await rm(directory, { force: true, recursive: true });
  });

  await writeFile(
    join(learningDirectory, "malformed-team.json"),
    JSON.stringify({
      lessons: [
        { code: "toString", count: 1, lastSeen: "2026-01-01" },
        { code: "tool-failure", count: 1, lastSeen: "2026-01-02" },
        { code: "tool-failure", count: 2, lastSeen: "2026-01-01" },
      ],
    })
  );
  assert.deepEqual(await sharedTeamLessons("malformed-team"), [
    "When a tool fails, read its result and choose a different valid call. Do not repeat the same failed call unchanged.",
  ]);

  await writeFile(
    join(learningDirectory, "oversized-team.json"),
    "x".repeat(64_001)
  );
  assert.deepEqual(await sharedTeamLessons("oversized-team"), []);

  const markerDirectory = join(
    learningDirectory,
    "oversized-marker-team.lessons"
  );
  await mkdir(markerDirectory);
  await writeFile(join(markerDirectory, "tool-failure.json"), "x".repeat(1001));
  assert.deepEqual(await sharedTeamLessons("oversized-marker-team"), []);
});
