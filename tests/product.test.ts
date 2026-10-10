/**
 * @fileoverview Hermetic tests for product compatibility checking in aws2.
 * Verifies that aws2 enforces its product range (aws >=2.34.0 <3.0.0),
 * accepts tested versions, rejects incompatible/missing binaries with exit 10,
 * runs --schema/--list/--help unconditionally, and caches version detection.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const REPO_ROOT = resolve(import.meta.dir, '..');
const CLI_PATH = resolve(REPO_ROOT, 'src/cli.ts');

const REAL_AWS_VERSION_OUTPUT = 'aws-cli/2.34.48 Python/3.14.4 Linux/7.0.0-1014-aws exe/aarch64.ubuntu.24\n';
const AWS_PATTERN = 'aws-cli/(\\d+\\.\\d+\\.\\d+)';
const SUPPORTED_RANGE = '>=2.34.0 <3.0.0';

describe('aws2 product compatibility', () => {
  let tempBinDir: string;
  let counterFile: string;

  beforeEach(() => {
    tempBinDir = mkdtempSync(join(tmpdir(), 'aws2-product-test-'));
    counterFile = join(tempBinDir, 'call-count.txt');
  });

  afterEach(() => {
    rmSync(tempBinDir, { recursive: true, force: true });
  });

  function createFakeAws(output: string, exitCode = 0, trackCount = false) {
    const awsPath = join(tempBinDir, 'aws');
    const countSnippet = trackCount ? `echo "call" >> "${counterFile}"` : '';
    const script = `#!/bin/sh
if [ "$1" = "--version" ]; then
  ${countSnippet}
  cat <<'EOF'
${output}
EOF
  exit ${exitCode}
fi

# Fallback JSON output for any other aws command
echo '{"Buckets":[]}'
exit 0
`;
    writeFileSync(awsPath, script);
    chmodSync(awsPath, 0o755);
  }

  function runAws2(args: string[], extraEnv: Record<string, string> = {}) {
    return spawnSync(process.execPath, [CLI_PATH, ...args], {
      cwd: REPO_ROOT,
      encoding: 'utf-8',
      env: {
        ...process.env,
        PATH: `${tempBinDir}:/usr/bin:/bin`,
        ...extraEnv,
      },
    });
  }

  test('verified: REAL aws --version output matches pattern and satisfies range', () => {
    const match = REAL_AWS_VERSION_OUTPUT.match(new RegExp(AWS_PATTERN));
    expect(match).not.toBeNull();
    expect(match![1]).toBe('2.34.48');

    createFakeAws(REAL_AWS_VERSION_OUTPUT);
    const proc = runAws2(['s3_list_buckets']);
    expect(proc.status).toBe(0);
  });

  test('supported version (>=2.34.0 <3.0.0) allows operation to run', () => {
    createFakeAws('aws-cli/2.35.0 Python/3.14.4 Linux/7.0.0-1014-aws exe/aarch64.ubuntu.24\n');
    const proc = runAws2(['s3_list_buckets']);
    expect(proc.status).toBe(0);
  });

  test('too old version (<2.34.0) refuses operation with exit 10 and UNSUPPORTED_PRODUCT_VERSION', () => {
    createFakeAws('aws-cli/2.33.0 Python/3.14.4 Linux/7.0.0-1014-aws exe/aarch64.ubuntu.24\n');
    const proc = runAws2(['s3_list_buckets']);
    expect(proc.status).toBe(10);

    const payload = JSON.parse(proc.stdout);
    expect(payload.success).toBe(false);
    expect(payload.error.code).toBe('UNSUPPORTED_PRODUCT_VERSION');
    expect(payload.error.data).toEqual({
      product: 'aws',
      found: '2.33.0',
      supported: SUPPORTED_RANGE,
    });
  });

  test('too new version (>=3.0.0) refuses operation with exit 10 and UNSUPPORTED_PRODUCT_VERSION', () => {
    createFakeAws('aws-cli/3.0.0 Python/3.14.4 Linux/7.0.0-1014-aws exe/aarch64.ubuntu.24\n');
    const proc = runAws2(['s3_list_buckets']);
    expect(proc.status).toBe(10);

    const payload = JSON.parse(proc.stdout);
    expect(payload.success).toBe(false);
    expect(payload.error.code).toBe('UNSUPPORTED_PRODUCT_VERSION');
    expect(payload.error.data).toEqual({
      product: 'aws',
      found: '3.0.0',
      supported: SUPPORTED_RANGE,
    });
  });

  test('garbage/unparseable output refuses operation with exit 10 and found: null', () => {
    createFakeAws('aws-cli/unknown-string-without-semver\n');
    const proc = runAws2(['s3_list_buckets']);
    expect(proc.status).toBe(10);

    const payload = JSON.parse(proc.stdout);
    expect(payload.success).toBe(false);
    expect(payload.error.code).toBe('UNSUPPORTED_PRODUCT_VERSION');
    expect(payload.error.data).toEqual({
      product: 'aws',
      found: null,
      supported: SUPPORTED_RANGE,
    });
  });

  test('missing aws binary on isolated PATH refuses operation with exit 10 and found: null', () => {
    // Isolated PATH containing only an empty directory
    const proc = spawnSync(process.execPath, [CLI_PATH, 's3_list_buckets'], {
      cwd: REPO_ROOT,
      encoding: 'utf-8',
      env: {
        ...process.env,
        PATH: tempBinDir, // no aws binary in here
      },
    });

    expect(proc.status).toBe(10);
    const payload = JSON.parse(proc.stdout);
    expect(payload.success).toBe(false);
    expect(payload.error.code).toBe('UNSUPPORTED_PRODUCT_VERSION');
    expect(payload.error.data).toEqual({
      product: 'aws',
      found: null,
      supported: SUPPORTED_RANGE,
    });
  });

  test('--schema, --list, and --help succeed regardless of product version check', () => {
    // Set up an incompatible aws version that would fail any operation
    createFakeAws('aws-cli/1.18.0\n');

    const schemaProc = runAws2(['--schema']);
    expect(schemaProc.status).toBe(0);
    const schemaDoc = JSON.parse(schemaProc.stdout);
    expect(schemaDoc.tool).toBe('aws2');
    expect(schemaDoc.product).toBeDefined();
    expect(schemaDoc.product.name).toBe('aws');
    expect(schemaDoc.product.supported).toBe(SUPPORTED_RANGE);

    const listProc = runAws2(['--list']);
    expect(listProc.status).toBe(0);
    expect(listProc.stdout).toContain('s3_list_buckets');

    const helpProc = runAws2(['--help']);
    expect(helpProc.status).toBe(0);
    expect(helpProc.stdout).toContain('Structured AWS CLI wrapper');
  });

  test('version detection command is spawned only once per process', () => {
    createFakeAws(REAL_AWS_VERSION_OUTPUT, 0, true);

    const productJson = JSON.stringify({
      name: 'aws',
      supported: SUPPORTED_RANGE,
      detect: {
        argv: ['aws', '--version'],
        pattern: AWS_PATTERN,
      },
    });

    const testScript = `
import { checkProductVersion } from '@lmctl-ai/lmts/server';
const product = ${productJson};
const res1 = await checkProductVersion(product);
const res2 = await checkProductVersion(product);
if (!res1.ok || !res2.ok) {
  console.error('res1:', res1, 'res2:', res2);
  process.exit(1);
}
process.exit(0);
`;
    const res = spawnSync(process.execPath, ['-e', testScript], {
      cwd: REPO_ROOT,
      encoding: 'utf-8',
      env: {
        ...process.env,
        PATH: `${tempBinDir}:/usr/bin:/bin`,
      },
    });

    expect(res.status).toBe(0);
    const countData = readFileSync(counterFile, 'utf-8');
    const count = countData.trim().split('\n').filter(Boolean).length;
    expect(count).toBe(1);
  });
});
