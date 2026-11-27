#!/usr/bin/env bun
/**
 * Fork-only CI push-trigger guard (jeffscottward/oh-my-pi). Upstream does not ship this file.
 *
 * Upstream `.github/workflows/ci.yml` runs non-`pull_request` jobs on self-hosted
 * `vmon-large/from=omp-ci` runners. This public fork has no `vmon` runners, so a `push`
 * to `main` queues 12 jobs until GitHub cancels the run.
 *
 * This guard validates `.github/workflows/ci.yml` with `Bun.YAML.parse` against the exact
 * fork trigger invariant:
 * 1. `on.push` is absent, OR `on.push` is a mapping with `branches-ignore: ["**"]` and
 *    none of `branches`, `tags`, or `tags-ignore`.
 * 2. `on.pull_request` exists and targets `main` (unfiltered, or `branches` includes `main`
 *    with no `branches-ignore`).
 *
 * Usage: bun scripts/fork-ci-push-guard.ts [workflow-path|-]
 */
import * as path from "node:path";

export interface ValidationResult {
	ok: boolean;
	errors: string[];
}

type YamlMapping = Record<string, unknown>;

function asYamlMapping(value: unknown): YamlMapping | null {
	return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as YamlMapping) : null;
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

function validatePushTrigger(pushValue: unknown, errors: string[]): void {
	const map = asYamlMapping(pushValue);
	if (!map) {
		errors.push('on.push must be absent or a mapping with branches-ignore: ["**"].');
		return;
	}

	const ignored = map["branches-ignore"];
	const ignoresAll = Array.isArray(ignored) && ignored.length === 1 && ignored[0] === "**";
	if (!ignoresAll) {
		errors.push('on.push.branches-ignore must be ["**"] so pushes to main never queue vmon jobs.');
	}

	for (const forbidden of ["branches", "tags", "tags-ignore"] as const) {
		if (forbidden in map && map[forbidden] !== undefined) {
			errors.push(`on.push must not define '${forbidden}' in the fork.`);
		}
	}
}

function validatePullRequestTrigger(prValue: unknown, errors: string[]): void {
	if (prValue === null || prValue === undefined) {
		return;
	}
	const map = asYamlMapping(prValue);
	if (!map) {
		errors.push("on.pull_request must be null or a mapping.");
		return;
	}
	if ("branches-ignore" in map && map["branches-ignore"] !== undefined) {
		errors.push("on.pull_request must not use 'branches-ignore' (use explicit branches including 'main').");
		return;
	}
	if (!("branches" in map) || map.branches === undefined) {
		return;
	}
	const branches = map.branches;
	let includesMain = false;
	if (branches === "main") {
		includesMain = true;
	} else if (Array.isArray(branches)) {
		for (const entry of branches) {
			if (entry === "main") includesMain = true;
			else if (entry === "!main" || entry === "!*" || entry === "!**") includesMain = false;
		}
	}
	if (!includesMain) {
		errors.push("on.pull_request.branches must include 'main'.");
	}
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

	if ("push" in onSection) {
		validatePushTrigger(onSection.push, errors);
	}

	if (!("pull_request" in onSection)) {
		errors.push("Workflow must define 'on.pull_request' targeting 'main'.");
	} else {
		validatePullRequestTrigger(onSection.pull_request, errors);
	}

	return { ok: errors.length === 0, errors };
}

async function runCli(): Promise<void> {
	if (Bun.argv.length > 3) {
		console.error("fork-ci-push-guard: usage: bun scripts/fork-ci-push-guard.ts [workflow-path|-]");
		process.exit(1);
	}
	const arg = Bun.argv[2];
	if (arg !== undefined && arg.trim() === "") {
		console.error("fork-ci-push-guard: workflow path argument must not be empty");
		process.exit(1);
	}
	const targetLabel =
		arg === "-"
			? "<stdin>"
			: arg !== undefined
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
