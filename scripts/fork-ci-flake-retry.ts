/**
 * Fork-only CI flake retry (jeffscottward/oh-my-pi). Upstream does not ship this file.
 *
 * Problem: some coding-agent suites hold timing-sensitive tests that fail at random on
 * the 4-vCPU GitHub-hosted runners that pull-request CI uses (upstream PR CI fails on the
 * same tests), so a fork pull request rarely gets a green run on its exact commit.
 *
 * Policy: after the pooled runner in `ci-test-ts.ts` has finished every chunk, each test
 * file that failed runs once more, alone, in a fresh `bun test` process with the chunk's
 * own flags and environment. A failed chunk counts as passed only when every file that
 * failed in it exits 0 on this one retry AND the retry's junit report lists every test
 * that failed in that file as passed. The runner never retries what it cannot attribute
 * to test files: crashes, watchdog or OOM kills, errors outside a test, a crashed bun
 * worker, or a fail count that differs from the failures it parsed. A test that fails
 * twice fails the job. Each recovered test becomes a GitHub warning annotation.
 *
 * On by default in GitHub Actions `pull_request` runs. `OMP_TEST_RETRY_FAILED=0` turns it
 * off; `OMP_TEST_RETRY_FAILED=1` turns it on anywhere (local reproduction of CI).
 */
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

/** The part of a runner command the retry needs: where it ran and its argv. */
export interface RetryableCommand {
	label: string;
	cwd: string;
	command: string[];
}

/** The part of a failed chunk outcome the retry needs. */
export interface FailedChunk {
	label: string;
	exitCode: number;
	output: string;
}

/** One test file to run again and the failing tests (`file > describe > test`) it held. */
export interface FileRetry {
	file: string;
	tests: string[];
}

export interface ChunkRetryPlan<T extends FailedChunk> {
	failure: T;
	command: RetryableCommand;
	files: FileRetry[];
}

export interface RetryPlan<T extends FailedChunk> {
	retries: ChunkRetryPlan<T>[];
	skipped: { label: string; reason: string }[];
}

export interface RetryOptions<T extends FailedChunk> {
	failures: T[];
	commands: RetryableCommand[];
	repoRoot: string;
	/** Child environment for the retry; the same one the first attempt used. */
	env: Record<string, string | undefined>;
	/** The runner's own failure parser, so both read bun's output the same way. */
	extractFailingTests: (output: string) => { name: string }[];
	/** The runner's chunk watchdog; a retry gets the smaller of this and RETRY_FILE_TIMEOUT_MS. */
	timeoutMs: number;
	/**
	 * Environment that decides whether the retry is on and whether to annotate. Defaults to
	 * `Bun.env`. It is NOT `env`: the runner's child environment clears `GITHUB_ACTIONS`.
	 */
	parentEnv?: Record<string, string | undefined>;
	log?: (line: string) => void;
	/** Where the retried `bun test` writes: the job log by default; tests silence it. */
	childOutput?: "inherit" | "ignore";
}

/** A failure on more files than this is treated as a real break, not flakes: no file is retried. */
export const MAX_RETRY_FILES = 5;

/**
 * Time limit for one retried file. A single file runs alone, so it needs far less than the
 * 600 s chunk watchdog; 5 files x 180 s keeps the worst case inside the 20-25 minute
 * `timeout-minutes` of the CI test jobs. A retry that hits it stays failed.
 */
export const RETRY_FILE_TIMEOUT_MS = 180_000;

const ANSI_RE = /\x1b\[[0-9;]*m/g;
const TEST_FILE_RE = /\.test\.[cm]?[jt]sx?$/;
const FAIL_COUNT_RE = /^\s*(\d+) fail\s*$/gm;
const ERROR_COUNT_RE = /^\s*(\d+) errors?\s*$/gm;
const UNHANDLED_ERROR_RE = /Unhandled error/;
// A bun `--parallel` worker that dies after a test failed prints this and still exits 1.
const CRASH_RE = /worker crashed|Bun has crashed|panic\(/;
const JUNIT_TESTCASE_RE = /<testcase\b([^>]*?)(\/>|>([\s\S]*?)<\/testcase>)/g;
const XML_ATTR_RE = /([\w:-]+)="([^"]*)"/g;
const XML_ENTITY_RE = /&(?:#(\d+)|#x([0-9a-fA-F]+)|(amp|lt|gt|quot|apos));/g;
const XML_NAMED_ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };

export function retryEnabled(env: Record<string, string | undefined>): boolean {
	const explicit = env.OMP_TEST_RETRY_FAILED?.trim();
	if (explicit === "0") return false;
	if (explicit === "1") return true;
	return env.GITHUB_ACTIONS === "true" && env.GITHUB_EVENT_NAME === "pull_request";
}

/** The test file of a `file > describe > test` name, or undefined when the name has none. */
function testFileOf(name: string): string | undefined {
	const separator = name.indexOf(" > ");
	if (separator < 0) return undefined;
	const file = name.slice(0, separator);
	return TEST_FILE_RE.test(file) ? file : undefined;
}

/**
 * Why a failed chunk must not be retried, or undefined when every failure bun counted is
 * one parsed test in a known file. Bun's summary counts a file that throws at import as a
 * `fail` without a `(fail)` marker and adds an `error` line for errors between tests, so a
 * count mismatch or any error means part of the failure has no file to retry.
 */
export function ineligibleReason(failure: FailedChunk, failingNames: string[]): string | undefined {
	if (failure.exitCode !== 1) return `exit ${failure.exitCode} is not a plain test failure`;
	if (failingNames.length === 0) return "no failing test was attributed";
	if (failingNames.some(name => testFileOf(name) === undefined)) return "a failure is not attributed to a test file";
	const text = failure.output.replace(ANSI_RE, "");
	if (CRASH_RE.test(text)) return "bun reported a crash";
	const failCounts = [...text.matchAll(FAIL_COUNT_RE)].map(match => Number(match[1]));
	if (failCounts.length !== 1 || failCounts[0] !== failingNames.length) {
		return `bun reported ${failCounts.join("+") || "no"} failure(s) but ${failingNames.length} were attributed`;
	}
	const errors = [...text.matchAll(ERROR_COUNT_RE)].reduce((sum, match) => sum + Number(match[1]), 0);
	if (errors > 0 || UNHANDLED_ERROR_RE.test(text)) return "bun reported an error outside a test";
	return undefined;
}

export function planRetries<T extends FailedChunk>(
	failures: T[],
	commands: RetryableCommand[],
	extractFailingTests: (output: string) => { name: string }[],
	maxFiles = MAX_RETRY_FILES,
): RetryPlan<T> {
	const retries: ChunkRetryPlan<T>[] = [];
	const skipped: { label: string; reason: string }[] = [];
	for (const failure of failures) {
		const command = commands.find(candidate => candidate.label === failure.label);
		if (!command) {
			skipped.push({ label: failure.label, reason: "no runner command has this label" });
			continue;
		}
		const names = extractFailingTests(failure.output).map(test => test.name);
		const reason = ineligibleReason(failure, names);
		if (reason) {
			skipped.push({ label: failure.label, reason });
			continue;
		}
		const byFile = new Map<string, string[]>();
		for (const name of names) {
			const file = testFileOf(name) as string;
			byFile.set(file, [...(byFile.get(file) ?? []), name]);
		}
		retries.push({ failure, command, files: [...byFile].map(([file, tests]) => ({ file, tests })) });
	}
	const fileCount = retries.reduce((sum, retry) => sum + retry.files.length, 0);
	if (fileCount > maxFiles) {
		const reason = `${fileCount} failing files exceed the retry limit of ${maxFiles}`;
		return { retries: [], skipped: [...skipped, ...retries.map(retry => ({ label: retry.failure.label, reason }))] };
	}
	return { retries, skipped };
}

/** The chunk's argv with its test-file arguments replaced by the one file to retry. */
export function retryArgv(command: RetryableCommand, file: string): string[] {
	const target = file.startsWith("./") || path.isAbsolute(file) ? file : `./${file}`;
	return [...command.command.filter(arg => !TEST_FILE_RE.test(arg)), target];
}

function decodeXml(value: string): string {
	return value.replace(XML_ENTITY_RE, (_match: string, dec?: string, hex?: string, named?: string) => {
		if (dec) return String.fromCodePoint(Number(dec));
		if (hex) return String.fromCodePoint(Number.parseInt(hex, 16));
		return named ? XML_NAMED_ENTITIES[named] : "";
	});
}

/**
 * The `file > describe > test` names of the tests a bun junit report lists as passed: no
 * `<failure>`, `<error>` or `<skipped>` child. Bun lists a test's describes innermost-first
 * in `classname`, so they are reversed to match the console's `(fail)` naming.
 */
export function passedTestsInJunit(xml: string): Set<string> {
	const passed = new Set<string>();
	for (const [, rawAttributes, , body = ""] of xml.matchAll(JUNIT_TESTCASE_RE)) {
		if (/<(failure|error|skipped)\b/.test(body)) continue;
		const attributes: Record<string, string> = {};
		for (const [, key, value] of rawAttributes.matchAll(XML_ATTR_RE)) attributes[key] = decodeXml(value);
		const describes = attributes.classname ? attributes.classname.split(" > ").reverse() : [];
		passed.add([attributes.file ?? "", ...describes, attributes.name ?? ""].join(" > "));
	}
	return passed;
}

/** Escape a GitHub workflow-command message (`%`, CR and LF). */
function escapeAnnotation(message: string): string {
	return message.replaceAll("%", "%25").replaceAll("\r", "%0D").replaceAll("\n", "%0A");
}

async function runOnce(
	argv: string[],
	cwd: string,
	env: Record<string, string | undefined>,
	timeoutMs: number,
	output: "inherit" | "ignore",
): Promise<{ exitCode: number; timedOut: boolean }> {
	// Inherit stdio: the retry's own output is the evidence in the job log, and no pipe can
	// keep this process waiting on a grandchild (a browser) that outlives the test process.
	const proc = Bun.spawn(argv, { cwd, env, stdout: output, stderr: output });
	let timedOut = false;
	const killTimer = setTimeout(() => {
		timedOut = true;
		proc.kill("SIGKILL");
	}, timeoutMs);
	const exitCode = await proc.exited;
	clearTimeout(killTimer);
	return { exitCode, timedOut };
}

/** Why a retried file does not count as passed, or undefined when it does. */
async function retryVerdict(
	result: { exitCode: number; timedOut: boolean },
	junitPath: string,
	tests: string[],
	timeoutMs: number,
): Promise<string | undefined> {
	if (result.timedOut) return `killed after ${Math.round(timeoutMs / 1000)}s`;
	if (result.exitCode !== 0) return `exit ${result.exitCode}`;
	let xml: string;
	try {
		xml = await Bun.file(junitPath).text();
	} catch {
		return "it wrote no junit report";
	}
	const passed = passedTestsInJunit(xml);
	const missing = tests.filter(test => !passed.has(test));
	return missing.length > 0 ? `its junit report does not list as passed: ${missing.join("; ")}` : undefined;
}

/**
 * Retry the failing test files of `failures` once each and return the chunks that still
 * fail, in their original order. Returns `failures` unchanged when the retry is off or
 * nothing is eligible.
 */
export async function retryFailedTestFiles<T extends FailedChunk>(options: RetryOptions<T>): Promise<T[]> {
	const { failures, parentEnv = Bun.env, log = (line: string) => void process.stdout.write(`${line}\n`) } = options;
	if (failures.length === 0 || !retryEnabled(parentEnv)) return failures;
	const plan = planRetries(failures, options.commands, options.extractFailingTests);
	for (const skip of plan.skipped) {
		log(`↻ fork flake retry: not retrying ${skip.label}: ${skip.reason}`);
	}
	if (plan.retries.length === 0) return failures;
	const fileCount = plan.retries.reduce((sum, retry) => sum + retry.files.length, 0);
	log(`\n↻ fork flake retry: running ${fileCount} failing test file(s) once more, alone, after the pool finished`);

	const annotate = parentEnv.GITHUB_ACTIONS === "true";
	const timeoutMs = Math.min(options.timeoutMs, RETRY_FILE_TIMEOUT_MS);
	const junitDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-flake-retry-"));
	const recovered = new Set<T>();
	try {
		let index = 0;
		for (const retry of plan.retries) {
			let allPassed = true;
			for (const { file, tests } of retry.files) {
				const junitPath = path.join(junitDir, `${index++}.xml`);
				const argv = [...retryArgv(retry.command, file), "--reporter=junit", `--reporter-outfile=${junitPath}`];
				const shown = path.posix.join(retry.command.cwd, file);
				log(`\n==> retry ${shown} (from ${retry.failure.label})`);
				log(`$ ${argv.join(" ")}`);
				const startedAt = performance.now();
				const result = await runOnce(
					argv,
					path.join(options.repoRoot, retry.command.cwd),
					options.env,
					timeoutMs,
					options.childOutput ?? "inherit",
				);
				const seconds = ((performance.now() - startedAt) / 1000).toFixed(1);
				const reason = await retryVerdict(result, junitPath, tests, timeoutMs);
				if (reason === undefined) {
					log(`✓ ${shown} passed when run alone on retry [${seconds}s]; flaky: ${tests.join("; ")}`);
					if (annotate) {
						for (const test of tests) {
							const name = retry.command.cwd === "." ? test : `${retry.command.cwd}/${test}`;
							log(`::warning title=Flaky test passed on retry::${escapeAnnotation(name)}`);
						}
					}
				} else {
					allPassed = false;
					log(`✗ ${shown} failed again on retry (${reason}) [${seconds}s]`);
				}
			}
			if (allPassed) {
				recovered.add(retry.failure);
				log(`✓ ${retry.failure.label}: counted as passed; every failing file passed its one retry`);
			} else {
				log(`✗ ${retry.failure.label}: still failing after retry`);
			}
		}
	} finally {
		await fs.rm(junitDir, { recursive: true, force: true });
	}
	return failures.filter(failure => !recovered.has(failure));
}
