/**
 * token-flex — pi token/cost usage statistics with multi-project aggregation.
 *
 * Forked from the MIT-licensed `pi-token-stats` extension by reaishijie
 * (https://github.com/reaishijie/pi-token-stats) and extended with English
 * output, relative and absolute time ranges, per-project aggregation backed by
 * a self-maintaining registry, reasoning-token accounting, and a `--setup`
 * configuration report. README.md carries the full comparison with upstream.
 *
 * Configuration is environment-driven and entirely optional (see .env.example):
 *   PI_PROJECT_REGISTRY          registry file, default <agent dir>/registers/projects.json
 *   PI_PROJECT_NAME              current project name, default basename of the cwd
 *   PI_PROJECTS_ROOT             optional root of project directories, each with a sessions/ dir
 *   PI_CODING_AGENT_DIR          pi agent dir, default ~/.pi/agent
 *   PI_CODING_AGENT_SESSION_DIR  session directory override
 *
 * Every session start upserts the current project into the registry and prunes
 * entries whose probe path no longer exists (renamed or removed projects).
 */

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { DynamicBorder, getMarkdownTheme } from "@earendil-works/pi-coding-agent";
import type { AutocompleteItem } from "@earendil-works/pi-tui";
import { Container, Markdown, matchesKey, Text } from "@earendil-works/pi-tui";
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";

export type Usage = {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  reasoning?: number;
  totalTokens?: number;
  cost?: {
    input?: number;
    output?: number;
    cacheRead?: number;
    cacheWrite?: number;
    total?: number;
  };
};

type AssistantMessage = {
  role?: string;
  provider?: string;
  model?: string;
  usage?: Usage;
  timestamp?: number;
};

type SessionLine = {
  type?: string;
  timestamp?: string;
  message?: AssistantMessage;
};

export type ModelStats = {
  provider: string;
  model: string;
  requests: number;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  reasoning: number;
  totalTokens: number;
  costInput: number;
  costOutput: number;
  costCacheRead: number;
  costCacheWrite: number;
  costTotal: number;
};

export type ProjectStats = {
  name: string;
  sessionDir: string;
  filesScanned: number;
  filesMatched: number;
  requests: number;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  reasoning: number;
  totalTokens: number;
  costInput: number;
  costOutput: number;
  costCacheRead: number;
  costCacheWrite: number;
  costTotal: number;
  models: Map<string, ModelStats>;
};

export type TimeRange = {
  from?: number;
  to?: number;
  label: string;
  error?: string;
};

export type CliOptions = {
  help: boolean;
  setup: boolean;
  all: boolean;
  project?: string;
  interval?: string;
  days?: number;
  from?: string;
  to?: string;
  combined?: string;
  errors: string[];
};

export type RegistryEntry = {
  name: string;
  root?: string;
  sessionDir: string;
  lastSeen: number;
};

export type ProjectRegistry = {
  version: number;
  updatedAt: number;
  projects: Record<string, RegistryEntry>;
};

export type SetupReport = {
  markdown: string;
  registryCreated: boolean;
  registeredCurrent: boolean;
  pruned: string[];
};

const DAY_MS = 86_400_000;
const MONTH_MS = 30 * DAY_MS;
const REGISTRY_VERSION = 1;
const DEFAULT_DAYS = 30;
const SAFE_PROJECT_NAME = /^[A-Za-z0-9._-]+$/;

/** Parse YYYYMMDD, YYYYMMDDHHMM or YYYYMMDDHHMMSS into a local-time epoch ms. */
export function parseDateTime(text: string): number | undefined {
  const match = text.match(/^(\d{4})(\d{2})(\d{2})(?:(\d{2})(\d{2})(\d{2})?)?$/);
  if (!match) return undefined;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4] ?? "0");
  const minute = Number(match[5] ?? "0");
  const second = Number(match[6] ?? "0");
  if (month < 1 || month > 12 || hour > 23 || minute > 59 || second > 59) return undefined;
  const date = new Date(year, month - 1, day, hour, minute, second);
  if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day) return undefined;
  return date.getTime();
}

/** Parse a compound interval like 1m, 2h40m, 1D, 1W, 1M into ms (m=minute, M=month). */
export function parseInterval(text: string): number | undefined {
  const pattern = /(\d+)\s*([mhdwMDW])/g;
  let total = 0;
  let matched = false;
  for (const match of text.matchAll(pattern)) {
    const value = Number(match[1]);
    switch (match[2]) {
      case "m": total += value * 60_000; break;
      case "h": total += value * 3_600_000; break;
      case "d":
      case "D": total += value * DAY_MS; break;
      case "w":
      case "W": total += value * 7 * DAY_MS; break;
      case "M": total += value * MONTH_MS; break;
    }
    matched = true;
  }
  return matched ? total : undefined;
}

/** Humanize an interval spec for display, e.g. "2h40m" -> "2h 40m". */
export function formatInterval(text: string): string {
  return text.replace(/([mhdwMDW])(?=\d)/g, "$1 ").trim();
}

/** Parse the /tokens argument string into structured options. */
export function parseArgs(args: string | undefined): CliOptions {
  const options: CliOptions = { help: false, setup: false, all: false, errors: [] };
  if (!args) return options;
  const tokens = args.trim().split(/\s+/).filter(Boolean);
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (token === "-h" || token === "--help") {
      options.help = true;
      continue;
    }
    if (token === "--setup") {
      options.setup = true;
      continue;
    }
    if (token === "-a" || token === "--all") {
      options.all = true;
      continue;
    }
    if (token === "-p" || token === "--project") {
      const value = tokens[++i];
      if (value === undefined) {
        options.errors.push(`missing value for ${token}`);
        continue;
      }
      options.project = value;
      continue;
    }
    if (token.startsWith("--project=")) {
      options.project = token.slice("--project=".length);
      continue;
    }
    if (token === "-i" || token === "--interval") {
      const value = tokens[++i];
      if (value === undefined) {
        options.errors.push(`missing value for ${token}`);
        continue;
      }
      options.interval = value;
      continue;
    }
    if (token.startsWith("--interval=")) {
      options.interval = token.slice("--interval=".length);
      continue;
    }
    if (token === "--from") {
      const value = tokens[++i];
      if (value === undefined) {
        options.errors.push(`missing value for ${token}`);
        continue;
      }
      options.from = value;
      continue;
    }
    if (token.startsWith("--from=")) {
      options.from = token.slice("--from=".length);
      continue;
    }
    if (token === "--to") {
      const value = tokens[++i];
      if (value === undefined) {
        options.errors.push(`missing value for ${token}`);
        continue;
      }
      options.to = value;
      continue;
    }
    if (token.startsWith("--to=")) {
      options.to = token.slice("--to=".length);
      continue;
    }
    if (token === "-d" || token === "--days") {
      const value = tokens[++i];
      if (value === undefined) {
        options.errors.push(`missing value for ${token}`);
        continue;
      }
      options.days = Number(value);
      continue;
    }
    if (token.startsWith("--days=")) {
      options.days = Number(token.slice("--days=".length));
      continue;
    }
    if (/^\d+$/.test(token)) {
      options.days = Number(token);
      continue;
    }
    if (/^all$/i.test(token)) {
      options.days = 0;
      continue;
    }
    if (/^\d{8,14}-\d{8,14}$/.test(token)) {
      options.combined = token;
      continue;
    }
    options.errors.push(`unrecognized argument: ${token}`);
  }
  return options;
}

/** Resolve the effective time window from CLI options (default: last 30 days). */
export function resolveRange(options: CliOptions, now = Date.now()): TimeRange {
  if (options.combined) {
    const [startText, endText] = options.combined.split("-");
    const from = parseDateTime(startText);
    const to = parseDateTime(endText);
    if (from === undefined || to === undefined) {
      return { label: "", error: `invalid range "${options.combined}" (expected YYYYMMDD[HHMM[SS]]-YYYYMMDD[HHMM[SS]])` };
    }
    if (to < from) return { label: "", error: `range end precedes start: ${options.combined}` };
    return { from, to, label: `${formatDateTime(from)} ~ ${formatDateTime(to)}` };
  }
  if (options.from !== undefined || options.to !== undefined) {
    const from = options.from !== undefined ? parseDateTime(options.from) : undefined;
    const to = options.to !== undefined ? parseDateTime(options.to) : undefined;
    if (options.from !== undefined && from === undefined) {
      return { label: "", error: `invalid --from "${options.from}" (expected YYYYMMDD[HHMM[SS]])` };
    }
    if (options.to !== undefined && to === undefined) {
      return { label: "", error: `invalid --to "${options.to}" (expected YYYYMMDD[HHMM[SS]])` };
    }
    if (from !== undefined && to !== undefined && to < from) {
      return { label: "", error: "--to precedes --from" };
    }
    const startLabel = from !== undefined ? formatDateTime(from) : "beginning";
    const endLabel = to !== undefined ? formatDateTime(to) : "now";
    return { from, to, label: `${startLabel} ~ ${endLabel}` };
  }
  if (options.interval) {
    const ms = parseInterval(options.interval);
    if (ms === undefined) {
      return { label: "", error: `invalid interval "${options.interval}" (examples: 1m, 2h40m, 1D, 1W, 1M)` };
    }
    return { from: now - ms, to: now, label: `last ${formatInterval(options.interval)}` };
  }
  if (options.days !== undefined) {
    if (!Number.isFinite(options.days) || options.days < 0) {
      return { label: "", error: `invalid days "${options.days}"` };
    }
    if (options.days === 0) return { from: undefined, to: now, label: "all time" };
    return { from: now - options.days * DAY_MS, to: now, label: `last ${options.days} day${options.days === 1 ? "" : "s"}` };
  }
  return { from: now - DEFAULT_DAYS * DAY_MS, to: now, label: `last ${DEFAULT_DAYS} days` };
}

const walkJsonlFiles = (dir: string): string[] => {
  if (!existsSync(dir)) return [];
  const result: string[] = [];
  const stack = [dir];
  while (stack.length > 0) {
    const current = stack.pop()!;
    let entries: string[] = [];
    try {
      entries = readdirSync(current);
    } catch {
      continue;
    }
    for (const entry of entries) {
      const fullPath = join(current, entry);
      let stats;
      try {
        stats = statSync(fullPath);
      } catch {
        continue;
      }
      if (stats.isDirectory()) {
        stack.push(fullPath);
      } else if (stats.isFile() && entry.endsWith(".jsonl")) {
        result.push(fullPath);
      }
    }
  }
  return result;
};

/** First `.jsonl` file under a directory; iterative with early exit. */
const firstJsonlFile = (dir: string): string | undefined => {
  const stack = [dir];
  while (stack.length > 0) {
    const current = stack.pop()!;
    let entries: string[] = [];
    try {
      entries = readdirSync(current);
    } catch {
      continue;
    }
    for (const entry of entries) {
      const fullPath = join(current, entry);
      let stats;
      try {
        stats = statSync(fullPath);
      } catch {
        continue;
      }
      if (stats.isDirectory()) stack.push(fullPath);
      else if (stats.isFile() && entry.endsWith(".jsonl")) return fullPath;
    }
  }
  return undefined;
};

/** Read the first line of a file without loading the rest (session files can be large). */
const readFirstLine = (file: string, maxBytes = 65_536): string | undefined => {
  let descriptor: number | undefined;
  try {
    descriptor = openSync(file, "r");
    const buffer = Buffer.alloc(maxBytes);
    const bytes = readSync(descriptor, buffer, 0, maxBytes, 0);
    const text = buffer.subarray(0, bytes).toString("utf8");
    const newline = text.indexOf("\n");
    return newline === -1 ? text : text.slice(0, newline);
  } catch {
    return undefined;
  } finally {
    if (descriptor !== undefined) {
      try {
        closeSync(descriptor);
      } catch {
        // the descriptor is already gone — nothing left to release
      }
    }
  }
};

/** Derive a project name from a session header's cwd field, when present. */
const sessionProjectName = (file: string): string | undefined => {
  const line = readFirstLine(file);
  if (!line) return undefined;
  try {
    const header = JSON.parse(line) as { type?: string; cwd?: string };
    if (header.type !== "session" || typeof header.cwd !== "string" || header.cwd.length === 0) return undefined;
    return basename(header.cwd);
  } catch {
    return undefined;
  }
};

/** Readable fallback for cwd-encoded session directories such as `--home-user-app--`. */
const trimSessionDirName = (name: string): string => name.replace(/^-+/, "").replace(/-+$/, "");

const addUsage = (stats: ProjectStats, provider: string, model: string, usage: Usage): void => {
  const input = usage.input ?? 0;
  const output = usage.output ?? 0;
  const cacheRead = usage.cacheRead ?? 0;
  const cacheWrite = usage.cacheWrite ?? 0;
  const reasoning = usage.reasoning ?? 0;
  const totalTokens = usage.totalTokens ?? input + output + cacheRead + cacheWrite;
  const costInput = usage.cost?.input ?? 0;
  const costOutput = usage.cost?.output ?? 0;
  const costCacheRead = usage.cost?.cacheRead ?? 0;
  const costCacheWrite = usage.cost?.cacheWrite ?? 0;
  const costTotal = usage.cost?.total ?? costInput + costOutput + costCacheRead + costCacheWrite;

  stats.requests += 1;
  stats.input += input;
  stats.output += output;
  stats.cacheRead += cacheRead;
  stats.cacheWrite += cacheWrite;
  stats.reasoning += reasoning;
  stats.totalTokens += totalTokens;
  stats.costInput += costInput;
  stats.costOutput += costOutput;
  stats.costCacheRead += costCacheRead;
  stats.costCacheWrite += costCacheWrite;
  stats.costTotal += costTotal;

  const key = `${provider}/${model}`;
  let modelStats = stats.models.get(key);
  if (!modelStats) {
    modelStats = {
      provider,
      model,
      requests: 0,
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      reasoning: 0,
      totalTokens: 0,
      costInput: 0,
      costOutput: 0,
      costCacheRead: 0,
      costCacheWrite: 0,
      costTotal: 0,
    };
    stats.models.set(key, modelStats);
  }
  modelStats.requests += 1;
  modelStats.input += input;
  modelStats.output += output;
  modelStats.cacheRead += cacheRead;
  modelStats.cacheWrite += cacheWrite;
  modelStats.reasoning += reasoning;
  modelStats.totalTokens += totalTokens;
  modelStats.costInput += costInput;
  modelStats.costOutput += costOutput;
  modelStats.costCacheRead += costCacheRead;
  modelStats.costCacheWrite += costCacheWrite;
  modelStats.costTotal += costTotal;
};

/** Aggregate assistant-message usage across every .jsonl session under a directory. */
export function collectStats(name: string, sessionDir: string, range: TimeRange): ProjectStats {
  const files = walkJsonlFiles(sessionDir);
  const stats: ProjectStats = {
    name,
    sessionDir,
    filesScanned: files.length,
    filesMatched: 0,
    requests: 0,
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    reasoning: 0,
    totalTokens: 0,
    costInput: 0,
    costOutput: 0,
    costCacheRead: 0,
    costCacheWrite: 0,
    costTotal: 0,
    models: new Map(),
  };
  for (const file of files) {
    let matchedInFile = false;
    let content = "";
    try {
      content = readFileSync(file, "utf8");
    } catch {
      continue;
    }
    for (const rawLine of content.split("\n")) {
      const line = rawLine.trim();
      if (!line) continue;
      let entry: SessionLine;
      try {
        entry = JSON.parse(line) as SessionLine;
      } catch {
        continue;
      }
      if (entry.type !== "message" || entry.message?.role !== "assistant" || !entry.message.usage) continue;
      const timestamp = entry.message.timestamp ?? (entry.timestamp ? Date.parse(entry.timestamp) : undefined);
      if (range.from !== undefined && timestamp !== undefined && timestamp < range.from) continue;
      if (range.to !== undefined && timestamp !== undefined && timestamp > range.to) continue;
      const provider = entry.message.provider ?? "unknown";
      const model = entry.message.model ?? "unknown";
      addUsage(stats, provider, model, entry.message.usage);
      matchedInFile = true;
    }
    if (matchedInFile) stats.filesMatched += 1;
  }
  return stats;
}

/** Combine per-project stats into one aggregate (models merged by provider/model). */
export function sumProjects(projects: ProjectStats[]): ProjectStats {
  const total: ProjectStats = {
    name: "total",
    sessionDir: "",
    filesScanned: 0,
    filesMatched: 0,
    requests: 0,
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    reasoning: 0,
    totalTokens: 0,
    costInput: 0,
    costOutput: 0,
    costCacheRead: 0,
    costCacheWrite: 0,
    costTotal: 0,
    models: new Map(),
  };
  for (const project of projects) {
    total.filesScanned += project.filesScanned;
    total.filesMatched += project.filesMatched;
    total.requests += project.requests;
    total.input += project.input;
    total.output += project.output;
    total.cacheRead += project.cacheRead;
    total.cacheWrite += project.cacheWrite;
    total.reasoning += project.reasoning;
    total.totalTokens += project.totalTokens;
    total.costInput += project.costInput;
    total.costOutput += project.costOutput;
    total.costCacheRead += project.costCacheRead;
    total.costCacheWrite += project.costCacheWrite;
    total.costTotal += project.costTotal;
    for (const [key, model] of project.models) {
      const existing = total.models.get(key);
      if (existing) {
        existing.requests += model.requests;
        existing.input += model.input;
        existing.output += model.output;
        existing.cacheRead += model.cacheRead;
        existing.cacheWrite += model.cacheWrite;
        existing.reasoning += model.reasoning;
        existing.totalTokens += model.totalTokens;
        existing.costInput += model.costInput;
        existing.costOutput += model.costOutput;
        existing.costCacheRead += model.costCacheRead;
        existing.costCacheWrite += model.costCacheWrite;
        existing.costTotal += model.costTotal;
      } else {
        total.models.set(key, { ...model });
      }
    }
  }
  return total;
}

const formatNumber = (value: number): string => new Intl.NumberFormat("en-US").format(Math.round(value));

const formatCost = (value: number): string => {
  if (value >= 1000) return `$${value.toFixed(2)}`;
  if (value >= 1) return `$${value.toFixed(4)}`;
  return `$${value.toFixed(6)}`;
};

const formatDateTime = (value: number): string => {
  const date = new Date(value);
  const pad = (part: number): string => part.toString().padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
};

const tableRow = (cells: Array<string | number>): string => `| ${cells.join(" | ")} |`;

/** Render the full markdown report (overview, per-model, and per-project for --all). */
export function buildMarkdown(projects: ProjectStats[], total: ProjectStats, range: TimeRange, options: CliOptions): string {
  const scopeLabel = options.all
    ? `all projects (${projects.length})`
    : options.project
      ? `project \`${options.project}\``
      : `project \`${projects[0]?.name ?? total.name}\``;
  const sessionLabel = projects.length > 1
    ? `${projects.length} project session dirs`
    : `\`${projects[0]?.sessionDir ?? ""}\``;

  const lines: string[] = [
    "# Pi Token Usage",
    "",
    `- Range: ${range.label}`,
    `- Scope: ${scopeLabel}`,
    `- Session dir${projects.length > 1 ? "s" : ""}: ${sessionLabel}`,
    `- Files scanned: ${formatNumber(total.filesScanned)}, sessions matched: ${formatNumber(total.filesMatched)}`,
    `- Requests: ${formatNumber(total.requests)}`,
    `- Total tokens: ${formatNumber(total.totalTokens)}`,
    `- Total cost: ${formatCost(total.costTotal)}`,
    "",
    "## Overview",
    "",
    tableRow(["Input", "Output", "Cache Read", "Cache Write", "Reasoning", "Total Tokens", "Cost"]),
    tableRow(["---:", "---:", "---:", "---:", "---:", "---:", "---:"]),
    tableRow([
      formatNumber(total.input),
      formatNumber(total.output),
      formatNumber(total.cacheRead),
      formatNumber(total.cacheWrite),
      formatNumber(total.reasoning),
      formatNumber(total.totalTokens),
      formatCost(total.costTotal),
    ]),
    "",
    "## By Model",
    "",
  ];

  const rows = [...total.models.values()].sort((a, b) => b.totalTokens - a.totalTokens);
  if (rows.length === 0) {
    lines.push("No token usage records found in the selected range.");
  } else {
    lines.push(tableRow(["Model", "Requests", "Input", "Output", "Cache Read", "Cache Write", "Reasoning", "Total", "Cost"]));
    lines.push(tableRow(["---", "---:", "---:", "---:", "---:", "---:", "---:", "---:", "---:"]));
    for (const row of rows) {
      lines.push(
        tableRow([
          `\`${row.provider}/${row.model}\``,
          formatNumber(row.requests),
          formatNumber(row.input),
          formatNumber(row.output),
          formatNumber(row.cacheRead),
          formatNumber(row.cacheWrite),
          formatNumber(row.reasoning),
          formatNumber(row.totalTokens),
          formatCost(row.costTotal),
        ]),
      );
    }
  }

  if (projects.length > 1) {
    lines.push("", "## By Project", "");
    lines.push(tableRow(["Project", "Requests", "Total Tokens", "Cost"]));
    lines.push(tableRow(["---", "---:", "---:", "---:"]));
    for (const project of [...projects].sort((a, b) => b.totalTokens - a.totalTokens)) {
      lines.push(tableRow([`\`${project.name}\``, formatNumber(project.requests), formatNumber(project.totalTokens), formatCost(project.costTotal)]));
    }
  }

  if (options.errors.length > 0) {
    lines.push("", "## Warnings", "");
    for (const error of options.errors) lines.push(`- ${error}`);
  }

  return lines.join("\n");
}

const agentDir = (): string => process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");

/** Where pi keeps sessions: PI_CODING_AGENT_SESSION_DIR, else <agent dir>/sessions. */
const sessionsRoot = (): string => process.env.PI_CODING_AGENT_SESSION_DIR ?? join(agentDir(), "sessions");

/** Canonical registry location: PI_PROJECT_REGISTRY, else <agent dir>/registers/projects.json. */
export function registryPath(): string {
  return process.env.PI_PROJECT_REGISTRY ?? join(agentDir(), "registers", "projects.json");
}

export function loadRegistry(): ProjectRegistry {
  try {
    const parsed = JSON.parse(readFileSync(registryPath(), "utf8")) as ProjectRegistry;
    if (parsed && typeof parsed === "object" && parsed.projects && typeof parsed.projects === "object") {
      return parsed;
    }
  } catch {
    // missing or unreadable — start with an empty registry
  }
  return { version: REGISTRY_VERSION, updatedAt: Date.now(), projects: {} };
}

export function saveRegistry(registry: ProjectRegistry): void {
  const path = registryPath();
  registry.updatedAt = Date.now();
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.tmp.${process.pid}`;
  writeFileSync(temporary, JSON.stringify(registry, null, 2) + "\n", "utf8");
  renameSync(temporary, path);
}

export function registerProject(registry: ProjectRegistry, name: string, root: string | undefined, sessionDir: string): void {
  registry.projects[name] = { name, root, sessionDir, lastSeen: Date.now() };
}

/**
 * Drop registry entries whose project is gone. The probe is the project root
 * when known (detects renames/moves, and keeps pre-registered projects whose
 * session dir does not exist yet); entries without a root fall back to the
 * session directory.
 */
export function pruneRegistry(registry: ProjectRegistry): string[] {
  const removed: string[] = [];
  for (const [name, entry] of Object.entries(registry.projects)) {
    const probe = entry.root ?? entry.sessionDir;
    try {
      statSync(probe);
    } catch {
      delete registry.projects[name];
      removed.push(name);
    }
  }
  return removed;
}

/** Discover projects under a root whose children are project directories holding a `sessions/` dir. */
export function discoverFromProjectsRoot(root: string): RegistryEntry[] {
  if (!existsSync(root)) return [];
  const entries: RegistryEntry[] = [];
  for (const name of readdirSync(root)) {
    if (!SAFE_PROJECT_NAME.test(name)) continue;
    const projectRoot = join(root, name);
    const sessionDir = join(projectRoot, "sessions");
    try {
      if (!statSync(sessionDir).isDirectory()) continue;
    } catch {
      continue;
    }
    entries.push({ name, root: projectRoot, sessionDir, lastSeen: Date.now() });
  }
  return entries;
}

/** Discover projects under the standard pi sessions root (`--<cwd>--` directories). */
export function discoverFromSessionsRoot(root: string): RegistryEntry[] {
  if (!existsSync(root)) return [];
  const entries: RegistryEntry[] = [];
  for (const dirName of readdirSync(root)) {
    const sessionDir = join(root, dirName);
    try {
      if (!statSync(sessionDir).isDirectory()) continue;
    } catch {
      continue;
    }
    const file = firstJsonlFile(sessionDir);
    if (!file) continue;
    const name = sessionProjectName(file) ?? trimSessionDirName(dirName);
    if (!name || !SAFE_PROJECT_NAME.test(name)) continue;
    entries.push({ name, sessionDir, lastSeen: Date.now() });
  }
  return entries;
}

/** Filesystem fallback: PI_PROJECTS_ROOT first, then the standard pi sessions root. */
export function discoverProjects(): RegistryEntry[] {
  const found: RegistryEntry[] = [];
  const projectsRoot = process.env.PI_PROJECTS_ROOT;
  if (projectsRoot) found.push(...discoverFromProjectsRoot(projectsRoot));
  found.push(...discoverFromSessionsRoot(sessionsRoot()));
  const unique = new Map<string, RegistryEntry>();
  for (const entry of found) {
    if (!unique.has(entry.name)) unique.set(entry.name, entry);
  }
  return [...unique.values()];
}

const currentProjectName = (cwd: string): string => process.env.PI_PROJECT_NAME || basename(cwd);

/** Resolve a project to its session dir: registry first, then filesystem discovery. */
const resolveProject = (name: string): { name: string; sessionDir: string } | undefined => {
  if (!SAFE_PROJECT_NAME.test(name)) return undefined;
  const registry = loadRegistry();
  const entry = registry.projects[name];
  if (entry) return { name: entry.name, sessionDir: entry.sessionDir };
  const discovered = discoverProjects().find((candidate) => candidate.name === name);
  if (discovered) {
    registerProject(registry, discovered.name, discovered.root, discovered.sessionDir);
    saveRegistry(registry);
    return { name: discovered.name, sessionDir: discovered.sessionDir };
  }
  return undefined;
};

/**
 * Initialize the registry when missing, register the current project, and
 * render the resolved configuration so operators can verify their overrides.
 */
export function setupReport(cwd: string): SetupReport {
  const path = registryPath();
  const registryCreated = !existsSync(path);
  const registry = loadRegistry();
  const knownBefore = new Set(Object.keys(registry.projects));
  const projectName = currentProjectName(cwd);
  registerProject(registry, projectName, cwd, sessionsRoot());
  const pruned = pruneRegistry(registry);
  saveRegistry(registry);
  const registeredCurrent = !knownBefore.has(projectName);

  const projectsRoot = process.env.PI_PROJECTS_ROOT;
  const fromProjectsRoot = projectsRoot ? discoverFromProjectsRoot(projectsRoot) : [];
  const fromSessionsRoot = discoverFromSessionsRoot(sessionsRoot());
  const unregistered = discoverProjects().filter((entry) => !registry.projects[entry.name]);

  const envRows: Array<[string, string, string]> = [
    ["PI_PROJECT_REGISTRY", "Registry file", process.env.PI_PROJECT_REGISTRY ?? "(default)"],
    ["PI_PROJECT_NAME", "Project name override", process.env.PI_PROJECT_NAME ?? "(default: cwd basename)"],
    ["PI_PROJECTS_ROOT", "Discovery root", process.env.PI_PROJECTS_ROOT ?? "(unset)"],
    ["PI_CODING_AGENT_DIR", "pi agent dir", process.env.PI_CODING_AGENT_DIR ?? "(default: ~/.pi/agent)"],
    ["PI_CODING_AGENT_SESSION_DIR", "Session dir override", process.env.PI_CODING_AGENT_SESSION_DIR ?? "(default)"],
  ];

  const lines: string[] = [
    "# token-flex — Setup",
    "",
    "## Resolved configuration",
    "",
    tableRow(["Setting", "Value"]),
    tableRow(["---", "---"]),
    tableRow(["Project name", `\`${projectName}\``]),
    tableRow(["Session dir", `\`${sessionsRoot()}\``]),
    tableRow(["Registry", `\`${path}\` (${registryCreated ? "created now" : "existing"})`]),
    tableRow(["Registry projects", `${Object.keys(registry.projects).length}`]),
    tableRow(["Current project", registeredCurrent ? "registered now" : "already registered"]),
    "",
    "## Environment overrides",
    "",
    tableRow(["Variable", "Meaning", "Value"]),
    tableRow(["---", "---", "---"]),
  ];
  for (const [name, meaning, value] of envRows) {
    lines.push(tableRow([`\`${name}\``, meaning, value === "(default)" || value === "(unset)" || value.startsWith("(default") ? value : `\`${value}\``]));
  }

  lines.push("", "## Discovery", "");
  lines.push(tableRow(["Source", "Location", "Projects"]));
  lines.push(tableRow(["---", "---", "---:"]));
  lines.push(tableRow(["`PI_PROJECTS_ROOT`", projectsRoot ? `\`${projectsRoot}\`` : "(unset)", `${fromProjectsRoot.length}`]));
  lines.push(tableRow(["Standard sessions root", `\`${sessionsRoot()}\``, `${fromSessionsRoot.length}`]));
  lines.push("");
  if (unregistered.length > 0) {
    lines.push(`Discovered but not yet registered: ${unregistered.map((entry) => `\`${entry.name}\``).join(", ")}`);
  } else {
    lines.push("No unregistered projects discovered.");
  }
  if (pruned.length > 0) {
    lines.push("", `Pruned stale entries: ${pruned.map((name) => `\`${name}\``).join(", ")}`);
  }

  lines.push(
    "",
    "## Next steps",
    "",
    "- Launch pi in a project once and it registers itself automatically.",
    "- `-p, --project NAME` targets a specific project; `-a, --all` aggregates every registered project.",
    "- Copy `.env.example` and set the overrides you need, then restart pi.",
  );

  return { markdown: lines.join("\n"), registryCreated, registeredCurrent, pruned };
}

const showMarkdown = async (markdown: string, ctx: ExtensionCommandContext): Promise<void> => {
  if (ctx.mode !== "tui") {
    console.log(markdown);
    return;
  }
  await ctx.ui.custom((_tui, theme, _kb, done) => {
    const container = new Container();
    const border = new DynamicBorder((s: string) => theme.fg("accent", s));
    const mdTheme = getMarkdownTheme();
    container.addChild(border);
    container.addChild(new Text(theme.fg("accent", theme.bold("Pi Token Stats")), 1, 0));
    container.addChild(new Markdown(markdown, 1, 1, mdTheme));
    container.addChild(new Text(theme.fg("dim", "Press Enter or Esc to close"), 1, 0));
    container.addChild(border);
    return {
      render: (width: number) => container.render(width),
      invalidate: () => container.invalidate(),
      handleInput: (data: string) => {
        if (matchesKey(data, "enter") || matchesKey(data, "escape")) done(undefined);
      },
    };
  });
};

const HELP_TEXT = `# token-flex — Help

Usage: \`/tokens [options]\` or \`/token-flex [options]\`

**Scope** (default: current project):
- \`-p, --project NAME\` — aggregate a specific project's sessions
- \`-a, --all\` — aggregate every registered project

**Time range** (default: last 30 days):
- \`-i, --interval SPEC\` — relative window: \`1m\`, \`2h40m\`, \`1D\`, \`1W\`, \`1M\`
- \`-d, --days N\` — last N days (\`0\` or \`all\` = all time)
- \`--from YYYYMMDD[HHMM[SS]]\` — range start
- \`--to YYYYMMDD[HHMM[SS]]\` — range end
- \`FROM-TO\` — combined range, e.g. \`20240101-20240131\` or \`202401011200-202401311800\`

**Configuration:**
- \`--setup\` — show the resolved configuration and initialize the registry
- \`-h, --help\` — show this help

Projects register themselves whenever pi launches in them; the registry is
pruned automatically when a project's probe path no longer exists (renamed or
removed projects).

Overrides: \`PI_PROJECT_REGISTRY\`, \`PI_PROJECT_NAME\`, \`PI_PROJECTS_ROOT\`,
\`PI_CODING_AGENT_DIR\`, \`PI_CODING_AGENT_SESSION_DIR\` — see .env.example.`;

const completions = (): AutocompleteItem[] => {
  const items: AutocompleteItem[] = [
    { value: "setup", label: "setup", description: "Show configuration and initialize the registry" },
    { value: "all", label: "all", description: "All registered projects" },
    { value: "7", label: "7", description: "Last 7 days" },
    { value: "30", label: "30", description: "Last 30 days (default)" },
    { value: "0", label: "0", description: "All time" },
    { value: "1W", label: "1W", description: "Last week" },
    { value: "1M", label: "1M", description: "Last month" },
    { value: "24h", label: "24h", description: "Last 24 hours" },
  ];
  try {
    for (const name of Object.keys(loadRegistry().projects)) {
      items.push({ value: name, label: name, description: "Registered project" });
    }
  } catch {
    // registry unavailable — static completions only
  }
  return items;
};

export default function tokenStatsExtension(pi: ExtensionAPI): void {
  const command = {
    description:
      "Show pi session token/cost usage. Scope: -p/--project NAME, -a/--all. Time: -i/--interval (1m, 2h40m, 1D, 1W, 1M), --from/--to YYYYMMDD[HHMM[SS]], FROM-TO, -d/--days N (0 = all). Config: --setup. Default: current project, last 30 days.",
    getArgumentCompletions: (prefix: string): AutocompleteItem[] | null => {
      const filtered = completions().filter((item) => item.value.startsWith(prefix.trim()));
      return filtered.length > 0 ? filtered : null;
    },
    handler: async (args: string | undefined, ctx: ExtensionCommandContext): Promise<void> => {
      const options = parseArgs(args);
      if (options.help) {
        await showMarkdown(HELP_TEXT, ctx);
        return;
      }
      if (options.setup) {
        await showMarkdown(setupReport(ctx.cwd).markdown, ctx);
        return;
      }
      if (ctx.hasUI) ctx.ui.notify("Collecting token usage...", "info");

      const range = resolveRange(options);
      if (range.error) {
        await showMarkdown(`# Pi Token Usage\n\n**Error:** ${range.error}\n\n${HELP_TEXT}`, ctx);
        return;
      }

      let scopes: Array<{ name: string; sessionDir: string }> = [];
      if (options.all) {
        const registry = loadRegistry();
        const removed = pruneRegistry(registry);
        let changed = removed.length > 0;
        scopes = Object.values(registry.projects).map((entry) => ({ name: entry.name, sessionDir: entry.sessionDir }));
        for (const discovered of discoverProjects()) {
          if (!scopes.some((scope) => scope.name === discovered.name)) {
            scopes.push({ name: discovered.name, sessionDir: discovered.sessionDir });
            registerProject(registry, discovered.name, discovered.root, discovered.sessionDir);
            changed = true;
          }
        }
        if (changed) saveRegistry(registry);
        if (scopes.length === 0) {
          await showMarkdown(
            "# Pi Token Usage\n\nNo projects registered yet. Launch pi in a project at least once, set `PI_PROJECTS_ROOT` for discovery, or use `-p NAME` to target a specific project.",
            ctx,
          );
          return;
        }
      } else if (options.project) {
        const entry = resolveProject(options.project);
        if (!entry) {
          await showMarkdown(
            `# Pi Token Usage\n\n**Error:** unknown project \`${options.project}\`. No session directory found in the registry or through \`PI_PROJECTS_ROOT\` / the standard sessions root. Run \`/tokens --setup\` to inspect the resolved configuration.`,
            ctx,
          );
          return;
        }
        scopes = [entry];
      } else {
        scopes = [{ name: currentProjectName(ctx.cwd), sessionDir: sessionsRoot() }];
      }

      const projects = scopes.map((scope) => collectStats(scope.name, scope.sessionDir, range));
      const total = sumProjects(projects);
      await showMarkdown(buildMarkdown(projects, total, range, options), ctx);
    },
  };

  pi.registerCommand("tokens", command);
  pi.registerCommand("token-flex", command);

  // Self-maintaining project registry: upsert the current project and prune
  // entries whose probe path no longer exists (renamed/removed projects).
  pi.on("session_start", (_event, ctx) => {
    try {
      const name = currentProjectName(ctx.cwd);
      const sessionDir = sessionsRoot();
      if (!name || !sessionDir) return;
      const registry = loadRegistry();
      registerProject(registry, name, ctx.cwd, sessionDir);
      pruneRegistry(registry);
      saveRegistry(registry);
    } catch {
      // registration is best-effort; never break the session
    }
  });
}
