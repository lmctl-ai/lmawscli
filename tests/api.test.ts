/**
 * @fileoverview Aws2 (src/api.ts) against a hermetic fake `aws`: exact argv for
 * every curated op, response parsing, success envelopes for empty bodies,
 * policy (dry-run / read-only / dangerous+confirm), run/exec pass-through.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';

import { CliError, ErrorCode, isDryRunResult, type Policy } from '@lmctl-ai/lmts/server';

import { Aws2, type Aws2Options } from '../src/api.js';
import { createFakeAws, swapProcessEnv, type FakeAws } from './helpers/fake-aws.js';

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

function aws(options: Aws2Options = {}): Aws2 {
  return new Aws2({ cwd: fake.cwd, ...options });
}

async function catchErr(p: Promise<unknown>): Promise<CliError> {
  try {
    await p;
  } catch (error) {
    expect(error).toBeInstanceOf(CliError);
    return error as CliError;
  }
  throw new Error('expected rejection');
}

const J = ['--output', 'json'];

interface Case {
  name: string;
  call: (a: Aws2) => Promise<unknown>;
  argv: string[];
  access: 'read' | 'write';
  dangerous?: boolean;
  /** Raw text output (execAwsText): result is the trimmed stdout string. */
  text?: boolean;
}

const CASES: Case[] = [
  { name: 'getCallerIdentity', call: (a) => a.getCallerIdentity(), argv: ['sts', 'get-caller-identity', ...J], access: 'read' },
  { name: 's3ListObjects', call: (a) => a.s3ListObjects({ bucket: 'b' }), argv: ['s3api', 'list-objects-v2', '--bucket', 'b', ...J], access: 'read' },
  { name: 's3ListObjects+prefix', call: (a) => a.s3ListObjects({ bucket: 'b', prefix: 'p/' }), argv: ['s3api', 'list-objects-v2', '--bucket', 'b', '--prefix', 'p/', ...J], access: 'read' },
  { name: 's3PutObject', call: (a) => a.s3PutObject({ bucket: 'b', key: 'k', body: '/tmp/f' }), argv: ['s3api', 'put-object', '--bucket', 'b', '--key', 'k', '--body', '/tmp/f', ...J], access: 'write' },
  { name: 's3GetObject', call: (a) => a.s3GetObject({ bucket: 'b', key: 'k' }), argv: ['s3api', 'get-object', '--bucket', 'b', '--key', 'k', '/dev/stdout', ...J], access: 'read', text: true },
  { name: 'ec2DescribeInstances', call: (a) => a.ec2DescribeInstances(), argv: ['ec2', 'describe-instances', ...J], access: 'read' },
  { name: 'ec2DescribeInstances+opts', call: (a) => a.ec2DescribeInstances({ filters: 'Name=x,Values=y', maxResults: 5 }), argv: ['ec2', 'describe-instances', '--filters', 'Name=x,Values=y', '--max-results', '5', ...J], access: 'read' },
  { name: 'ec2StopInstances', call: (a) => a.ec2StopInstances({ instanceIds: ['i-1', 'i-2'] }), argv: ['ec2', 'stop-instances', '--instance-ids', 'i-1', 'i-2', ...J], access: 'write' },
  { name: 'ec2StartInstances', call: (a) => a.ec2StartInstances({ instanceIds: ['i-1'] }), argv: ['ec2', 'start-instances', '--instance-ids', 'i-1', ...J], access: 'write' },
  { name: 'ec2RebootInstances', call: (a) => a.ec2RebootInstances({ instanceIds: ['i-1'] }), argv: ['ec2', 'reboot-instances', '--instance-ids', 'i-1', ...J], access: 'write' },
  { name: 'iamListRoles', call: (a) => a.iamListRoles(), argv: ['iam', 'list-roles', ...J], access: 'read' },
  { name: 'iamListRoles+opts', call: (a) => a.iamListRoles({ maxItems: 3, pathPrefix: '/svc/' }), argv: ['iam', 'list-roles', '--max-items', '3', '--path-prefix', '/svc/', ...J], access: 'read' },
  { name: 'iamListUsers', call: (a) => a.iamListUsers(), argv: ['iam', 'list-users', ...J], access: 'read' },
  { name: 'iamListUsers+opts', call: (a) => a.iamListUsers({ maxItems: 2 }), argv: ['iam', 'list-users', '--max-items', '2', ...J], access: 'read' },
  { name: 'iamListPolicies', call: (a) => a.iamListPolicies(), argv: ['iam', 'list-policies', ...J], access: 'read' },
  { name: 'iamListPolicies+opts', call: (a) => a.iamListPolicies({ scope: 'Local', maxItems: 9 }), argv: ['iam', 'list-policies', '--scope', 'Local', '--max-items', '9', ...J], access: 'read' },
  { name: 'lambdaListFunctions', call: (a) => a.lambdaListFunctions(), argv: ['lambda', 'list-functions', ...J], access: 'read' },
  { name: 'lambdaListFunctions+opts', call: (a) => a.lambdaListFunctions({ maxItems: 4 }), argv: ['lambda', 'list-functions', '--max-items', '4', ...J], access: 'read' },
  { name: 'lambdaInvoke', call: (a) => a.lambdaInvoke({ functionName: 'fn' }), argv: ['lambda', 'invoke', '--function-name', 'fn', '/dev/stdout', ...J], access: 'write', text: true },
  { name: 'lambdaInvoke+payload', call: (a) => a.lambdaInvoke({ functionName: 'fn', payload: '{"a":1}' }), argv: ['lambda', 'invoke', '--function-name', 'fn', '--payload', '{"a":1}', '/dev/stdout', ...J], access: 'write', text: true },
  { name: 'cfnListStacks', call: (a) => a.cfnListStacks(), argv: ['cloudformation', 'list-stacks', ...J], access: 'read' },
  { name: 'cfnListStacks+filter', call: (a) => a.cfnListStacks({ statusFilter: 'CREATE_COMPLETE' }), argv: ['cloudformation', 'list-stacks', '--stack-status-filter', 'CREATE_COMPLETE', ...J], access: 'read' },
  { name: 'cfnDescribeStacks', call: (a) => a.cfnDescribeStacks(), argv: ['cloudformation', 'describe-stacks', ...J], access: 'read' },
  { name: 'cfnDescribeStacks+name', call: (a) => a.cfnDescribeStacks({ stackName: 's' }), argv: ['cloudformation', 'describe-stacks', '--stack-name', 's', ...J], access: 'read' },
  { name: 'cfnDeleteStack', call: (a) => a.cfnDeleteStack({ stackName: 's' }), argv: ['cloudformation', 'delete-stack', '--stack-name', 's', ...J], access: 'write', dangerous: true },
  { name: 'dynamodbListTables', call: (a) => a.dynamodbListTables(), argv: ['dynamodb', 'list-tables', ...J], access: 'read' },
  { name: 'dynamodbListTables+limit', call: (a) => a.dynamodbListTables({ limit: 7 }), argv: ['dynamodb', 'list-tables', '--limit', '7', ...J], access: 'read' },
  { name: 'dynamodbCreateTable', call: (a) => a.dynamodbCreateTable({ tableName: 't', attributeDefinitions: 'AttributeName=id,AttributeType=S', keySchema: 'AttributeName=id,KeyType=HASH' }), argv: ['dynamodb', 'create-table', '--table-name', 't', '--attribute-definitions', 'AttributeName=id,AttributeType=S', '--key-schema', 'AttributeName=id,KeyType=HASH', '--billing-mode', 'PAY_PER_REQUEST', ...J], access: 'write' },
  { name: 'dynamodbCreateTable+provisioned', call: (a) => a.dynamodbCreateTable({ tableName: 't', attributeDefinitions: 'a', keySchema: 'k', billingMode: 'PROVISIONED' }), argv: ['dynamodb', 'create-table', '--table-name', 't', '--attribute-definitions', 'a', '--key-schema', 'k', '--billing-mode', 'PROVISIONED', ...J], access: 'write' },
  { name: 'dynamodbPutItem', call: (a) => a.dynamodbPutItem({ tableName: 't', item: '{"id":{"S":"1"}}' }), argv: ['dynamodb', 'put-item', '--table-name', 't', '--item', '{"id":{"S":"1"}}', ...J], access: 'write' },
  { name: 'dynamodbDeleteTable', call: (a) => a.dynamodbDeleteTable({ tableName: 't' }), argv: ['dynamodb', 'delete-table', '--table-name', 't', ...J], access: 'write', dangerous: true },
  { name: 'logsDescribeLogGroups', call: (a) => a.logsDescribeLogGroups(), argv: ['logs', 'describe-log-groups', ...J], access: 'read' },
  { name: 'logsDescribeLogGroups+opts', call: (a) => a.logsDescribeLogGroups({ limit: 5, logGroupNamePrefix: '/aws/' }), argv: ['logs', 'describe-log-groups', '--limit', '5', '--log-group-name-prefix', '/aws/', ...J], access: 'read' },
  { name: 'ecsListClusters', call: (a) => a.ecsListClusters(), argv: ['ecs', 'list-clusters', ...J], access: 'read' },
  { name: 'ecsListServices', call: (a) => a.ecsListServices({ cluster: 'c' }), argv: ['ecs', 'list-services', '--cluster', 'c', ...J], access: 'read' },
  { name: 'ecsListServices+max', call: (a) => a.ecsListServices({ cluster: 'c', maxResults: 10 }), argv: ['ecs', 'list-services', '--cluster', 'c', '--max-results', '10', ...J], access: 'read' },
  { name: 'ecsDescribeServices', call: (a) => a.ecsDescribeServices({ cluster: 'c', services: ['s1', 's2'] }), argv: ['ecs', 'describe-services', '--cluster', 'c', '--services', 's1', 's2', ...J], access: 'read' },
  { name: 'pricingDescribeServices', call: (a) => a.pricingDescribeServices(), argv: ['pricing', 'describe-services', '--region', 'us-east-1', ...J], access: 'read' },
  { name: 'pricingDescribeServices+opts', call: (a) => a.pricingDescribeServices({ serviceCode: 'AmazonEC2', maxResults: 1 }), argv: ['pricing', 'describe-services', '--region', 'us-east-1', '--service-code', 'AmazonEC2', '--max-results', '1', ...J], access: 'read' },
];

/** Grant the CLI-level attestation the way runCli would (see report: Aws2 drops policy.confirmed). */
function confirmedAws(options: Aws2Options = {}): Aws2 {
  const a = aws(options);
  (a.policy as Policy).confirmed = true;
  return a;
}

describe('curated ops: exact argv and JSON parsing', () => {
  for (const c of CASES) {
    test(`${c.name} -> aws ${c.argv.slice(0, 2).join(' ')}`, async () => {
      const canned = c.text ? 'raw-body' : { op: c.name, Items: [1] };
      fake.setScenario({ default: c.text ? { stdout: 'raw-body\n' } : { json: canned } });
      const a = c.dangerous ? confirmedAws() : aws();
      const result = await c.call(a);
      expect(result).toEqual(canned);
      const calls = fake.calls();
      expect(calls).toHaveLength(1);
      expect(calls[0]!.argv).toEqual(c.argv);
      expect(calls[0]!.env['AWS_PAGER']).toBe('');
      expect(calls[0]!.env['AWS_CLI_AUTO_PROMPT']).toBe('off');
    });
  }

  test('region/profile are appended as global args', async () => {
    fake.setScenario({ default: { json: {} } });
    await aws({ region: 'eu-west-1', profile: 'dev' }).ec2DescribeInstances();
    expect(fake.calls()[0]!.argv).toEqual([
      'ec2', 'describe-instances', '--output', 'json', '--region', 'eu-west-1', '--profile', 'dev',
    ]);
  });

  test('pricing pins us-east-1 and keeps --profile', async () => {
    fake.setScenario({ default: { json: {} } });
    await aws({ profile: 'dev' }).pricingDescribeServices();
    expect(fake.calls()[0]!.argv).toEqual([
      'pricing', 'describe-services', '--region', 'us-east-1', '--output', 'json', '--profile', 'dev',
    ]);
  });

  // BUG (src/api.ts pricingDescribeServices): filtering '--region' out of the
  // global args leaves the region *value* behind as a stray positional.
  test.failing('pricing with a configured region does not leak the region value into argv', async () => {
    fake.setScenario({ default: { json: {} } });
    await aws({ region: 'eu-west-1' }).pricingDescribeServices();
    expect(fake.calls()[0]!.argv).not.toContain('eu-west-1');
  });

  test('defaults: cwd is process.cwd() and no global args', () => {
    const a = new Aws2();
    expect(a.cwd).toBe(process.cwd());
    expect(a.region).toBeUndefined();
    expect(a.profile).toBeUndefined();
    expect(a.policy).toEqual({ dryRun: false, readOnly: false });
  });
});

describe('s3ListBuckets (text output parsing)', () => {
  test('parses `aws s3 ls` lines into {createdAt, name}', async () => {
    fake.setScenario({
      default: { stdout: '2024-01-02 03:04:05 bucket-a\n2023-12-31 23:59:59 bucket b with spaces\nweird-line\n\n' },
    });
    const result = await aws().s3ListBuckets();
    expect(result).toEqual({
      buckets: [
        { createdAt: '2024-01-02', name: 'bucket-a' },
        { createdAt: '2023-12-31', name: 'bucket b with spaces' },
        { name: 'weird-line' },
      ],
    });
    // Aws2 always passes a (possibly empty) globalArgs array, so text ops are finalized too.
    expect(fake.calls()[0]!.argv).toEqual(['s3', 'ls', '--output', 'json']);
  });

  test('empty listing yields no buckets; region adds global args', async () => {
    fake.setScenario({ default: { stdout: '' } });
    expect(await aws({ region: 'r' }).s3ListBuckets()).toEqual({ buckets: [] });
    expect(fake.calls()[0]!.argv).toEqual(['s3', 'ls', '--output', 'json', '--region', 'r']);
  });
});

describe('empty-body writes return explicit success envelopes', () => {
  const envelopes: Array<[string, (a: Aws2) => Promise<unknown>, Record<string, unknown>]> = [
    ['s3PutObject', (a) => a.s3PutObject({ bucket: 'b', key: 'k', body: 'f' }), { success: true, service: 's3api', op: 'put-object', bucket: 'b', key: 'k' }],
    ['ec2StopInstances', (a) => a.ec2StopInstances({ instanceIds: ['i-1'] }), { success: true, service: 'ec2', op: 'stop-instances', instanceIds: ['i-1'] }],
    ['ec2StartInstances', (a) => a.ec2StartInstances({ instanceIds: ['i-1'] }), { success: true, service: 'ec2', op: 'start-instances', instanceIds: ['i-1'] }],
    ['ec2RebootInstances', (a) => a.ec2RebootInstances({ instanceIds: ['i-1'] }), { success: true, service: 'ec2', op: 'reboot-instances', instanceIds: ['i-1'] }],
    ['cfnDeleteStack', (a) => a.cfnDeleteStack({ stackName: 's' }), { success: true, service: 'cloudformation', op: 'delete-stack', stackName: 's' }],
    ['dynamodbDeleteTable', (a) => a.dynamodbDeleteTable({ tableName: 't' }), { success: true, service: 'dynamodb', op: 'delete-table', tableName: 't' }],
    ['dynamodbPutItem', (a) => a.dynamodbPutItem({ tableName: 't', item: '{}' }), { success: true, service: 'dynamodb', op: 'put-item', tableName: 't' }],
    ['run', (a) => a.run('sqs', 'purge-queue', ['--queue-url', 'u']), { success: true, service: 'sqs', op: 'purge-queue' }],
  ];
  for (const [name, call, expected] of envelopes) {
    test(name, async () => {
      fake.setScenario({ default: { stdout: '' } });
      expect(await call(confirmedAws())).toEqual(expected);
      expect(fake.calls()).toHaveLength(1);
    });
  }
});

describe('policy', () => {
  for (const c of CASES.filter((x) => x.access === 'write')) {
    test(`${c.name}: dry-run simulates with resolved argv and spawns nothing`, async () => {
      const result = await c.call(aws({ policy: { dryRun: true }, region: 'us-west-2' }));
      expect(isDryRunResult(result)).toBe(true);
      const command = (result as { command: string[] }).command;
      expect(command.slice(0, 3)).toEqual(['aws', ...c.argv.slice(0, 2)]);
      expect(command).toContain('--output');
      expect(command.slice(-2)).toEqual(['--region', 'us-west-2']);
      expect(fake.calls()).toHaveLength(0);
    });

    test(`${c.name}: read-only refuses with READONLY_VIOLATION`, async () => {
      const err = await catchErr(c.call(aws({ policy: { readOnly: true } })));
      expect(err.code).toBe(ErrorCode.ReadOnlyViolation);
      expect(err.exitCode).toBe(6);
      expect(fake.calls()).toHaveLength(0);
    });
  }

  for (const c of CASES.filter((x) => x.access === 'read')) {
    test(`${c.name}: reads execute under dry-run + read-only`, async () => {
      fake.setScenario({ default: c.text ? { stdout: 'ok' } : { json: { ok: true } } });
      await c.call(aws({ policy: { dryRun: true, readOnly: true } }));
      expect(fake.calls()).toHaveLength(1);
    });
  }

  for (const c of CASES.filter((x) => x.dangerous)) {
    test(`${c.name}: dangerous op refused without confirmation`, async () => {
      const err = await catchErr(c.call(aws()));
      expect(err.code).toBe(ErrorCode.MissingConfirmation);
      expect(err.exitCode).toBe(9);
      expect((err.data?.['command'] as string[]).slice(1, 3)).toEqual(c.argv.slice(0, 2));
      expect(fake.calls()).toHaveLength(0);
    });
  }

  test('read-only beats dry-run for writes', async () => {
    const err = await catchErr(aws({ policy: { dryRun: true, readOnly: true } }).ec2StopInstances({ instanceIds: ['i'] }));
    expect(err.code).toBe(ErrorCode.ReadOnlyViolation);
  });
});

describe('run (dynamic access) and execArgs', () => {
  test('classify: metadata read/write, unknown defaults to write', () => {
    const a = aws();
    expect(a.classify('ec2', 'describe-instances')).toBe('read');
    expect(a.classify('s3api', 'DeleteBucket')).toBe('write');
    expect(a.classify('nope', 'whatever')).toBe('write');
    expect(a.classify('ec2', 'not-a-real-op')).toBe('write');
  });

  test('isDangerous: per-service list, PascalCase accepted, unknown service false', () => {
    const a = aws();
    expect(a.isDangerous('ec2', 'terminate-instances')).toBe(true);
    expect(a.isDangerous('ec2', 'TerminateInstances')).toBe(true);
    expect(a.isDangerous('s3', 'rb')).toBe(true);
    expect(a.isDangerous('s3api', 'delete-objects')).toBe(true);
    expect(a.isDangerous('ec2', 'stop-instances')).toBe(false);
    expect(a.isDangerous('nope', 'delete-everything')).toBe(false);
  });

  test('read op executes and returns parsed JSON with --query', async () => {
    fake.setScenario({ default: { json: ['i-1'] } });
    const r = await aws().run('ec2', 'describe-instances', ['--filters', 'Name=a,Values=b'], { query: 'Reservations[]' });
    expect(r).toEqual(['i-1']);
    expect(fake.calls()[0]!.argv).toEqual([
      'ec2', 'describe-instances', '--filters', 'Name=a,Values=b', '--output', 'json', '--query', 'Reservations[]',
    ]);
  });

  test('read op runs under read-only; write op refused; unknown op refused', async () => {
    fake.setScenario({ default: { json: { Buckets: [] } } });
    const ro = aws({ policy: { readOnly: true } });
    expect(await ro.run('s3api', 'list-buckets')).toEqual({ Buckets: [] });
    expect((await catchErr(ro.run('s3api', 'create-bucket', ['--bucket', 'x']))).code).toBe(ErrorCode.ReadOnlyViolation);
    expect((await catchErr(ro.run('madeup', 'thing'))).code).toBe(ErrorCode.ReadOnlyViolation);
    // credential-issuing override is a write
    expect((await catchErr(ro.run('sts', 'assume-role'))).code).toBe(ErrorCode.ReadOnlyViolation);
    expect(fake.calls()).toHaveLength(1);
  });

  test('dry-run: write simulated (operation name, query in argv), read executes', async () => {
    fake.setScenario({ default: { json: { ok: 1 } } });
    const dr = aws({ policy: { dryRun: true } });
    const sim = (await dr.run('ec2', 'create-tags', ['--resources', 'i-1'], { query: 'q' })) as Record<string, unknown>;
    expect(sim).toMatchObject({ success: true, dryRun: true, simulated: 'aws_ec2_create-tags' });
    expect(sim['command']).toEqual(['aws', 'ec2', 'create-tags', '--resources', 'i-1', '--output', 'json', '--query', 'q']);
    expect(fake.calls()).toHaveLength(0);
    expect(await dr.run('ec2', 'describe-vpcs')).toEqual({ ok: 1 });
    expect(fake.calls()).toHaveLength(1);
  });

  test('dangerous op: refused without confirm, executes with extras.confirmed, simulated under dry-run', async () => {
    fake.setScenario({ default: { json: { TerminatingInstances: [] } } });
    expect((await catchErr(aws().run('ec2', 'terminate-instances', ['--instance-ids', 'i-1']))).code).toBe(
      ErrorCode.MissingConfirmation,
    );
    expect(fake.calls()).toHaveLength(0);
    expect(await aws().run('ec2', 'terminate-instances', ['--instance-ids', 'i-1'], { confirmed: true })).toEqual({
      TerminatingInstances: [],
    });
    expect(fake.calls()).toHaveLength(1);
    const sim = await aws({ policy: { dryRun: true } }).run('ec2', 'terminate-instances', [], { confirmed: true });
    expect(isDryRunResult(sim)).toBe(true);
    expect(fake.calls()).toHaveLength(1);
  });

  test('maxPages > 1 delegates to the paginator', async () => {
    fake.setScenario({
      sequence: [{ json: { Items: [1], NextToken: 't1' } }, { json: { Items: [2] } }],
    });
    const r = (await aws({ region: 'r' }).run('dynamodb', 'scan', ['--table-name', 't'], { maxPages: 5, query: 'Items' })) as Record<string, unknown>;
    expect(r['Items']).toEqual([1, 2]);
    expect(r['_pagination']).toEqual({ pages: 2, maxPages: 5, hasMore: false });
    expect(fake.calls().map((c) => c.argv)).toEqual([
      ['dynamodb', 'scan', '--table-name', 't', '--output', 'json', '--query', 'Items', '--region', 'r'],
      ['dynamodb', 'scan', '--table-name', 't', '--starting-token', 't1', '--output', 'json', '--query', 'Items', '--region', 'r'],
    ]);
  });

  test('maxPages 1 returns the plain response (no _pagination)', async () => {
    fake.setScenario({ default: { json: { clusterArns: ['a'], nextToken: 'x' } } });
    const r = (await aws().run('ecs', 'list-clusters', [], { maxPages: 1 })) as Record<string, unknown>;
    expect(r['_pagination']).toBeUndefined();
    expect(r['clusterArns']).toEqual(['a']);
    expect(fake.calls()).toHaveLength(1);
  });

  test('execArgs splits service/op and requires both', async () => {
    fake.setScenario({ default: { json: { Buckets: [] } } });
    expect(await aws().execArgs(['s3api', 'list-buckets', '--max-items', '1'])).toEqual({ Buckets: [] });
    expect(fake.calls()[0]!.argv).toEqual(['s3api', 'list-buckets', '--max-items', '1', '--output', 'json']);
    for (const bad of [[], ['s3api']]) {
      const err = await catchErr(aws().execArgs(bad));
      expect(err.code).toBe(ErrorCode.InvalidRequest);
    }
  });

  test('errors from aws propagate with mapped codes', async () => {
    fake.setScenario({ default: { stderr: 'An error occurred (AccessDenied)', exit: 254 } });
    expect((await catchErr(aws().run('s3api', 'list-buckets'))).code).toBe(ErrorCode.Forbidden);
    fake.setScenario({ default: { stderr: 'ExpiredToken', exit: 254 } });
    expect((await catchErr(aws().getCallerIdentity())).code).toBe(ErrorCode.CommandFailed);
  });
});

describe('catalog via Aws2', () => {
  test('lists 41 ops with pagination descriptors', async () => {
    const { operations } = await aws().catalog();
    expect(operations).toHaveLength(41);
    expect(operations[0]).toEqual({ service: 'sts', operation: 'get-caller-identity', paginated: false });
    expect(operations.find((o) => o.operation === 'list-objects-v2')).toEqual({
      service: 's3api',
      operation: 'list-objects-v2',
      paginated: true,
      pagination: { input_token: 'ContinuationToken', output_token: 'NextContinuationToken', more_results: 'IsTruncated' },
    });
    expect(operations.find((o) => o.operation === 'describe-instances')?.pagination).toEqual({
      input_token: 'NextToken',
      output_token: 'NextToken',
    });
    expect(fake.calls()).toHaveLength(0);
  });

  test('lmQuery delegates with the instance cwd', async () => {
    fake.setScenario({ default: { json: { Account: '1' } } });
    const r = await aws().lmQuery({ service: 'sts', operation: 'get-caller-identity' });
    expect(r.data).toEqual({ Account: '1' });
    expect(fake.calls()[0]!.cwd).toBe(fake.cwd);
  });
});
