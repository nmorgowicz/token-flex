/**
 * Functional smoke test for token-flex.
 *
 * Builds synthetic pi sessions in a temporary directory, then exercises the
 * public surface end to end: argument parsing, range resolution, aggregation,
 * registry maintenance, filesystem discovery and the setup report. Prints the
 * generated report and exits non-zero when any check fails.
 */

import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import {
  buildMarkdown,
  collectStats,
  discoverFromProjectsRoot,
  discoverFromSessionsRoot,
  discoverProjects,
  loadRegistry,
  parseArgs,
  parseDateTime,
  parseInterval,
  pruneRegistry,
  registerProject,
  registryPath,
  resolveRange,
  saveRegistry,
  setupReport,
  sumProjects,
} from "../extensions/token-flex.ts";

const checks: Array<{ label: string; ok: boolean; detail?: string }> = [];
const check = (label: string, ok: boolean, detail?: string): void => {
  checks.push({ label, ok, detail });
};

const close = (a: number, b: number, epsilon = 1e-9): boolean => Math.abs(a - b) < epsilon;

const sessionHeader = (cwd: string): string =>
  JSON.stringify({
    type: "session",
    version: 3,
    id: "11111111-1111-1111-1111-111111111111",
    timestamp: "2026-01-01T00:00:00.000Z",
    cwd,
  });

const assistantEntry = (provider: string, model: string, timestamp: number, usage: Record<string, unknown>): string =>
  JSON.stringify({
    type: "message",
    timestamp: new Date(timestamp).toISOString(),
    message: { role: "assistant", provider, model, timestamp, usage },
  });

const JAN = (day: number, hour = 12): number => new Date(2026, 0, day, hour, 0, 0).getTime();
const FEB = (day: number, hour = 12): number => new Date(2026, 1, day, hour, 0, 0).getTime();

const root = mkdtempSync(join(tmpdir(), "token-flex-smoke-"));
const agentDir = join(root, "agent");
const projectsRoot = join(root, "projects");
const registryFile = join(root, "registry", "projects.json");
const smokeProject = join(root, "smoke-project");
mkdirSync(smokeProject, { recursive: true });

const writeSession = (dir: string, relative: string, lines: string[]): string => {
  const file = join(dir, relative);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, lines.join("\n") + "\n", "utf8");
  return dir;
};

const webDir = writeSession(join(projectsRoot, "acme-web", "sessions"), "20260110_aaaaaaaa.jsonl", [
  sessionHeader("/home/user/projects/acme-web"),
  JSON.stringify({ type: "message", message: { role: "user", content: "ignored, not an assistant message" } }),
  "{ this line is not json and must be skipped",
  assistantEntry("anthropic", "claude-sonnet-4.6", JAN(10), {
    input: 1000,
    output: 500,
    cacheRead: 200,
    cacheWrite: 100,
    reasoning: 50,
    totalTokens: 1800,
    cost: { input: 0.003, output: 0.0075, cacheRead: 0.0003, cacheWrite: 0.000375, total: 0.011175 },
  }),
  assistantEntry("anthropic", "claude-sonnet-4.6", JAN(20), {
    input: 2000,
    output: 800,
    cacheRead: 400,
    cacheWrite: 0,
    reasoning: 120,
    cost: { input: 0.006, output: 0.012, cacheRead: 0.0006 },
  }),
]);

const apiDir = writeSession(join(projectsRoot, "acme-api", "sessions"), "nested/20260115_bbbbbbbb.jsonl", [
  sessionHeader("/home/user/projects/acme-api"),
  assistantEntry("openai", "gpt-5.2", JAN(15), {
    input: 500,
    output: 250,
    reasoning: 10,
    totalTokens: 750,
    cost: { input: 0.001, output: 0.002, total: 0.003 },
  }),
  assistantEntry("openai", "gpt-5.2", FEB(5), {
    input: 9999,
    output: 9999,
    totalTokens: 19998,
    cost: { total: 9.99 },
  }),
]);

// Standard pi layout: cwd-encoded session directories under <agent dir>/sessions.
const sessionsRoot = join(agentDir, "sessions");
writeSession(join(sessionsRoot, "--home-user-projects-acme-web--"), "20260110_cccccccc.jsonl", [
  sessionHeader("/home/user/projects/acme-web"),
  assistantEntry("anthropic", "claude-sonnet-4.6", JAN(10), { input: 10, totalTokens: 10 }),
]);
writeSession(join(sessionsRoot, "--home-user-projects-legacy-api--"), "20260111_dddddddd.jsonl", [
  JSON.stringify({ type: "session", version: 3, id: "header-without-cwd" }),
  assistantEntry("openai", "gpt-5.2", JAN(11), { input: 5, totalTokens: 5 }),
]);

process.env.PI_CODING_AGENT_DIR = agentDir;
process.env.PI_PROJECTS_ROOT = projectsRoot;
process.env.PI_PROJECT_REGISTRY = registryFile;
delete process.env.PI_PROJECT_NAME;
delete process.env.PI_CODING_AGENT_SESSION_DIR;

// --- argument parsing -------------------------------------------------------
check("parseArgs bare days", parseArgs("7").days === 7);
check(
  "parseArgs compound interval",
  parseArgs("--interval 2h40m").interval === "2h40m" && parseInterval("2h40m") === 2 * 3_600_000 + 40 * 60_000,
);
check("parseArgs --from/--to", parseArgs("--from 20260101 --to 20260131").from === "20260101");
check("parseArgs combined range", parseArgs("20260101-20260131").combined === "20260101-20260131");
check("parseArgs --setup", parseArgs("--setup").setup === true);
check("parseArgs --project", parseArgs("-p acme-api").project === "acme-api");
check("parseArgs rejects unknown argument", parseArgs("--nope").errors.length === 1);

// --- range resolution -------------------------------------------------------
check("resolveRange default window", resolveRange(parseArgs(undefined), 0).label === "last 30 days");
check("resolveRange interval label", resolveRange(parseArgs("--interval 2h40m"), 0).label === "last 2h 40m");
check(
  "resolveRange all time",
  resolveRange(parseArgs("0"), 0).from === undefined && resolveRange(parseArgs("0"), 0).label === "all time",
);
check(
  "resolveRange absolute window",
  (() => {
    const range = resolveRange(parseArgs("20260101-20260131"));
    return range.error === undefined && range.from === parseDateTime("20260101") && range.to === parseDateTime("20260131");
  })(),
);
check("resolveRange rejects reversed window", resolveRange(parseArgs("20260131-20260101")).error !== undefined);

// --- aggregation ------------------------------------------------------------
const january = resolveRange(parseArgs("--from 20260101 --to 20260131"));
const web = collectStats("acme-web", webDir, january);
check("collectStats acme-web requests", web.requests === 2, `requests=${web.requests}`);
check("collectStats acme-web tokens", web.totalTokens === 5000 && web.reasoning === 170, `tokens=${web.totalTokens} reasoning=${web.reasoning}`);
check("collectStats acme-web cost", close(web.costTotal, 0.029775), `cost=${web.costTotal}`);
check("collectStats acme-web files", web.filesScanned === 1 && web.filesMatched === 1);
check("collectStats acme-web models", web.models.size === 1 && web.models.has("anthropic/claude-sonnet-4.6"));

const api = collectStats("acme-api", apiDir, january);
check("collectStats acme-api excludes February", api.requests === 1 && api.totalTokens === 750, `requests=${api.requests} tokens=${api.totalTokens}`);
check("collectStats acme-api models", api.models.size === 1 && api.models.has("openai/gpt-5.2"));

const total = sumProjects([web, api]);
check("sumProjects totals", total.requests === 3 && total.totalTokens === 5750, `requests=${total.requests} tokens=${total.totalTokens}`);
check("sumProjects cost", close(total.costTotal, 0.032775), `cost=${total.costTotal}`);

const report = buildMarkdown([web, api], total, january, parseArgs("--all"));
check("report overview section", report.includes("## Overview"));
check("report model section", report.includes("## By Model"));
check("report project section", report.includes("## By Project") && report.includes("`acme-web`") && report.includes("`acme-api`"));
check("report reasoning column", report.includes("Reasoning"));

// --- discovery --------------------------------------------------------------
const fromProjectsRoot = discoverFromProjectsRoot(projectsRoot);
check(
  "discoverFromProjectsRoot finds both projects",
  fromProjectsRoot.length === 2 && fromProjectsRoot.some((entry) => entry.name === "acme-web" && entry.root === join(projectsRoot, "acme-web")),
);
const fromSessionsRoot = discoverFromSessionsRoot(sessionsRoot);
check("discoverFromSessionsRoot uses header cwd", fromSessionsRoot.some((entry) => entry.name === "acme-web"));
check("discoverFromSessionsRoot fallback name", fromSessionsRoot.some((entry) => entry.name === "home-user-projects-legacy-api"));
const discovered = discoverProjects();
check(
  "discoverProjects deduplicates",
  discovered.length === 3 && discovered.filter((entry) => entry.name === "acme-web").length === 1,
  `names=${discovered.map((entry) => entry.name).join(",")}`,
);

// --- setup report -----------------------------------------------------------
check("registryPath honors PI_PROJECT_REGISTRY", registryPath() === registryFile);
const setup = setupReport(smokeProject);
check("setupReport creates missing registry", setup.registryCreated === true);
check("setupReport registers current project", setup.registeredCurrent === true && loadRegistry().projects["smoke-project"] !== undefined);
check(
  "setupReport renders configuration",
  setup.markdown.includes("# token-flex — Setup") && setup.markdown.includes(registryFile) && setup.markdown.includes("PI_PROJECTS_ROOT"),
);
const setupAgain = setupReport(smokeProject);
check("setupReport is idempotent", setupAgain.registryCreated === false && setupAgain.registeredCurrent === false);

// --- registry ---------------------------------------------------------------
const registry = loadRegistry();
registerProject(registry, "acme-web", join(projectsRoot, "acme-web"), webDir);
registerProject(registry, "ghost", undefined, join(root, "does-not-exist"));
saveRegistry(registry);
check("registry file written", existsSync(registryFile));
const reloaded = loadRegistry();
check("registry round trip", reloaded.projects["acme-web"]?.sessionDir === webDir);
check("pruneRegistry removes stale entries", pruneRegistry(reloaded).includes("ghost"));

// --- evidence ---------------------------------------------------------------
for (const entry of checks) {
  console.log(`${entry.ok ? "PASS" : "FAIL"}  ${entry.label}${entry.detail ? ` (${entry.detail})` : ""}`);
}

console.log("\n----- sample report (synthetic data) -----\n");
console.log(report);
console.log("\n----- setup report (synthetic data) -----\n");
console.log(setup.markdown);

const failed = checks.filter((entry) => !entry.ok);
console.log(`\nSUMMARY: ${checks.length - failed.length}/${checks.length} checks passed`);
rmSync(root, { recursive: true, force: true });
if (failed.length > 0) process.exit(1);
