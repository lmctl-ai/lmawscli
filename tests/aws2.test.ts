/**
 * @fileoverview Tests for aws2: metadata-driven classification, dry-run and
 * read-only policy, argv construction, and live read behavior.
 *
 * Offline sections run against a hermetic fake `aws` (tests/helpers).
 * LIVE sections hit real AWS and only run when explicitly opted in with
 * AWS2_LIVE_TESTS=1 AND `aws sts get-caller-identity` succeeds; otherwise
 * they are skipped (never failed, never hung).
 */

import { spawnSync } from 'node:child_process';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';

import { ErrorCode, isDryRunResult } from '@lmctl-ai/lmts/server';

import { Aws2 } from '../src/api.js';
import { classifyOperation, toKebabOp } from '../src/metadata.js';
import { createFakeAws, swapProcessEnv, type FakeAws } from './helpers/fake-aws.js';

const LIVE_OPT_IN = process.env['AWS2_LIVE_TESTS'] === '1';

const hasAwsCredentials = (() => {
  if (!LIVE_OPT_IN) return false;
  try {
    const r = spawnSync('aws', ['sts', 'get-caller-identity', '--output', 'json'], {
      encoding: 'utf-8',
      timeout: 15000,
      env: { ...process.env, AWS_PAGER: '' },
    });
    return r.status === 0;
  } catch {
    return false;
  }
})();

// Offline tests: route any accidental aws spawn to the fake.
let fake: FakeAws;
let restoreEnv: (() => void) | undefined;
beforeAll(() => {
  fake = createFakeAws();
});
afterAll(() => fake.cleanup());
function useFakeEnv(): void {
  beforeEach(() => {
    restoreEnv = swapProcessEnv(fake.env());
    fake.setScenario({});
  });
  afterEach(() => {
    restoreEnv?.();
    restoreEnv = undefined;
  });
}

describe('metadata: read/write classification', () => {
  test('known read ops classify as read (s3api aliases to s3 metadata)', () => {
    expect(classifyOperation('s3', 'list-buckets')).toBe('read');
    expect(classifyOperation('s3api', 'list-buckets')).toBe('read');
    expect(classifyOperation('ec2', 'describe-instances')).toBe('read');
    expect(classifyOperation('sts', 'get-caller-identity')).toBe('read');
    expect(classifyOperation('logs', 'describe-log-groups')).toBe('read');
  });

  test('known write ops classify as write', () => {
    expect(classifyOperation('s3api', 'delete-bucket')).toBe('write');
    expect(classifyOperation('ec2', 'terminate-instances')).toBe('write');
    expect(classifyOperation('lambda', 'create-function')).toBe('write');
  });

  test('awslabs OVERRIDES applied: credential-issuing "gets" are writes', () => {
    expect(classifyOperation('sts', 'assume-role')).toBe('write');
    expect(classifyOperation('sts', 'get-session-token')).toBe('write');
    expect(classifyOperation('iam', 'create-access-key')).toBe('write');
    expect(classifyOperation('sso', 'get-role-credentials')).toBe('write');
  });

  test('custom read-only ops (awslabs hand-tuned)', () => {
    expect(classifyOperation('s3', 'ls')).toBe('read');
    expect(classifyOperation('s3', 'presign')).toBe('read');
    expect(classifyOperation('ecr', 'get-login-password')).toBe('read');
  });

  test('unknown service/op returns undefined (default write fallback)', () => {
    expect(classifyOperation('not-a-service', 'anything')).toBeUndefined();
    expect(classifyOperation('ec2', 'not-an-op')).toBeUndefined();
  });

  test('toKebabOp handles PascalCase and kebab', () => {
    expect(toKebabOp('GetCallerIdentity')).toBe('get-caller-identity');
    expect(toKebabOp('describe-instances')).toBe('describe-instances');
  });
});

describe('policy: dry-run', () => {
  useFakeEnv();
  test('write ops are simulated, include resolved argv, and never run', async () => {
    const aws = new Aws2({ policy: { dryRun: true } });
    const result = await aws.run('ec2', 'terminate-instances', ['--instance-ids', 'i-xxx']);
    expect(isDryRunResult(result)).toBe(true);
    const command = (result as { command?: string[] }).command;
    expect(command?.[0]).toBe('aws');
    expect(command).toContain('terminate-instances');
    expect(command).toContain('i-xxx');
    expect(command).toContain('--output');
  });

  test('unknown ops default to write (fail-safe)', async () => {
    const aws = new Aws2({ policy: { dryRun: true } });
    const result = await aws.run('aws', 'made-up-op', []);
    expect(isDryRunResult(result)).toBe(true);
    expect((result as { command?: string[] }).command).toBeDefined();
  });
});

describe('policy: read-only', () => {
  useFakeEnv();
  test('write ops throw ReadOnlyViolation', async () => {
    const aws = new Aws2({ policy: { readOnly: true } });
    await expect(aws.run('s3api', 'delete-bucket', ['--bucket', 'x'])).rejects.toMatchObject({
      code: ErrorCode.ReadOnlyViolation,
    });
  });

  test('s3PutObject refuses in read-only with the resolved argv', async () => {
    const aws = new Aws2({ policy: { readOnly: true } });
    try {
      await aws.s3PutObject({ bucket: 'x', key: 'y', body: '/tmp/f' });
      throw new Error('should have thrown');
    } catch (error) {
      const err = error as { code: string; data?: { command?: string[] } };
      expect(err.code).toBe(ErrorCode.ReadOnlyViolation);
      expect(err.data?.command).toContain('put-object');
    }
  });
});

describe('Phase 2: destructive ops require --confirm', () => {
  useFakeEnv();
  const dangerous = [
    () => new Aws2().run('ec2', 'terminate-instances', ['--instance-ids', 'i-xxx']),
    () => new Aws2().dynamodbDeleteTable({ tableName: 't' }),
    () => new Aws2().cfnDeleteStack({ stackName: 't' }),
  ];

  for (const [i, makeCall] of dangerous.entries()) {
    test(`dangerous op ${i + 1} blocked without confirm`, async () => {
      await expect(makeCall()).rejects.toMatchObject({
        code: ErrorCode.MissingConfirmation,
      });
    });
  }

  test('confirm allows through (dry-run so nothing actually executes)', async () => {
    const aws = new Aws2({ policy: { dryRun: true } });
    const result = await aws.run('ec2', 'terminate-instances', ['--instance-ids', 'i-xxx'], {
      confirmed: true,
    });
    expect(isDryRunResult(result)).toBe(true);
    expect((result as { command?: string[] }).command).toContain('terminate-instances');
  });

  test('no aws process was spawned by refused / simulated calls', async () => {
    await new Aws2({ cwd: fake.cwd, policy: { dryRun: true } }).run('ec2', 'terminate-instances', [], { confirmed: true });
    await expect(new Aws2({ cwd: fake.cwd }).run('ec2', 'terminate-instances')).rejects.toMatchObject({
      code: ErrorCode.MissingConfirmation,
    });
    expect(fake.calls()).toHaveLength(0);
  });

  test('non-destructive writes do not require confirm', async () => {
    const aws = new Aws2({ policy: { dryRun: true } });
    const result = await aws.ec2StopInstances({ instanceIds: ['i-xxx'] });
    expect(isDryRunResult(result)).toBe(true);
  });
});

describe('Phase 2: --query passthrough', () => {
  useFakeEnv();
  test('dryrun result includes the query in the resolved argv', async () => {
    const aws = new Aws2({ policy: { dryRun: true } });
    const result = await aws.run('ec2', 'stop-instances', [], {
      query: 'Reservations[].Instances[].InstanceId',
    });
    expect(isDryRunResult(result)).toBe(true);
    expect((result as { command?: string[] }).command).toContain('--query');
    expect((result as { command?: string[] }).command).toContain(
      'Reservations[].Instances[].InstanceId',
    );
  });
});

describe.skipIf(!hasAwsCredentials)('LIVE Phase 2: pagination (AWS2_LIVE_TESTS=1)', () => {
  test('maxPages 1 returns plain response (no _pagination envelope)', async () => {
    const aws = new Aws2();
    const result = (await aws.run('ecs', 'list-clusters', [], { maxPages: 1 })) as Record<
      string,
      unknown
    >;
    expect(result['_pagination']).toBeUndefined();
    expect(result['clusterArns']).toBeDefined();
  });

  test('maxPages > 1 returns _pagination envelope', async () => {
    const aws = new Aws2({ policy: { readOnly: true } });
    const result = (await aws.run('dynamodb', 'list-tables', [], { maxPages: 3 })) as Record<
      string,
      unknown
    >;
    const pagination = result['_pagination'] as { pages: number; maxPages: number };
    expect(pagination).toBeDefined();
    expect(pagination.pages).toBeGreaterThanOrEqual(1);
    expect(pagination.pages).toBeLessThanOrEqual(3);
  });
});

describe.skipIf(!hasAwsCredentials)('LIVE reads (AWS2_LIVE_TESTS=1 and credentials)', () => {
  test('getCallerIdentity returns account info', async () => {
    const aws = new Aws2();
    const result = (await aws.getCallerIdentity()) as { Account?: string; Arn?: string };
    expect(result.Account).toBeDefined();
    expect(result.Arn).toBeDefined();
  });

  test('s3_list_buckets returns an array (readonly mode allows reads)', async () => {
    const aws = new Aws2({ policy: { readOnly: true } });
    const result = (await aws.s3ListBuckets()) as { buckets: Array<{ name?: string }> };
    expect(Array.isArray(result.buckets)).toBe(true);
    expect(result.buckets.length).toBeGreaterThan(0);
  });

  test('dry-run reads still execute', async () => {
    const aws = new Aws2({ policy: { dryRun: true, readOnly: true } });
    const result = (await aws.getCallerIdentity()) as { Account?: string };
    expect(result.Account).toBeDefined();
  });
});
