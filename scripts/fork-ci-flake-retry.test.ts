/**
 * Contract: after the pooled CI runner finishes, a chunk that failed only on tests in
 * known files is retried once per file; it counts as passed only when every such file
 * passes, and each recovered test is reported as a GitHub warning. A test that fails
 * twice, or a failure bun cannot pin to a test file (an import error, an error between
 * tests), keeps the chunk failed.
 *
 * If this regresses, either fork PRs stay red on upstream timing flakes, or a real
 * failure is hidden as a flake. Every first attempt here is a real `bun test` run, so
 * the eligibility check reads bun's own summary lines.
 */
import { afterEach, expect, test } from "bun:test";
import { $ } from "bun";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { type FailedChunk, MAX_RETRY_FILES, type RetryableCommand, retryFailedTestFiles } from "./fork-ci-flake-retry";

const tempDirs: string[] = [];

afterEach(async () => {
	await Promise.all(tempDirs.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true })));
});

// Fixture copy of the runner's parser: `file:` headers, then `(fail) name` markers.
function extractFailingTests(output: string): { name: string }[] {
	const failing: { name: string }[] = [];
	let file = "";
	for (const raw of output.split("\n")) {
		const line = raw.replace(/\x1b\[[0-9;]*m/g, "").trim();
		const header = /^(\S.*\.test\.[cm]?[jt]sx?):$/.exec(line);
		if (header) file = header[1];
		const fail = /^\(fail\)\s+(.*?)(?:\s+\[[\d.]+\s*m?s\])?$/.exec(line);
		if (fail) failing.push({ name: file ? `${file} > ${fail[1]}` : fail[1] });
	}
	return failing;
}

const FAILS_ON_FIRST_RUN = `import { expect, test } from "bun:test";
import * as fs from "node:fs";
test("fails on its first run only", () => {
	const marker = \`\${process.env.FLAKE_DIR}/\${import.meta.file}.ran\`;
	const firstRun = !fs.existsSync(marker);
	fs.writeFileSync(marker, "");
	expect(firstRun).toBe(false);
});
`;

const ALWAYS_FAILS = `import { expect, test } from "bun:test";
test("always fails", () => {
	expect(1).toBe(2);
});
`;

const THROWS_AT_IMPORT = `import { test } from "bun:test";
throw new Error("import failed");
test("never runs", () => {});
`;

interface Fixture {
	dir: string;
	env: Record<string, string | undefined>;
	command: RetryableCommand;
	failure: FailedChunk;
}

// Write `files` into a fresh directory and run them as one chunk, the runner's first attempt.
async function failedChunk(files: Record<string, string>): Promise<Fixture> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "fork-flake-retry-"));
	tempDirs.push(dir);
	for (const [name, content] of Object.entries(files)) {
		await Bun.write(path.join(dir, "test", name), content);
	}
	const env = { ...Bun.env, FLAKE_DIR: dir, GITHUB_ACTIONS: "" };
	const command: RetryableCommand = {
		label: "fixture chunk",
		cwd: ".",
		command: ["bun", "test", "--only-failures", ...Object.keys(files).map(name => `test/${name}`)],
	};
	const result = await $`${command.command}`.cwd(dir).env(env).quiet().nothrow();
	const failure = { label: command.label, exitCode: result.exitCode, output: `${result.stdout}${result.stderr}` };
	return { dir, env, command, failure };
}

async function retry(fixture: Fixture, parentEnv: Record<string, string | undefined>) {
	const lines: string[] = [];
	const failures = [fixture.failure];
	const remaining = await retryFailedTestFiles({
		failures,
		commands: [fixture.command],
		env: fixture.env,
		repoRoot: fixture.dir,
		extractFailingTests,
		timeoutMs: 60_000,
		parentEnv,
		log: line => lines.push(line),
		childOutput: "ignore",
	});
	return { remaining, failures, log: lines.join("\n") };
}

test("a chunk whose failing file passes its one retry counts as passed and is annotated as flaky", async () => {
	const fixture = await failedChunk({
		"flaky.test.ts": FAILS_ON_FIRST_RUN,
		"steady.test.ts": `import { test } from "bun:test";\ntest("passes", () => {});\n`,
	});
	expect(fixture.failure.exitCode).toBe(1);

	const { remaining, log } = await retry(fixture, { GITHUB_ACTIONS: "true" });

	expect(remaining).toEqual([]);
	expect(log).toContain(
		"::warning title=Flaky test passed on retry::test/flaky.test.ts > fails on its first run only",
	);
});

test("a test that fails on its retry too keeps the chunk failed", async () => {
	const fixture = await failedChunk({ "flaky.test.ts": FAILS_ON_FIRST_RUN, "broken.test.ts": ALWAYS_FAILS });

	const { remaining, failures, log } = await retry(fixture, { GITHUB_ACTIONS: "true" });

	expect(remaining).toEqual(failures);
	expect(log).toContain("test/broken.test.ts failed again on retry (exit 1)");
	expect(log).not.toContain("::warning title=Flaky test passed on retry::test/broken.test.ts");
});

test("a failure bun cannot pin to a test file is never retried", async () => {
	const fixture = await failedChunk({ "flaky.test.ts": FAILS_ON_FIRST_RUN, "import-error.test.ts": THROWS_AT_IMPORT });

	const { remaining, failures, log } = await retry(fixture, { GITHUB_ACTIONS: "true" });

	expect(remaining).toEqual(failures);
	expect(log).toContain("not retrying fixture chunk");
	expect(log).not.toContain("==> retry");
});

test("a failure across more files than the limit is treated as breakage, not flakes", async () => {
	const files = Object.fromEntries(
		Array.from({ length: MAX_RETRY_FILES + 1 }, (_, index) => [`flaky-${index}.test.ts`, FAILS_ON_FIRST_RUN]),
	);
	const fixture = await failedChunk(files);

	const { remaining, failures, log } = await retry(fixture, { GITHUB_ACTIONS: "true" });

	expect(remaining).toEqual(failures);
	expect(log).toContain(`exceed the retry limit of ${MAX_RETRY_FILES}`);
	expect(log).not.toContain("==> retry");
});

test("outside GitHub Actions the retry is off unless OMP_TEST_RETRY_FAILED=1 turns it on", async () => {
	const fixture = await failedChunk({ "flaky.test.ts": FAILS_ON_FIRST_RUN });

	const off = await retry(fixture, {});
	expect(off.remaining).toEqual(off.failures);
	expect(off.log).toBe("");

	const disabledInCi = await retry(fixture, { GITHUB_ACTIONS: "true", OMP_TEST_RETRY_FAILED: "0" });
	expect(disabledInCi.remaining).toEqual(disabledInCi.failures);

	const on = await retry(fixture, { OMP_TEST_RETRY_FAILED: "1" });
	expect(on.remaining).toEqual([]);
	expect(on.log).not.toContain("::warning");
});
