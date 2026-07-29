import { existsSync, lstatSync } from "node:fs";
import { realpath } from "node:fs/promises";
import { dirname, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { TeamModule } from "./team.ts";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const teamsRoot = resolve(root, "teams");
const teamIdPattern = /^[a-z][a-z0-9-]{0,62}$/;
const cache = new Map<string, LoadedTeam>();

export interface LoadedTeam {
  readonly definition: TeamModule;
  readonly directory: string;
}

const contains = (parent: string, child: string): boolean =>
  child === parent || child.startsWith(`${parent}${sep}`);

const teamDirectory = async (id: string): Promise<string> => {
  if (!teamIdPattern.test(id)) {
    throw new Error("Invalid team id.");
  }
  const candidate = resolve(teamsRoot, id);
  if (!(contains(teamsRoot, candidate) && existsSync(candidate))) {
    throw new Error("Unknown team.");
  }
  const metadata = lstatSync(candidate);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new Error("A team must be a real directory.");
  }
  const resolvedRoot = await realpath(teamsRoot);
  const resolvedDirectory = await realpath(candidate);
  if (!contains(resolvedRoot, resolvedDirectory)) {
    throw new Error("Team directory escapes the teams root.");
  }
  return resolvedDirectory;
};

const isTeamModule = (value: unknown): value is TeamModule => {
  if (!value || typeof value !== "object") {
    return false;
  }
  const team = value as Partial<TeamModule>;
  return (
    typeof team.id === "string" &&
    typeof team.leadDelegationGuidance === "string" &&
    typeof team.createTools === "function" &&
    Boolean(team.agents) &&
    typeof team.agents === "object" &&
    (team.failureAnalysisAgent === undefined ||
      typeof team.failureAnalysisAgent === "string") &&
    (team.maxFailureRecoveryAttempts === undefined ||
      (Number.isInteger(team.maxFailureRecoveryAttempts) &&
        team.maxFailureRecoveryAttempts >= 0 &&
        team.maxFailureRecoveryAttempts <= 3))
  );
};

export const loadTeam = async (id: string): Promise<LoadedTeam> => {
  const cached = cache.get(id);
  if (cached) {
    return cached;
  }
  const directory = await teamDirectory(id);
  const modulePath = resolve(directory, "team.ts");
  if (!existsSync(modulePath) || lstatSync(modulePath).isSymbolicLink()) {
    throw new Error("Team module is missing or unsafe.");
  }
  const imported = (await import(pathToFileURL(modulePath).href)) as {
    readonly default?: unknown;
  };
  if (!isTeamModule(imported.default) || imported.default.id !== id) {
    throw new Error("Team module has an invalid definition.");
  }
  const loaded = { definition: imported.default, directory };
  cache.set(id, loaded);
  return loaded;
};
