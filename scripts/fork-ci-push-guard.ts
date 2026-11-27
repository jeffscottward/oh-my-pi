#!/usr/bin/env bun
/**
 * Fork-only CI push-trigger guard (jeffscottward/oh-my-pi). Upstream does not ship this file.
 *
 * Upstream `.github/workflows/ci.yml` runs non-`pull_request` jobs on self-hosted
 * `vmon-large/from=omp-ci` runners. This public fork has no `vmon` runners, so a `push`
 * to `main` queues 12 jobs until GitHub cancels the run.
 *
 * This guard validates `.github/workflows/ci.yml` structurally with `Bun.YAML.parse`:
 * 1. `on.push` must not trigger any non-hosted job on `main` or on tag pushes.
 * 2. `on.pull_request` must still target `main`, and every PR-reachable job must resolve
 *    its `runs-on` label to a GitHub-hosted runner (`ubuntu-*`, `macos-*`, `windows-*`).
 *
 * Usage: bun scripts/fork-ci-push-guard.ts [workflow-path|-]
 */
import * as path from "node:path";

export interface ValidationResult {
	ok: boolean;
	errors: string[];
}

type WorkflowEvent = "push" | "pull_request";
type YamlMapping = Record<string, unknown>;

interface TriggerFilters {
	branches: string[] | null;
	branchesIgnore: string[] | null;
	tags: string[] | null;
	tagsIgnore: string[] | null;
}

const HOSTED_RUNNER_RE = /^(?:ubuntu|macos|windows)-[a-z0-9.-]+$/i;
const TERNARY_EVENT_RE =
	/^\$\{\{\s*github\.event_name\s*(==|!=)\s*(['"])pull_request\2\s*&&\s*(['"])([^'"]+)\3\s*\|\|\s*(['"])([^'"]+)\5\s*\}\}$/;
const MATRIX_EXPR_RE = /^\$\{\{\s*matrix\.([A-Za-z0-9_-]+)\s*\}\}$/;
const EXCLUDE_PR_IF_RE = /^github\.event_name\s*!=\s*(['"])pull_request\1$/;
const EXCLUDE_PUSH_IF_RE = /^github\.event_name\s*==\s*(['"])pull_request\1$/;
const RELEASE_GATE_IF_RE = /^needs\.release_metadata\.outputs\.is-release\s*==\s*(['"])true\1(?:\s*&&\b|$)/;

function asYamlMapping(value: unknown): YamlMapping | null {
	return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as YamlMapping) : null;
}

/** Match a GitHub Actions ref glob pattern (`**`, `*`, `?`) against a ref name. */
function matchGlob(pattern: string, value: string): boolean {
	let regex = "^";
	let i = 0;
	while (i < pattern.length) {
		if (pattern.startsWith("**/", i)) {
			regex += "(?:.*/)?";
			i += 3;
		} else if (pattern.startsWith("**", i)) {
			regex += ".*";
			i += 2;
		} else if (pattern[i] === "*") {
			regex += "[^/]*";
			i += 1;
		} else if (pattern[i] === "?") {
			regex += "[^/]";
			i += 1;
		} else {
			const ch = pattern[i];
			regex += /[.+^${}()|[\]\\]/.test(ch) ? `\\${ch}` : ch;
			i += 1;
		}
	}
	regex += "$";
	return new RegExp(regex).test(value);
}

/** Evaluate GitHub Actions ordered glob patterns with leading `!` negation. */
function evalOrderedPatterns(patterns: string[], value: string): boolean {
	let matched = false;
	for (const raw of patterns) {
		if (raw.startsWith("!")) {
			if (matchGlob(raw.slice(1), value)) matched = false;
		} else if (matchGlob(raw, value)) {
			matched = true;
		}
	}
	return matched;
}

function parseOnSection(onValue: unknown, errors: string[]): YamlMapping | null {
	if (typeof onValue === "string") {
		return { [onValue]: null };
	}
	if (Array.isArray(onValue)) {
		const map: YamlMapping = {};
		for (const item of onValue) {
			if (typeof item !== "string") {
				errors.push("Workflow 'on' array must contain only event name strings.");
				return null;
			}
			map[item] = null;
		}
		return map;
	}
	const mapping = asYamlMapping(onValue);
	if (mapping) {
		return mapping;
	}
	errors.push("Workflow 'on' section must be a string, string array, or mapping.");
	return null;
}

function normalizeStringList(value: unknown, fieldPath: string, errors: string[]): string[] | null {
	if (typeof value === "string") return [value];
	if (Array.isArray(value)) {
		const out: string[] = [];
		for (const item of value) {
			if (typeof item !== "string") {
				errors.push(`${fieldPath} must contain only strings.`);
				return null;
			}
			out.push(item);
		}
		return out;
	}
	errors.push(`${fieldPath} must be a string or string array.`);
	return null;
}

function parseTriggerFilters(eventName: string, cfg: unknown, errors: string[]): TriggerFilters | null {
	if (cfg === null || cfg === undefined) {
		return { branches: null, branchesIgnore: null, tags: null, tagsIgnore: null };
	}
	const map = asYamlMapping(cfg);
	if (!map) {
		errors.push(`on.${eventName} must be null or a mapping.`);
		return null;
	}

	const hasBranches = "branches" in map && map.branches !== undefined;
	const hasBranchesIgnore = "branches-ignore" in map && map["branches-ignore"] !== undefined;
	const hasTags = "tags" in map && map.tags !== undefined;
	const hasTagsIgnore = "tags-ignore" in map && map["tags-ignore"] !== undefined;

	if (hasBranches && hasBranchesIgnore) {
		errors.push(`on.${eventName} cannot specify both 'branches' and 'branches-ignore'.`);
	}
	if (hasTags && hasTagsIgnore) {
		errors.push(`on.${eventName} cannot specify both 'tags' and 'tags-ignore'.`);
	}

	const branches = hasBranches ? normalizeStringList(map.branches, `on.${eventName}.branches`, errors) : null;
	const branchesIgnore = hasBranchesIgnore
		? normalizeStringList(map["branches-ignore"], `on.${eventName}.branches-ignore`, errors)
		: null;
	const tags = hasTags ? normalizeStringList(map.tags, `on.${eventName}.tags`, errors) : null;
	const tagsIgnore = hasTagsIgnore
		? normalizeStringList(map["tags-ignore"], `on.${eventName}.tags-ignore`, errors)
		: null;

	if ((hasBranches && branches === null) || (hasBranchesIgnore && branchesIgnore === null)) return null;
	if ((hasTags && tags === null) || (hasTagsIgnore && tagsIgnore === null)) return null;

	return { branches, branchesIgnore, tags, tagsIgnore };
}

function matchesBranch(filters: TriggerFilters, branch: string): boolean {
	if (filters.branches !== null) {
		return evalOrderedPatterns(filters.branches, branch);
	}
	if (filters.branchesIgnore !== null) {
		return !evalOrderedPatterns(filters.branchesIgnore, branch);
	}
	if (filters.tags !== null || filters.tagsIgnore !== null) {
		return false;
	}
	return true;
}

function pushCanTriggerTags(filters: TriggerFilters): boolean {
	if (filters.tags !== null) {
		return filters.tags.some(pattern => !pattern.startsWith("!"));
	}
	if (filters.tagsIgnore !== null) {
		const lastWildcard = filters.tagsIgnore.lastIndexOf("**");
		if (lastWildcard === -1) return true;
		return filters.tagsIgnore.slice(lastWildcard + 1).some(p => p.startsWith("!"));
	}
	if (filters.branches !== null || filters.branchesIgnore !== null) {
		return false;
	}
	return true;
}

function unwrapExpression(expr: string): string {
	const trimmed = expr.trim();
	const wrapped = trimmed.match(/^\$\{\{([\s\S]*)\}\}$/);
	return (wrapped ? wrapped[1] : trimmed).replace(/\s+/g, " ").trim();
}

function jobExcludedForEvent(ifValue: unknown, event: WorkflowEvent): boolean {
	if (ifValue === false) return true;
	if (typeof ifValue !== "string") return false;
	const normalized = unwrapExpression(ifValue);
	if (event === "pull_request") {
		return EXCLUDE_PR_IF_RE.test(normalized) || RELEASE_GATE_IF_RE.test(normalized);
	}
	return EXCLUDE_PUSH_IF_RE.test(normalized);
}

function collectMatrixValues(job: YamlMapping, key: string): unknown[] {
	const strategy = asYamlMapping(job.strategy);
	const matrix = strategy ? asYamlMapping(strategy.matrix) : null;
	if (!matrix) return [];
	const values: unknown[] = [];
	if (Array.isArray(matrix[key])) {
		values.push(...matrix[key]);
	}
	if (Array.isArray(matrix.include)) {
		for (const entry of matrix.include) {
			const row = asYamlMapping(entry);
			if (row && key in row) {
				values.push(row[key]);
			}
		}
	}
	return values;
}

function validateJobRunsOn(jobId: string, job: YamlMapping, event: WorkflowEvent, errors: string[]): void {
	const runsOn = job["runs-on"];
	if (runsOn === undefined || runsOn === null) {
		errors.push(`Job '${jobId}' (${event}) is missing 'runs-on'.`);
		return;
	}

	if (typeof runsOn === "string") {
		const trimmed = runsOn.trim();
		if (!trimmed.includes("${{")) {
			if (!HOSTED_RUNNER_RE.test(trimmed)) {
				errors.push(`Job '${jobId}' (${event}) uses non-hosted runner '${trimmed}'.`);
			}
			return;
		}

		const ternary = trimmed.match(TERNARY_EVENT_RE);
		if (ternary) {
			const [, op, , , thenLabel, , elseLabel] = ternary;
			const resolved = (op === "==" ? event === "pull_request" : event !== "pull_request") ? thenLabel : elseLabel;
			if (!HOSTED_RUNNER_RE.test(resolved)) {
				errors.push(`Job '${jobId}' (${event}) resolves 'runs-on' to non-hosted runner '${resolved}'.`);
			}
			return;
		}

		const matrixMatch = trimmed.match(MATRIX_EXPR_RE);
		if (matrixMatch) {
			const key = matrixMatch[1];
			const values = collectMatrixValues(job, key);
			if (values.length === 0) {
				errors.push(`Job '${jobId}' (${event}) references 'matrix.${key}' with no resolvable values.`);
				return;
			}
			for (const value of values) {
				if (typeof value !== "string" || !HOSTED_RUNNER_RE.test(value.trim())) {
					errors.push(`Job '${jobId}' (${event}) matrix.${key} contains non-hosted runner '${String(value)}'.`);
				}
			}
			return;
		}

		errors.push(`Job '${jobId}' (${event}) uses unrecognized 'runs-on' expression '${trimmed}'.`);
		return;
	}

	if (Array.isArray(runsOn)) {
		if (runsOn.length === 0) {
			errors.push(`Job '${jobId}' (${event}) has an empty 'runs-on' array.`);
			return;
		}
		for (const label of runsOn) {
			if (typeof label !== "string" || label.includes("${{") || !HOSTED_RUNNER_RE.test(label.trim())) {
				errors.push(`Job '${jobId}' (${event}) 'runs-on' array includes non-hosted label '${String(label)}'.`);
			}
		}
		return;
	}

	errors.push(`Job '${jobId}' (${event}) uses unsupported non-hosted 'runs-on' configuration.`);
}

export function validateForkCiWorkflow(yamlText: string): ValidationResult {
	const errors: string[] = [];

	let doc: unknown;
	try {
		doc = Bun.YAML.parse(yamlText);
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		return { ok: false, errors: [`Failed to parse workflow YAML: ${message}`] };
	}

	const root = asYamlMapping(doc);
	if (!root) {
		return { ok: false, errors: ["Workflow root must be a YAML mapping."] };
	}

	const onSection = parseOnSection(root.on, errors);
	if (!onSection) {
		return { ok: false, errors };
	}

	const jobs = asYamlMapping(root.jobs);
	if (!jobs || Object.keys(jobs).length === 0) {
		return { ok: false, errors: [...errors, "Workflow must define a non-empty 'jobs' mapping."] };
	}

	const jobEntries: [string, YamlMapping][] = [];
	for (const [jobId, jobVal] of Object.entries(jobs)) {
		const jobMap = asYamlMapping(jobVal);
		if (!jobMap) {
			errors.push(`Job '${jobId}' must be a YAML mapping.`);
			continue;
		}
		jobEntries.push([jobId, jobMap]);
	}

	// 1. Validate `on.push` cannot schedule non-hosted jobs on `main` or tags.
	if ("push" in onSection && onSection.push !== false) {
		const pushFilters = parseTriggerFilters("push", onSection.push, errors);
		if (pushFilters) {
			const triggersMain = matchesBranch(pushFilters, "main");
			const triggersTags = pushCanTriggerTags(pushFilters);
			if (triggersMain || triggersTags) {
				for (const [jobId, job] of jobEntries) {
					if (jobExcludedForEvent(job.if, "push")) continue;
					validateJobRunsOn(jobId, job, "push", errors);
				}
			}
		}
	}

	// 2. Validate `on.pull_request` still targets `main` with GitHub-hosted runners.
	if (!("pull_request" in onSection) || onSection.pull_request === false) {
		errors.push("Workflow must define 'on.pull_request' targeting 'main'.");
	} else {
		const prFilters = parseTriggerFilters("pull_request", onSection.pull_request, errors);
		if (prFilters) {
			if (!matchesBranch(prFilters, "main")) {
				errors.push("Workflow 'on.pull_request' must match branch 'main'.");
			} else {
				for (const [jobId, job] of jobEntries) {
					if (jobExcludedForEvent(job.if, "pull_request")) continue;
					validateJobRunsOn(jobId, job, "pull_request", errors);
				}
			}
		}
	}

	return { ok: errors.length === 0, errors };
}

async function runCli(): Promise<void> {
	const arg = Bun.argv[2];
	const targetLabel =
		arg === "-"
			? "<stdin>"
			: arg
				? path.resolve(arg)
				: path.resolve(import.meta.dir, "..", ".github/workflows/ci.yml");

	let yamlText: string;
	try {
		yamlText = arg === "-" ? await Bun.stdin.text() : await Bun.file(targetLabel).text();
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		console.error(`fork-ci-push-guard: failed to read ${targetLabel}: ${message}`);
		process.exit(1);
	}

	const result = validateForkCiWorkflow(yamlText);
	if (!result.ok) {
		console.error(`fork-ci-push-guard: ${targetLabel} failed (${result.errors.length} error(s)):`);
		for (const err of result.errors) {
			console.error(`  - ${err}`);
		}
		process.exit(1);
	}

	console.log(`fork-ci-push-guard: ${targetLabel} OK`);
}

if (import.meta.main) {
	await runCli();
}
