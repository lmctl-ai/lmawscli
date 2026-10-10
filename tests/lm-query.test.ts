/**
 * @fileoverview src/lm-query.ts + src/aws-catalog.ts against a hermetic fake
 * `aws`: allowlist, request validation, argv (single --cli-input-json entry),
 * redaction, JSON Pointer select, deadline, native pagination tokens and the
 * lmprobe.aws_query.v1 envelope.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';

import { CliError, ErrorCode } from '@lmctl-ai/lmts/server';

import { LM_OPERATIONS, lookupLmOperation, paginationSpecFor } from '../src/aws-catalog.js';
import { lmQuery, type LmQueryInput } from '../src/lm-query.js';
import { createBrokenAwsDir, createFakeAws, swapProcessEnv, type FakeAws, type FakeResponse } from './helpers/fake-aws.js';

let fake: FakeAws;
let restoreEnv: () => void;

beforeAll(() => {
  fake = createFakeAws();
});
afterAll(() => fake.cleanup());
beforeEach(() => {
  restoreEnv = swapProcessEnv(fake.env());
  fake.setScenario({});
});
afterEach(() => restoreEnv());

const FIXED = [
  '--output=json',
  '--no-cli-pager',
  '--no-cli-auto-prompt',
  '--color=off',
  '--cli-connect-timeout=10',
  '--cli-read-timeout=30',
];

async function query(input: LmQueryInput, response: FakeResponse = { json: {} }) {
  fake.setScenario({ default: response });
  return lmQuery(input, fake.cwd);
}

async function rejectCode(input: LmQueryInput, response: FakeResponse = { json: {} }): Promise<CliError> {
  try {
    await query(input, response);
  } catch (error) {
    expect(error).toBeInstanceOf(CliError);
    return error as CliError;
  }
  throw new Error('expected rejection');
}

describe('catalog', () => {
  test('41 reviewed read-only ops, unique, lookup is exact', () => {
    expect(LM_OPERATIONS).toHaveLength(41);
    const keys = LM_OPERATIONS.map((o) => `${o.service} ${o.operation}`);
    expect(new Set(keys).size).toBe(41);
    expect(lookupLmOperation('ec2', 'describe-instances')).toEqual({
      service: 'ec2', operation: 'describe-instances', paginated: true,
    });
    expect(lookupLmOperation('ec2', 'DescribeInstances')).toBeUndefined();
    expect(lookupLmOperation('s3', 'list-buckets')).toBeUndefined();
    expect(lookupLmOperation('ec2', 'terminate-instances')).toBeUndefined();
  });

  test('every paginated op has a reviewed paginator model; non-paginated have none', () => {
    for (const spec of LM_OPERATIONS) {
      const page = paginationSpecFor(spec);
      if (spec.paginated) expect(page).toBeDefined();
      else expect(page).toBeUndefined();
    }
    expect(paginationSpecFor({ service: 'x', operation: 'y', paginated: true })).toBeUndefined();
  });

  test('paginator token names per service model', () => {
    const p = (s: string, o: string) => paginationSpecFor(lookupLmOperation(s, o)!);
    expect(p('ec2', 'describe-vpcs')).toEqual({ inputToken: 'NextToken', outputToken: 'NextToken' });
    expect(p('s3api', 'list-buckets')).toEqual({ inputToken: 'ContinuationToken', outputToken: 'ContinuationToken' });
    expect(p('iam', 'list-roles')).toEqual({ inputToken: 'Marker', outputToken: 'Marker', moreResults: 'IsTruncated' });
    expect(p('lambda', 'list-functions')).toEqual({ inputToken: 'Marker', outputToken: 'NextMarker' });
    expect(p('logs', 'describe-log-streams')).toEqual({ inputToken: 'nextToken', outputToken: 'nextToken' });
    expect(p('rds', 'describe-db-clusters')).toEqual({ inputToken: 'Marker', outputToken: 'Marker' });
    expect(p('dynamodb', 'list-tables')).toEqual({ inputToken: 'ExclusiveStartTableName', outputToken: 'LastEvaluatedTableName' });
  });
});

describe('allowlist and request validation (refused before any spawn)', () => {
  const refused: Array<[string, string]> = [
    ['ec2', 'terminate-instances'],
    ['sts', 'assume-role'],
    ['iam', 'create-access-key'],
    ['secretsmanager', 'get-secret-value'],
    ['s3', 'ls'],
  ];
  for (const [service, operation] of refused) {
    test(`refuses ${service} ${operation}`, async () => {
      const err = await rejectCode({ service, operation });
      expect(err.code).toBe(ErrorCode.InvalidRequest);
      expect(err.message).toContain('AWS_OPERATION_REFUSED');
      expect(err.data).toEqual({ service, operation });
      expect(fake.calls()).toHaveLength(0);
    });
  }

  const invalid: Array<[string, LmQueryInput, string]> = [
    ['array parameters', { service: 'sts', operation: 'get-caller-identity', parameters: [] as unknown as Record<string, unknown> }, 'AWS_PARAMETERS_INVALID'],
    ['null parameters', { service: 'sts', operation: 'get-caller-identity', parameters: null as unknown as Record<string, unknown> }, 'AWS_PARAMETERS_INVALID'],
    ['string parameters', { service: 'sts', operation: 'get-caller-identity', parameters: 'x' as unknown as Record<string, unknown> }, 'AWS_PARAMETERS_INVALID'],
    ['timeout 0', { service: 'sts', operation: 'get-caller-identity', timeoutSeconds: 0 }, 'AWS_TIMEOUT_INVALID'],
    ['timeout 301', { service: 'sts', operation: 'get-caller-identity', timeoutSeconds: 301 }, 'AWS_TIMEOUT_INVALID'],
    ['maxItems 0', { service: 'ec2', operation: 'describe-vpcs', pagination: { maxItems: 0 } }, 'AWS_PAGINATION_INVALID'],
    ['maxItems 10001', { service: 'ec2', operation: 'describe-vpcs', pagination: { maxItems: 10001 } }, 'AWS_PAGINATION_INVALID'],
    ['pageSize 0', { service: 'ec2', operation: 'describe-vpcs', pagination: { pageSize: 0 } }, 'AWS_PAGINATION_INVALID'],
    ['controls on non-paginated', { service: 'sts', operation: 'get-caller-identity', pagination: { maxItems: 5 } }, 'AWS_PAGINATION_UNSUPPORTED'],
    ['token on non-paginated', { service: 'iam', operation: 'get-role', pagination: { startingToken: 't' } }, 'AWS_PAGINATION_UNSUPPORTED'],
    ['firstPage on non-paginated', { service: 'sts', operation: 'get-caller-identity', pagination: { firstPage: true } }, 'AWS_PAGINATION_UNSUPPORTED'],
    ['firstPage + maxItems', { service: 'ec2', operation: 'describe-vpcs', pagination: { firstPage: true, maxItems: 5 } }, 'AWS_PAGINATION_INVALID'],
    ['firstPage + startingToken', { service: 'ec2', operation: 'describe-vpcs', pagination: { firstPage: true, startingToken: 't' } }, 'AWS_PAGINATION_INVALID'],
    ['select not a pointer', { service: 'sts', operation: 'get-caller-identity', select: 'Account' }, 'JSON Pointer'],
    ['select bad escape ~2', { service: 'sts', operation: 'get-caller-identity', select: '/a~2b' }, 'invalid JSON Pointer escape'],
    ['select trailing ~', { service: 'sts', operation: 'get-caller-identity', select: '/a~' }, 'invalid JSON Pointer escape'],
  ];
  for (const [label, input, message] of invalid) {
    test(`rejects ${label}`, async () => {
      const err = await rejectCode(input);
      expect(err.code).toBe(ErrorCode.InvalidRequest);
      expect(err.exitCode).toBe(2);
      expect(err.message).toContain(message);
      expect(fake.calls()).toHaveLength(0);
    });
  }

  test('deadline bounds: 1 and 300 accepted', async () => {
    for (const timeoutSeconds of [1, 300]) {
      const r = await query({ service: 'sts', operation: 'get-caller-identity', timeoutSeconds }, { json: { Account: '1' } });
      expect(r.exitStatus).toBe('matched');
    }
    expect(fake.calls()).toHaveLength(1); // setScenario resets the record per query
  });
});

describe('argv and env', () => {
  test('non-paginated op: fixed flags, parameters as ONE --cli-input-json argv entry, AWS env', async () => {
    const params = { RoleName: 'r; rm -rf / $(whoami) file://etc/passwd', Nested: { a: [1, '--flag'] } };
    await query({ service: 'iam', operation: 'get-role', parameters: params, profile: 'dev', region: 'eu-west-1' });
    const call = fake.calls()[0]!;
    expect(call.argv).toEqual([
      'iam', 'get-role', ...FIXED,
      `--cli-input-json=${JSON.stringify(params)}`,
      '--profile=dev',
      '--region=eu-west-1',
    ]);
    expect(call.env['AWS_PAGER']).toBe('');
    expect(call.env['AWS_CLI_AUTO_PROMPT']).toBe('off');
    expect(call.env['AWS_MAX_ATTEMPTS']).toBe('2');
    expect(call.cwd).toBe(fake.cwd);
  });

  test('paginated op defaults to --max-items=100; pageSize / startingToken passed natively', async () => {
    await query({ service: 'ec2', operation: 'describe-instances' });
    expect(fake.calls()[0]!.argv).toEqual(['ec2', 'describe-instances', ...FIXED, '--cli-input-json={}', '--max-items=100']);
    await query({
      service: 'ec2',
      operation: 'describe-instances',
      pagination: { maxItems: 7, pageSize: 3, startingToken: 'abc==' },
    });
    expect(fake.calls()[0]!.argv).toEqual([
      'ec2', 'describe-instances', ...FIXED, '--cli-input-json={}', '--max-items=7', '--page-size=3', '--starting-token=abc==',
    ]);
  });

  test('firstPage mode uses --no-paginate', async () => {
    await query({ service: 'ec2', operation: 'describe-vpcs', pagination: { firstPage: true } });
    expect(fake.calls()[0]!.argv).toEqual(['ec2', 'describe-vpcs', ...FIXED, '--cli-input-json={}', '--no-paginate']);
  });
});

describe('envelope', () => {
  test('success on a non-paginated op', async () => {
    const r = await query(
      { service: 'sts', operation: 'get-caller-identity', profile: 'p', region: 'r' },
      { json: { Account: '123', Arn: 'arn' } },
    );
    expect(r).toEqual({
      schema: 'lmprobe.aws_query.v1',
      exitStatus: 'matched',
      partial: false,
      complete: true,
      redactions: 0,
      service: 'sts',
      operation: 'get-caller-identity',
      profile: 'p',
      region: 'r',
      data: { Account: '123', Arn: 'arn' },
      page: { tokens: {}, firstPage: false, startedFromToken: false },
      warnings: [],
    });
  });

  test('paginated: NextToken becomes resume token and marks the result partial', async () => {
    const r = await query(
      { service: 'ec2', operation: 'describe-instances', pagination: { startingToken: 'prev' } },
      { json: { Reservations: [{ id: 1 }], NextToken: 'next-1' } },
    );
    expect(r.exitStatus).toBe('matched');
    expect(r.partial).toBe(true);
    expect(r.complete).toBe(false);
    expect(r.page).toEqual({
      tokens: { NextToken: 'next-1' },
      resumeToken: 'next-1',
      nativeInputKey: 'NextToken',
      nativeOutputKey: 'NextToken',
      firstPage: false,
      startedFromToken: true,
      maxItems: 100,
    });
    expect(r.warnings.map((w) => w.code)).toEqual(['AWS_PAGE_INCOMPLETE']);
  });

  test('paginated: empty NextToken is ignored', async () => {
    const r = await query({ service: 'ec2', operation: 'describe-instances' }, { json: { Reservations: [1], NextToken: '' } });
    expect(r.page.tokens).toEqual({});
    expect(r.complete).toBe(true);
  });

  test('empty array result is no_match', async () => {
    const r = await query({ service: 'ec2', operation: 'describe-instances', select: '/Reservations' }, { json: { Reservations: [] } });
    expect(r.exitStatus).toBe('no_match');
    expect(r.data).toEqual([]);
    expect(r.select).toBe('/Reservations');
  });

  test('firstPage with moreResults indicator (s3api list-objects-v2)', async () => {
    const truncated = await query(
      { service: 's3api', operation: 'list-objects-v2', pagination: { firstPage: true } },
      { json: { Contents: [{ Key: 'a' }], IsTruncated: true, NextContinuationToken: 'ct' } },
    );
    expect(truncated.page).toEqual({
      tokens: { NextContinuationToken: 'ct' },
      nativeInputKey: 'ContinuationToken',
      nativeOutputKey: 'NextContinuationToken',
      firstPage: true,
      startedFromToken: false,
    });
    expect(truncated.partial).toBe(true);

    const done = await query(
      { service: 's3api', operation: 'list-objects-v2', pagination: { firstPage: true } },
      { json: { Contents: [], IsTruncated: false, NextContinuationToken: 'stale' } },
    );
    expect(done.page.tokens).toEqual({});
    expect(done.complete).toBe(true);
    expect(done.exitStatus).toBe('matched');

    // indicator true but no token: still incomplete
    const noTok = await query(
      { service: 'iam', operation: 'list-users', pagination: { firstPage: true } },
      { json: { Users: [1], IsTruncated: true } },
    );
    expect(noTok.page.tokens).toEqual({});
    expect(noTok.partial).toBe(true);
    expect(noTok.warnings[0]!.code).toBe('AWS_PAGE_INCOMPLETE');
  });

  test('firstPage without an indicator field (ec2 NextToken, lambda NextMarker)', async () => {
    const ec2 = await query(
      { service: 'ec2', operation: 'describe-vpcs', pagination: { firstPage: true } },
      { json: { Vpcs: [1], NextToken: 'n' } },
    );
    expect(ec2.page.tokens).toEqual({ NextToken: 'n' });
    expect(ec2.page.resumeToken).toBeUndefined();
    const lambda = await query(
      { service: 'lambda', operation: 'list-functions', pagination: { firstPage: true } },
      { json: { Functions: [1], NextMarker: 'm' } },
    );
    expect(lambda.page.tokens).toEqual({ NextMarker: 'm' });
  });

  test('per-resource failures mark the result partial', async () => {
    for (const key of ['failures', 'Failures']) {
      const r = await query(
        { service: 'ecs', operation: 'describe-services' },
        { json: { services: [{ n: 1 }], [key]: [{ arn: 'x', reason: 'MISSING' }] } },
      );
      expect(r.partial).toBe(true);
      expect(r.complete).toBe(false);
      expect(r.awsFailures).toEqual([{ arn: 'x', reason: 'MISSING' }]);
      expect(r.warnings.map((w) => w.code)).toEqual(['AWS_PARTIAL_FAILURE']);
    }
    const ok = await query({ service: 'ecs', operation: 'describe-services' }, { json: { services: [], failures: [] } });
    expect(ok.awsFailures).toBeUndefined();
    expect(ok.complete).toBe(true);
  });

  test('null / scalar JSON bodies are accepted', async () => {
    const r = await query({ service: 'ec2', operation: 'describe-instances' }, { stdout: 'null' });
    expect(r.data).toBeNull();
    expect(r.exitStatus).toBe('matched');
    const n = await query({ service: 'sts', operation: 'get-caller-identity' }, { stdout: '42' });
    expect(n.data).toBe(42);
  });
});

describe('redaction', () => {
  test('Environment fields are redacted recursively, case-insensitively, inside arrays', async () => {
    const body = {
      Functions: [
        { FunctionName: 'f1', Environment: { Variables: { SECRET: 's3cr3t' } } },
        { FunctionName: 'f2', Config: { environment: ['A=1'], Inner: [{ ENVIRONMENT: 'x' }] } },
        { FunctionName: 'f3', Environment: null },
      ],
    };
    const r = await query({ service: 'lambda', operation: 'list-functions' }, { json: body });
    expect(r.data).toEqual({
      Functions: [
        { FunctionName: 'f1', Environment: '[REDACTED]' },
        { FunctionName: 'f2', Config: { environment: '[REDACTED]', Inner: [{ ENVIRONMENT: '[REDACTED]' }] } },
        { FunctionName: 'f3', Environment: null },
      ],
    });
    expect(r.redactions).toBe(3);
    expect(r.warnings.map((w) => w.code)).toEqual(['AWS_VALUES_REDACTED']);
    expect(JSON.stringify(r)).not.toContain('s3cr3t');
  });

  test('select is applied after redaction', async () => {
    const r = await query(
      { service: 'ecs', operation: 'describe-tasks', select: '/tasks/0/overrides' },
      { json: { tasks: [{ overrides: { containerOverrides: [{ environment: [{ name: 'K', value: 'V' }] }] } }] } },
    );
    expect(r.data).toEqual({ containerOverrides: [{ environment: '[REDACTED]' }] });
    expect(r.redactions).toBe(1);
  });
});

describe('select (JSON Pointer)', () => {
  const doc = {
    'a/b': 1,
    'm~n': 2,
    list: [{ x: 'first' }, { x: 'second' }],
    nested: { deep: { v: true } },
    '': 'empty-key',
  };
  const ok: Array<[string, unknown]> = [
    ['', doc],
    ['/a~1b', 1],
    ['/m~0n', 2],
    ['/list/1/x', 'second'],
    ['/nested/deep', { v: true }],
    ['/', 'empty-key'],
  ];
  for (const [pointer, expected] of ok) {
    test(`resolves ${JSON.stringify(pointer)}`, async () => {
      const r = await query({ service: 'dynamodb', operation: 'describe-table', select: pointer }, { json: doc });
      expect(r.data).toEqual(expected);
      expect(r.exitStatus).toBe('matched');
      expect(r.select).toBe(pointer);
    });
  }

  const missing = ['/nope', '/list/2', '/list/-1', '/list/x', '/nested/deep/v/w', '/a~1b/c', '/list/1.5'];
  for (const pointer of missing) {
    test(`missing ${pointer} -> error envelope with AWS_SELECT_NOT_FOUND`, async () => {
      const r = await query({ service: 'dynamodb', operation: 'describe-table', select: pointer, profile: 'p', region: 'r' }, { json: doc });
      expect(r).toEqual({
        schema: 'lmprobe.aws_query.v1',
        exitStatus: 'error',
        partial: false,
        complete: false,
        redactions: 0,
        service: 'dynamodb',
        operation: 'describe-table',
        profile: 'p',
        region: 'r',
        select: pointer,
        data: null,
        page: { tokens: {}, firstPage: false, startedFromToken: false },
        warnings: [{ code: 'AWS_SELECT_NOT_FOUND', message: 'JSON Pointer does not exist in AWS response' }],
      });
    });
  }

  test('missing pointer on a paginated, truncated result keeps page metadata', async () => {
    const r = await query(
      { service: 'iam', operation: 'list-roles', select: '/Nope', pagination: { maxItems: 5 } },
      { json: { Roles: [], Marker: 'mk', IsTruncated: true, NextToken: 'nt' } },
    );
    expect(r.exitStatus).toBe('error');
    expect(r.partial).toBe(true);
    expect(r.page).toEqual({
      tokens: { NextToken: 'nt' },
      resumeToken: 'nt',
      nativeInputKey: 'Marker',
      nativeOutputKey: 'Marker',
      firstPage: false,
      startedFromToken: false,
      maxItems: 5,
    });
    expect(r.warnings.map((w) => w.code)).toEqual(['AWS_PAGE_INCOMPLETE', 'AWS_SELECT_NOT_FOUND']);
  });
});

describe('failures', () => {
  test('non-zero exit -> COMMAND_FAILED with stderr (capped at 2048 chars)', async () => {
    const stderr = 'An error occurred (AccessDenied) when calling the GetRole operation: ' + 'x'.repeat(5000);
    const err = await rejectCode({ service: 'iam', operation: 'get-role' }, { stderr, exit: 254 });
    expect(err.code).toBe(ErrorCode.CommandFailed);
    expect(err.message).toBe('aws exited non-zero: 254');
    expect((err.data?.['stderr'] as string).length).toBe(2048);
    expect(err.data?.['stderr']).toContain('AccessDenied');
  });

  test('expired token / throttling also surface as COMMAND_FAILED', async () => {
    for (const stderr of ['ExpiredToken: token expired', 'ThrottlingException: Rate exceeded']) {
      const err = await rejectCode({ service: 'sts', operation: 'get-caller-identity' }, { stderr, exit: 254 });
      expect(err.code).toBe(ErrorCode.CommandFailed);
      expect(err.data?.['stderr']).toBe(stderr);
    }
  });

  test('invalid / empty JSON on stdout -> PARSE_ERROR', async () => {
    for (const stdout of ['not json', '{"a":', '']) {
      const err = await rejectCode({ service: 'sts', operation: 'get-caller-identity' }, { stdout });
      expect(err.code).toBe(ErrorCode.ParseError);
      expect(err.message).toContain('AWS_CLI_ERROR');
    }
  });

  test('deadline exceeded -> TIMEOUT (fake blocks inside its own process)', async () => {
    const err = await rejectCode(
      { service: 'sts', operation: 'get-caller-identity', timeoutSeconds: 0.05 },
      { sleepMs: 5000, json: {} },
    );
    expect(err.code).toBe(ErrorCode.Timeout);
    expect(err.exitCode).toBe(7);
    expect(err.data).toEqual({ timeoutSeconds: 0.05 });
  });

  test('aws missing (spawn ENOENT) -> COMMAND_NOT_FOUND', async () => {
    const broken = createBrokenAwsDir();
    try {
      restoreEnv();
      restoreEnv = swapProcessEnv({ ...fake.env(), PATH: broken.dir });
      const err = await rejectCode({ service: 'sts', operation: 'get-caller-identity' });
      expect(err.code).toBe(ErrorCode.CommandNotFound);
    } finally {
      broken.cleanup();
    }
  });
});
