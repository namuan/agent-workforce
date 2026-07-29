import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
  mkdir,
  open,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { join, resolve } from "node:path";

const maxLessons = 12;
const maxStoreBytes = 64_000;
const maxMarkerBytes = 1000;
const teamIdPattern = /^[a-z][a-z0-9-]{0,62}$/;
const writeQueues = new Map<string, Promise<void>>();

type LessonCode =
  | "invalid-tool-input"
  | "model-failure"
  | "model-timeout"
  | "relative-workspace-path"
  | "tool-failure"
  | "tool-turn-limit"
  | "unavailable-tool";

interface Lesson {
  readonly code: LessonCode;
}

interface TeamLearningStore {
  readonly lessons: Lesson[];
  readonly version: 1;
}

const lessonText: Record<LessonCode, string> = {
  "invalid-tool-input":
    "Use each tool's documented JSON shape and validate paths before proposing an action.",
  "model-failure":
    "If the model endpoint fails, stop and report the safe failure category instead of retrying the same plan.",
  "model-timeout":
    "Keep the next model step focused after a timeout; do not repeat the same delegation in the same request.",
  "relative-workspace-path":
    "Workspace tool paths are relative to DEV_WORKSPACE_DIR, for example snake.html, never /workspace/snake.html.",
  "tool-failure":
    "When a tool fails, read its result and choose a different valid call. Do not repeat the same failed call unchanged.",
  "tool-turn-limit":
    "Use a concise plan and avoid unnecessary inspection or repeated tool calls so the task fits within the tool-turn limit.",
  "unavailable-tool":
    "Call only tools listed for the current agent. Do not invent tool names.",
};

const lessonCodes = Object.keys(lessonText) as LessonCode[];

const learningDirectory = (): string =>
  resolve(process.env.DATA_DIR ?? ".data", "team-learning");

const learningPath = (team: string): string => {
  if (!teamIdPattern.test(team)) {
    throw new Error("Invalid team id for shared learning.");
  }
  return join(learningDirectory(), `${team}.json`);
};

const lessonMarkerDirectory = (team: string): string => {
  if (!teamIdPattern.test(team)) {
    throw new Error("Invalid team id for shared learning.");
  }
  return join(learningDirectory(), `${team}.lessons`);
};

const emptyStore = (): TeamLearningStore => ({ lessons: [], version: 1 });

const safeMarkerReadFlags = (): number => {
  // biome-ignore lint/suspicious/noBitwiseOperators: POSIX open flags must be combined bitwise.
  return constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;
};

const isLessonCode = (value: unknown): value is LessonCode =>
  typeof value === "string" && Object.hasOwn(lessonText, value);

const normalizedLessons = (lessons: unknown[]): Lesson[] => {
  const byCode = new Map<LessonCode, Lesson>();
  for (const lesson of lessons) {
    if (
      !(
        lesson &&
        typeof lesson === "object" &&
        isLessonCode((lesson as Lesson).code)
      )
    ) {
      continue;
    }
    const storedLesson = lesson as Lesson;
    if (!byCode.has(storedLesson.code)) {
      byCode.set(storedLesson.code, storedLesson);
    }
  }
  return [...byCode.values()].slice(0, maxLessons);
};

const asStore = (value: unknown): TeamLearningStore => {
  if (!value || typeof value !== "object") {
    return emptyStore();
  }
  const lessons = (value as { lessons?: unknown }).lessons;
  if (!Array.isArray(lessons)) {
    return emptyStore();
  }
  return {
    lessons: normalizedLessons(lessons),
    version: 1,
  };
};

const readStore = async (path: string): Promise<TeamLearningStore> => {
  try {
    if ((await stat(path)).size > maxStoreBytes) {
      return emptyStore();
    }
    return asStore(JSON.parse(await readFile(path, "utf8")));
  } catch {
    return emptyStore();
  }
};

const readMarkerLessons = async (team: string): Promise<Lesson[]> => {
  try {
    const directory = lessonMarkerDirectory(team);
    const lessons = await Promise.all(
      lessonCodes.map(async (code) => {
        const path = join(directory, `${code}.json`);
        try {
          const handle = await open(path, safeMarkerReadFlags());
          try {
            if (!(await handle.stat()).isFile()) {
              return;
            }
            const buffer = Buffer.alloc(maxMarkerBytes + 1);
            const { bytesRead } = await handle.read(
              buffer,
              0,
              buffer.length,
              0
            );
            if (bytesRead > maxMarkerBytes) {
              return;
            }
            return JSON.parse(buffer.subarray(0, bytesRead).toString("utf8"));
          } catch {
            // Ignore a malformed marker.
          } finally {
            await handle.close();
          }
        } catch {
          // A marker has not been recorded, or is not safe to read.
        }
      })
    );
    return normalizedLessons(lessons);
  } catch {
    return [];
  }
};

const writeLessonMarker = async (
  team: string,
  code: LessonCode
): Promise<void> => {
  const directory = lessonMarkerDirectory(team);
  await mkdir(directory, { mode: 0o700, recursive: true });
  try {
    await writeFile(
      join(directory, `${code}.json`),
      `${JSON.stringify({ code })}\n`,
      { encoding: "utf8", flag: "wx", mode: 0o600 }
    );
  } catch (error) {
    if ((error as { code?: string }).code !== "EEXIST") {
      throw error;
    }
  }
};

const writeStore = async (
  path: string,
  store: TeamLearningStore
): Promise<void> => {
  const directory = learningDirectory();
  await mkdir(directory, { mode: 0o700, recursive: true });
  const temporary = join(directory, `${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, `${JSON.stringify(store, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
};

const queueWrite = (
  path: string,
  operation: () => Promise<void>
): Promise<void> => {
  const previous = writeQueues.get(path) ?? Promise.resolve();
  const next = previous.catch(() => undefined).then(operation);
  const queued = next.finally(() => {
    if (writeQueues.get(path) === queued) {
      writeQueues.delete(path);
    }
  });
  writeQueues.set(path, queued);
  return queued;
};

const lessonFor = (error: unknown): LessonCode => {
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes("Workspace paths must be relative")) {
    return "relative-workspace-path";
  }
  if (message.includes("Invalid tool input")) {
    return "invalid-tool-input";
  }
  if (message.includes("unavailable tool")) {
    return "unavailable-tool";
  }
  if (message.includes("tool-call limit")) {
    return "tool-turn-limit";
  }
  if (message.includes("Model request timed out")) {
    return "model-timeout";
  }
  if (
    message.includes("Model request failed") ||
    message.includes("Model returned an error response") ||
    message.includes("Model response was not valid JSON")
  ) {
    return "model-failure";
  }
  return "tool-failure";
};

export const recordTeamLesson = async (
  team: string,
  error: unknown
): Promise<LessonCode> => {
  const code = lessonFor(error);
  const path = learningPath(team);
  await mkdir(learningDirectory(), { mode: 0o700, recursive: true });
  await writeLessonMarker(team, code);
  await queueWrite(path, async () => {
    const store = await readStore(path);
    const markers = await readMarkerLessons(team);
    const lessons = normalizedLessons([
      { code },
      ...store.lessons.filter((lesson) => lesson.code !== code),
      ...markers.filter((lesson) => lesson.code !== code),
    ]);
    await writeStore(path, { lessons, version: 1 });
  });
  return code;
};

export const sharedTeamLessons = async (team: string): Promise<string[]> => {
  const store = await readStore(learningPath(team));
  const lessons = normalizedLessons([
    ...store.lessons,
    ...(await readMarkerLessons(team)),
  ]);
  return lessons.map((lesson) => lessonText[lesson.code]);
};
