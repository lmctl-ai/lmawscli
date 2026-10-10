/**
 * @fileoverview Hermetic fake `aws` executable for aws2 tests.
 *
 * `createFakeAws()` writes an executable named `aws` into a fresh mkdtemp
 * directory under os.tmpdir(). Every invocation appends one JSON line
 * (argv, selected env, cwd) to a record file, then answers from a scenario
 * file: `sequence[callIndex]` first, then the first `rules` entry whose
 * `match` tokens are all present in argv, then `default`. Paths are baked
 * into the script, so no extra env is needed to locate them.
 */

import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { spyOn } from 'bun:test';
import * as server from '@lmctl-ai/lmts/server';

export interface FakeResponse {
  /** Serialized to stdout with JSON.stringify (wins over `stdout`). */
  json?: unknown;
  stdout?: string;
  stderr?: string;
  exit?: number;
  /** Block inside the fake process (used for deadline tests). */
  sleepMs?: number;
}

export interface FakeRule {
  /** Every token must appear verbatim in argv. */
  match: string[];
  response: FakeResponse;
}

export interface FakeScenario {
  sequence?: FakeResponse[];
  rules?: FakeRule[];
  default?: FakeResponse;
}

export interface RecordedCall {
  argv: string[];
  env: Record<string, string | null>;
  cwd: string;
}

export interface FakeAws {
  root: string;
  binDir: string;
  home: string;
  cwd: string;
  /** Configure the response(s) for subsequent calls and clear the record. */
  setScenario(scenario: FakeScenario): void;
  /** Recorded invocations, in order. */
  calls(): RecordedCall[];
  /** Hermetic environment for a spawned CLI / in-process run. */
  env(extra?: Record<string, string>): Record<string, string>;
  cleanup(): void;
}

const RECORDED_ENV = ['AWS_PAGER', 'AWS_CLI_AUTO_PROMPT', 'AWS_MAX_ATTEMPTS', 'AWS_REGION', 'AWS_PROFILE'];

function fakeScript(recordFile: string, scenarioFile: string): string {
  return `#!${process.execPath}
const fs = require('node:fs');
const argv = process.argv.slice(2);
const recordFile = ${JSON.stringify(recordFile)};
const scenarioFile = ${JSON.stringify(scenarioFile)};

let scenario = {};
try { scenario = JSON.parse(fs.readFileSync(scenarioFile, 'utf8')); } catch {}

// Check explicit rule matching first
let response = undefined;
if (Array.isArray(scenario.rules)) {
  for (const rule of scenario.rules) {
    if (rule.match.every((t) => argv.includes(t))) { response = rule.response; break; }
  }
}

if (!response && argv.includes('--version')) {
  process.stdout.write('aws-cli/2.34.48 Python/3.14.4 Linux/7.0.0-1014-aws exe/aarch64.ubuntu.24\\n');
  process.exitCode = 0;
  return;
}

let index = 0;
try {
  index = fs.readFileSync(recordFile, 'utf8').split('\\n').filter(Boolean).length;
} catch {}
const env = {};
for (const k of ${JSON.stringify(RECORDED_ENV)}) env[k] = k in process.env ? process.env[k] : null;
fs.appendFileSync(recordFile, JSON.stringify({ argv, env, cwd: process.cwd() }) + '\\n');

if (!response && scenario.sequence) {
  response = scenario.sequence[index];
}
response = response || scenario.default || {};
if (response.sleepMs) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, response.sleepMs);
const out = response.json !== undefined ? JSON.stringify(response.json) : (response.stdout || '');
if (out) process.stdout.write(out);
if (response.stderr) process.stderr.write(response.stderr);
process.exitCode = response.exit || 0;
`;
}

export function createFakeAws(): FakeAws {
  const root = mkdtempSync(join(tmpdir(), 'aws2-fake-'));
  const binDir = join(root, 'bin');
  const home = join(root, 'home');
  const cwd = join(root, 'cwd');
  mkdirSync(binDir);
  mkdirSync(home);
  mkdirSync(cwd);
  const recordFile = join(root, 'record.jsonl');
  const scenarioFile = join(root, 'scenario.json');
  const script = join(binDir, 'aws');
  writeFileSync(script, fakeScript(recordFile, scenarioFile));
  chmodSync(script, 0o755);
  writeFileSync(scenarioFile, '{}');

  return {
    root,
    binDir,
    home,
    cwd,
    setScenario(scenario) {
      writeFileSync(scenarioFile, JSON.stringify(scenario));
      rmSync(recordFile, { force: true });
    },
    calls() {
      let text = '';
      try {
        text = readFileSync(recordFile, 'utf8');
      } catch {
        return [];
      }
      return text
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line) as RecordedCall);
    },
    env(extra = {}) {
      return {
        PATH: `${binDir}:${dirname(process.execPath)}`,
        HOME: home,
        AWS_CONFIG_FILE: join(home, 'none'),
        AWS_SHARED_CREDENTIALS_FILE: join(home, 'none'),
        AWS_EC2_METADATA_DISABLED: 'true',
        ...extra,
      };
    },
    cleanup() {
      rmSync(root, { recursive: true, force: true });
    },
  };
}

/**
 * Replace process.env wholesale with `env` (keeps the same object so code
 * reading process.env sees the change); returns a restore function.
 */
export function swapProcessEnv(env: Record<string, string>): () => void {
  const saved = { ...process.env };
  for (const key of Object.keys(process.env)) delete process.env[key];
  Object.assign(process.env, env);
  return () => {
    for (const key of Object.keys(process.env)) delete process.env[key];
    Object.assign(process.env, saved);
  };
}

export interface CliRun {
  code: number;
  stdout: string;
  /** stdout parsed as JSON (undefined when not JSON, e.g. --help text). */
  json: unknown;
}

export type CliConfig = Parameters<typeof server.runCli>[0];

let cliImportCounter = 0;

/**
 * Run `body` with a hermetic env, temp cwd, captured stdout and an
 * intercepted process.exit (resolving `exited`), restoring everything after.
 */
async function withCapturedProcess(
  args: string[],
  env: Record<string, string>,
  cwd: string,
  body: (exited: Promise<number>) => Promise<number>,
): Promise<CliRun> {
  const savedArgv = process.argv;
  const savedExit = process.exit;
  const savedWrite = process.stdout.write;
  const savedCwd = process.cwd();
  const restoreEnv = swapProcessEnv(env);
  const chunks: string[] = [];
  let exitCode = -1;
  try {
    const exited = new Promise<number>((resolve) => {
      process.exit = ((code?: number) => {
        resolve(code ?? 0);
        return undefined as never;
      }) as typeof process.exit;
    });
    process.stdout.write = ((chunk: string | Uint8Array) => {
      chunks.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'));
      return true;
    }) as typeof process.stdout.write;
    process.argv = [process.execPath, 'aws2', ...args];
    process.chdir(cwd);
    exitCode = await body(exited);
  } finally {
    process.stdout.write = savedWrite;
    process.exit = savedExit;
    process.argv = savedArgv;
    process.chdir(savedCwd);
    restoreEnv();
  }
  const stdout = chunks.join('');
  let json: unknown;
  try {
    json = JSON.parse(stdout);
  } catch {
    json = undefined;
  }
  return { code: exitCode, stdout, json };
}

/**
 * Run src/cli.ts in-process (so coverage is attributed) with a hermetic env
 * and temp cwd. cli.ts calls main() at import time and process.exit(code)
 * when done; a fresh module instance is loaded per call via a query string,
 * process.exit is intercepted and stdout is captured.
 */
export function runCliInProcess(args: string[], env: Record<string, string>, cwd: string): Promise<CliRun> {
  return withCapturedProcess(args, env, cwd, async (exited) => {
    cliImportCounter += 1;
    await import(`../../src/cli.ts?run=${cliImportCounter}`);
    return exited;
  });
}

/**
 * Load one fresh src/cli.ts instance and capture the RunnerConfig it hands
 * to runCli (runCli is spied only for that import, then restored), so many
 * ops can be driven through the same module instance with runConfigured().
 */
export async function loadCliConfig(env: Record<string, string>, cwd: string): Promise<CliConfig> {
  let captured: CliConfig | undefined;
  const spy = spyOn(server, 'runCli').mockImplementation((async (config: CliConfig) => {
    captured = config;
    return 0;
  }) as unknown as typeof server.runCli);
  try {
    await withCapturedProcess(['--list'], env, cwd, async (exited) => {
      cliImportCounter += 1;
      await import(`../../src/cli.ts?config=${cliImportCounter}`);
      return exited;
    });
  } finally {
    spy.mockRestore();
  }
  if (!captured) throw new Error('cli.ts did not call runCli');
  return captured;
}

/** Drive the real runCli with a captured config (hermetic env, temp cwd). */
export function runConfigured(
  config: CliConfig,
  args: string[],
  env: Record<string, string>,
  cwd: string,
): Promise<CliRun> {
  return withCapturedProcess(args, env, cwd, () => server.runCli(config, args));
}

/**
 * Create a directory holding an `aws` whose interpreter does not exist, so
 * the spawn itself fails with ENOENT (a PATH without any `aws` yields Bun's
 * "Executable not found" message instead).
 */
export function createBrokenAwsDir(): { dir: string; cleanup(): void } {
  const dir = mkdtempSync(join(tmpdir(), 'aws2-broken-'));
  const script = join(dir, 'aws');
  writeFileSync(script, '#!/nonexistent/aws2-test-interpreter\n');
  chmodSync(script, 0o755);
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}
