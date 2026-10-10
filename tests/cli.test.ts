/**
 * @fileoverview src/cli.ts end-to-end against a hermetic fake `aws`.
 *
 * Most cases run the CLI in-process (fresh module instance per run, stdout
 * captured, process.exit intercepted) so coverage is attributed; a few smoke
 * tests spawn `bun src/cli.ts` as a real subprocess.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { realpathSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import {
  createFakeAws,
  loadCliConfig,
  runCliInProcess,
  runConfigured,
  type CliConfig,
  type CliRun,
  type FakeAws,
  type FakeScenario,
} from './helpers/fake-aws.js';

const CLI = resolve(import.meta.dir, '../src/cli.ts');
let fake: FakeAws;

beforeAll(() => {
  fake = createFakeAws();
});
afterAll(() => fake.cleanup());
beforeEach(() => fake.setScenario({ default: { json: { ok: true } } }));

function cli(args: string[], scenario?: FakeScenario, env: Record<string, string> = {}): Promise<CliRun> {
  if (scenario) fake.setScenario(scenario);
  return runCliInProcess(args, fake.env(env), fake.cwd);
}

interface ErrorEnvelope {
  success: false;
  error: { code: string; message: string; data?: Record<string, unknown> };
}

function errorOf(run: CliRun): ErrorEnvelope['error'] {
  const env = run.json as ErrorEnvelope;
  expect(env.success).toBe(false);
  return env.error;
}

const argvs = () => fake.calls().map((c) => c.argv);
const J = ['--output', 'json'];

describe('discovery: help / list / schema / explain', () => {
  test('no args and --help print tool help', async () => {
    for (const args of [[], ['--help'], ['-h']]) {
      const r = await cli(args);
      expect(r.code).toBe(0);
      expect(r.stdout).toContain('aws2');
      expect(r.stdout).toContain('lm_query');
    }
  });

  test('<op> --help prints op help', async () => {
    const r = await cli(['lm_query', '--help']);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('lm_query');
    expect(r.stdout).toContain('--timeout-seconds');
  });

  test('--list lists all 31 ops with authored schemas and access', async () => {
    const r = await cli(['--list']);
    expect(r.code).toBe(0);
    const ops = r.json as Array<{ name: string; access: string; schema?: unknown }>;
    expect(ops).toHaveLength(31);
    expect(ops.every((o) => o.schema !== undefined)).toBe(true);
    const access = Object.fromEntries(ops.map((o) => [o.name, o.access]));
    expect(access['run']).toBe('dynamic');
    expect(access['exec']).toBe('dynamic');
    expect(access['s3_put_object']).toBe('write');
    expect(access['lm_query']).toBe('read');
  });

  test('--schema publishes a schema document without derived ops', async () => {
    const r = await cli(['--schema']);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('aws2');
    expect(r.stdout).toContain('0.1.0');
    expect(r.stdout).not.toMatch(/"derived"\s*:\s*true/);
  });

  test('--explain <op> (json and text), default deadline 60', async () => {
    const r = await cli(['--explain', 'lm_query']);
    expect(r.code).toBe(0);
    const schema = r.json as { name: string; params: Array<{ name: string; default?: unknown }> };
    expect(schema.name).toBe('lm_query');
    expect(schema.params.find((p) => p.name === 'timeoutSeconds')?.default).toBe(60);
    const t = await cli(['--explain', 'run', '--format', 'text']);
    expect(t.code).toBe(0);
    expect(t.stdout).toContain('--service');
  });

  test('--explain errors', async () => {
    const missing = await cli(['--explain']);
    expect(missing.code).toBe(2);
    expect(errorOf(missing).message).toContain('Missing operation name');
    const unknown = await cli(['--explain', 'nope']);
    expect(unknown.code).toBe(2);
    expect(errorOf(unknown).message).toContain('Unknown operation for --explain');
  });

  test('unknown op and missing op', async () => {
    const r = await cli(['bogus_op']);
    expect(r.code).toBe(2);
    expect(errorOf(r)).toMatchObject({ code: 'INVALID_REQUEST', message: 'Unknown operation: bogus_op' });
    const none = await cli(['--dryrun']);
    expect(none.code).toBe(2);
    expect(errorOf(none).message).toBe('No operation specified');
    expect(fake.calls()).toHaveLength(0);
  });
});

describe('curated ops via the CLI: exact argv', () => {
  const cases: Array<[string[], string[]]> = [
    [['get_caller_identity'], ['sts', 'get-caller-identity', ...J]],
    [['get_caller_identity', '--query', 'Account'], ['sts', 'get-caller-identity', ...J]],
    [['s3_list_objects', '--bucket', 'b', '--prefix', 'p'], ['s3api', 'list-objects-v2', '--bucket', 'b', '--prefix', 'p', ...J]],
    [['s3_get_object', '--bucket', 'b', '--key', 'k'], ['s3api', 'get-object', '--bucket', 'b', '--key', 'k', '/dev/stdout', ...J]],
    [['s3_put_object', '--bucket', 'b', '--key', 'k', '--body', '/tmp/x'], ['s3api', 'put-object', '--bucket', 'b', '--key', 'k', '--body', '/tmp/x', ...J]],
    [['ec2_describe_instances', '--filters', 'Name=a,Values=b', '--max-results', '6'], ['ec2', 'describe-instances', '--filters', 'Name=a,Values=b', '--max-results', '6', ...J]],
    [['ec2_stop_instances', '--instance-ids', 'i-1', '--instance-ids', 'i-2'], ['ec2', 'stop-instances', '--instance-ids', 'i-1', 'i-2', ...J]],
    [['ec2_start_instances', '--instance-ids', 'i-1'], ['ec2', 'start-instances', '--instance-ids', 'i-1', ...J]],
    [['ec2_reboot_instances', '--input-json', '{"instanceIds":["i-1","i-2"]}'], ['ec2', 'reboot-instances', '--instance-ids', 'i-1', 'i-2', ...J]],
    [['iam_list_roles', '--max-items', '2', '--path-prefix', '/x/'], ['iam', 'list-roles', '--max-items', '2', '--path-prefix', '/x/', ...J]],
    [['iam_list_users', '--max-items', '2'], ['iam', 'list-users', '--max-items', '2', ...J]],
    [['iam_list_policies', '--scope', 'AWS'], ['iam', 'list-policies', '--scope', 'AWS', ...J]],
    [['lambda_list_functions'], ['lambda', 'list-functions', ...J]],
    [['lambda_invoke', '--function-name', 'fn', '--payload', '{}'], ['lambda', 'invoke', '--function-name', 'fn', '--payload', '{}', '/dev/stdout', ...J]],
    [['cfn_list_stacks', '--status-filter', 'DELETE_COMPLETE'], ['cloudformation', 'list-stacks', '--stack-status-filter', 'DELETE_COMPLETE', ...J]],
    [['cfn_describe_stacks', '--stack-name', 's'], ['cloudformation', 'describe-stacks', '--stack-name', 's', ...J]],
    [['dynamodb_list_tables', '--limit', '3'], ['dynamodb', 'list-tables', '--limit', '3', ...J]],
    [['dynamodb_create_table', '--table-name', 't', '--attribute-definitions', 'a', '--key-schema', 'k', '--billing-mode', 'PROVISIONED'], ['dynamodb', 'create-table', '--table-name', 't', '--attribute-definitions', 'a', '--key-schema', 'k', '--billing-mode', 'PROVISIONED', ...J]],
    [['dynamodb_put_item', '--table-name', 't', '--item', '{"id":{"S":"1"}}'], ['dynamodb', 'put-item', '--table-name', 't', '--item', '{"id":{"S":"1"}}', ...J]],
    [['logs_describe_log_groups', '--limit', '1', '--log-group-name-prefix', '/a'], ['logs', 'describe-log-groups', '--limit', '1', '--log-group-name-prefix', '/a', ...J]],
    [['ecs_list_clusters'], ['ecs', 'list-clusters', ...J]],
    [['ecs_list_services', '--cluster', 'c', '--max-results', '4'], ['ecs', 'list-services', '--cluster', 'c', '--max-results', '4', ...J]],
    [['ecs_describe_services', '--cluster', 'c', '--services', 's1', '--services', 's2'], ['ecs', 'describe-services', '--cluster', 'c', '--services', 's1', 's2', ...J]],
    [['pricing_describe_services', '--service-code', 'AmazonS3', '--max-results', '1'], ['pricing', 'describe-services', '--region', 'us-east-1', '--service-code', 'AmazonS3', '--max-results', '1', ...J]],
  ];
  // s3_get_object / lambda_invoke return the raw (trimmed) stdout text.
  const TEXT_OPS = new Set(['s3_get_object', 'lambda_invoke']);
  for (const [args, expected] of cases) {
    test(args.join(' '), async () => {
      const r = await cli(args);
      expect(r.code).toBe(0);
      expect(r.json).toEqual(TEXT_OPS.has(args[0]!) ? '{"ok":true}' : { ok: true });
      expect(argvs()).toEqual([expected]);
      const call = fake.calls()[0]!;
      expect(call.env['AWS_PAGER']).toBe('');
      expect(call.env['AWS_CLI_AUTO_PROMPT']).toBe('off');
      expect(call.cwd).toBe(realpathSync(fake.cwd));
    });
  }

  test('s3_list_buckets parses text listing', async () => {
    const r = await cli(['s3_list_buckets'], { default: { stdout: '2024-05-06 07:08:09 alpha\n' } });
    expect(r.code).toBe(0);
    expect(r.json).toEqual({ buckets: [{ createdAt: '2024-05-06', name: 'alpha' }] });
  });

  test('services lists metadata services without calling aws', async () => {
    const r = await cli(['services']);
    expect(r.code).toBe(0);
    const { services } = r.json as { services: string[] };
    expect(services).toHaveLength(381);
    expect(services).toContain('ec2');
    expect(fake.calls()).toHaveLength(0);
  });

  test('catalog lists the 41 reviewed ops', async () => {
    const r = await cli(['catalog']);
    expect((r.json as { operations: unknown[] }).operations).toHaveLength(41);
    expect(fake.calls()).toHaveLength(0);
  });

  test('AWS_REGION / AWS_PROFILE become global args; AWS_DEFAULT_REGION is the fallback', async () => {
    await cli(['ecs_list_clusters'], undefined, { AWS_REGION: 'us-west-2', AWS_PROFILE: 'dev' });
    expect(argvs()).toEqual([['ecs', 'list-clusters', ...J, '--region', 'us-west-2', '--profile', 'dev']]);
    fake.setScenario({ default: { json: {} } });
    await cli(['ecs_list_clusters'], undefined, { AWS_DEFAULT_REGION: 'ap-south-1' });
    expect(argvs()).toEqual([['ecs', 'list-clusters', ...J, '--region', 'ap-south-1']]);
  });

  test('empty-body write returns a success envelope', async () => {
    const r = await cli(['ec2_stop_instances', '--instance-ids', 'i-9'], { default: { stdout: '' } });
    expect(r.json).toEqual({ success: true, service: 'ec2', op: 'stop-instances', instanceIds: ['i-9'] });
  });
});

describe('error mapping via the CLI (envelope + exit code)', () => {
  const cases: Array<[string, { stderr?: string; stdout?: string; exit?: number }, number, string]> = [
    ['AccessDenied', { stderr: 'An error occurred (AccessDenied) when calling the GetCallerIdentity operation', exit: 254 }, 6, 'FORBIDDEN'],
    ['no credentials', { stderr: 'Unable to locate credentials', exit: 253 }, 6, 'FORBIDDEN'],
    ['ExpiredToken', { stderr: 'An error occurred (ExpiredToken): The security token included in the request is expired', exit: 254 }, 1, 'COMMAND_FAILED'],
    ['throttling', { stderr: 'An error occurred (Throttling): Rate exceeded', exit: 254 }, 1, 'COMMAND_FAILED'],
    ['not found', { stderr: 'An error occurred (NoSuchEntity): The role with name x cannot be found.', exit: 254 }, 1, 'COMMAND_FAILED'],
    ['read timeout', { stderr: 'Read timeout on endpoint URL', exit: 255 }, 7, 'TIMEOUT'],
    ['command not found', { stderr: 'sh: aws: command not found', exit: 127 }, 127, 'COMMAND_NOT_FOUND'],
  ];
  for (const [label, response, exit, code] of cases) {
    test(`${label} -> ${code} (exit ${exit})`, async () => {
      const r = await cli(['get_caller_identity'], { default: response });
      expect(r.code).toBe(exit);
      expect(errorOf(r).code).toBe(code);
    });
  }

  test('invalid JSON stdout from a JSON op is returned as raw text', async () => {
    const r = await cli(['ecs_list_clusters'], { default: { stdout: '{oops' } });
    expect(r.code).toBe(0);
    expect(r.json).toBe('{oops');
  });
});

describe('validation and document input', () => {
  test('missing required param', async () => {
    const r = await cli(['s3_list_objects']);
    expect(r.code).toBe(2);
    expect(errorOf(r).code).toBe('VALIDATION_ERROR');
    expect(fake.calls()).toHaveLength(0);
  });

  test('type mismatch and unknown flag', async () => {
    const t = await cli(['iam_list_users', '--max-items', 'abc']);
    expect(t.code).toBe(2);
    expect(errorOf(t).message).toContain('expected a number');
    const u = await cli(['iam_list_users', '--max-itemz', '3']);
    expect(u.code).toBe(2);
    const issues = (errorOf(u).data?.['issues'] as Array<{ code: string; suggestion?: string }>) ?? [];
    expect(issues[0]?.code).toBe('UNKNOWN_PARAM');
    expect(issues[0]?.suggestion).toBe('--max-items');
  });

  test('enum violation', async () => {
    const r = await cli(['iam_list_policies', '--scope', 'Everything']);
    expect(r.code).toBe(2);
    expect(errorOf(r).code).toBe('VALIDATION_ERROR');
  });

  test('--input-json document input (op flag form and root envelope form)', async () => {
    const r = await cli(['s3_list_objects', '--input-json', '{"bucket":"b","prefix":"x"}']);
    expect(r.code).toBe(0);
    expect(argvs()).toEqual([['s3api', 'list-objects-v2', '--bucket', 'b', '--prefix', 'x', ...J]]);
    fake.setScenario({ default: { json: { Account: '1' } } });
    const root = await cli(['--input-json', '{"op":"get_caller_identity"}']);
    expect(root.code).toBe(0);
    expect(root.json).toEqual({ Account: '1' });
  });

  test('--input-json validation errors', async () => {
    const bad = await cli(['s3_list_objects', '--input-json', '{"prefix":"x"}']);
    expect(bad.code).toBe(2);
    expect(errorOf(bad).code).toBe('VALIDATION_ERROR');
    const notJson = await cli(['s3_list_objects', '--input-json', '{nope']);
    expect(notJson.code).toBe(2);
    const mixed = await cli(['s3_list_objects', '--bucket', 'b', '--input-json', '{"bucket":"b"}']);
    expect(mixed.code).toBe(2);
    expect(errorOf(mixed).message).toContain('cannot mix --input-json');
    const rootNoOp = await cli(['--input-json', '{"bucket":"b"}']);
    expect(rootNoOp.code).toBe(2);
    expect(errorOf(rootNoOp).message).toBe('No operation specified');
    expect(fake.calls()).toHaveLength(0);
  });

  test('--input-file reads a document; unreadable file is INVALID_REQUEST', async () => {
    const file = join(fake.root, 'doc.json');
    writeFileSync(file, JSON.stringify({ cluster: 'c1' }));
    const r = await cli(['ecs_list_services', '--input-file', file]);
    expect(r.code).toBe(0);
    expect(argvs()).toEqual([['ecs', 'list-services', '--cluster', 'c1', ...J]]);
    const missing = await cli(['ecs_list_services', '--input-file', join(fake.root, 'missing.json')]);
    expect(missing.code).toBe(2);
    expect(errorOf(missing).message).toContain('cannot read input file');
  });
});

describe('policy gates via the CLI', () => {
  test('--dryrun simulates writes and records NO aws call', async () => {
    const r = await cli(['ec2_stop_instances', '--instance-ids', 'i-1', '--dryrun']);
    expect(r.code).toBe(0);
    expect(r.json).toEqual({
      success: true,
      dryRun: true,
      simulated: 'aws_ec2_stop_instances',
      command: ['aws', 'ec2', 'stop-instances', '--instance-ids', 'i-1', ...J],
    });
    expect(fake.calls()).toHaveLength(0);
  });

  test('--dry-run alias and AWS2_DRYRUN env floor', async () => {
    for (const [args, env] of [
      [['s3_put_object', '--bucket', 'b', '--key', 'k', '--body', 'f', '--dry-run'], {}],
      [['s3_put_object', '--bucket', 'b', '--key', 'k', '--body', 'f'], { AWS2_DRYRUN: 'true' }],
      [['s3_put_object', '--bucket', 'b', '--key', 'k', '--body', 'f'], { AWS2_DRYRUN: '1' }],
    ] as Array<[string[], Record<string, string>]>) {
      const r = await cli(args, undefined, env);
      expect(r.code).toBe(0);
      expect((r.json as { dryRun?: boolean }).dryRun).toBe(true);
      expect(fake.calls()).toHaveLength(0);
    }
  });

  test('--dryrun still executes reads', async () => {
    const r = await cli(['iam_list_roles', '--dryrun'], { default: { json: { Roles: [] } } });
    expect(r.json).toEqual({ Roles: [] });
    expect(fake.calls()).toHaveLength(1);
  });

  test('--readonly refuses writes (exit 6, READONLY_VIOLATION) and allows reads', async () => {
    const w = await cli(['dynamodb_put_item', '--table-name', 't', '--item', '{}', '--readonly']);
    expect(w.code).toBe(6);
    expect(errorOf(w).code).toBe('READONLY_VIOLATION');
    expect(errorOf(w).data?.['command']).toEqual(['aws', 'dynamodb', 'put-item', '--table-name', 't', '--item', '{}', ...J]);
    expect(fake.calls()).toHaveLength(0);
    const r = await cli(['dynamodb_list_tables', '--read-only'], { default: { json: { TableNames: ['t'] } } });
    expect(r.code).toBe(0);
    expect(r.json).toEqual({ TableNames: ['t'] });
  });

  test('AWS2_READONLY env floor (enabled values only)', async () => {
    const on = await cli(['lambda_invoke', '--function-name', 'f'], undefined, { AWS2_READONLY: 'yes' });
    expect(on.code).toBe(6);
    expect(fake.calls()).toHaveLength(0);
    fake.setScenario({ default: { stdout: 'invoked' } });
    const off = await cli(['lambda_invoke', '--function-name', 'f'], undefined, { AWS2_READONLY: '0' });
    expect(off.code).toBe(0);
    expect(off.json).toBe('invoked');
  });

  test('dangerous ops are refused without --confirm (exit 9) and record no call', async () => {
    for (const args of [
      ['cfn_delete_stack', '--stack-name', 's'],
      ['dynamodb_delete_table', '--table-name', 't'],
      ['run', '--service', 'ec2', '--op', 'terminate-instances'],
      ['run', '--service', 's3api', '--op', 'delete-bucket', '--args', '["--bucket","b"]'],
    ]) {
      const r = await cli(args);
      expect(r.code).toBe(9);
      expect(errorOf(r).code).toBe('MISSING_CONFIRMATION');
      expect(fake.calls()).toHaveLength(0);
    }
  });

  test('dangerous ops with --confirm under --dryrun are simulated, no call', async () => {
    for (const args of [
      ['cfn_delete_stack', '--stack-name', 's', '--confirm', '--dryrun'],
      ['dynamodb_delete_table', '--table-name', 't', '--i-understand', '--dryrun'],
      ['run', '--service', 'ec2', '--op', 'terminate-instances', '--confirm', '--dryrun'],
    ]) {
      const r = await cli(args);
      expect(r.code).toBe(0);
      expect((r.json as { dryRun?: boolean }).dryRun).toBe(true);
      expect(fake.calls()).toHaveLength(0);
    }
  });

  test('dangerous ops under --readonly are refused even with --confirm', async () => {
    const r = await cli(['dynamodb_delete_table', '--table-name', 't', '--confirm', '--readonly']);
    expect(r.code).toBe(6);
    expect(fake.calls()).toHaveLength(0);
  });

  // BUG: runCli puts confirmed=true in the Policy it hands to buildContext, but
  // the Aws2 constructor only copies dryRun/readOnly, so policy.confirmed is
  // dropped and takeExtras never sees it. Result: --confirm / --i-understand
  // can never execute a dangerous op from the CLI (exit 9 instead).
  for (const flag of ['--confirm', '--i-understand']) {
    test.failing(`dangerous op executes with ${flag}`, async () => {
      const r = await cli(['run', '--service', 'ec2', '--op', 'terminate-instances', flag]);
      expect(r.code).toBe(0);
      expect(fake.calls()).toHaveLength(1);
    });
  }
  test.failing('cfn_delete_stack executes with --confirm', async () => {
    const r = await cli(['cfn_delete_stack', '--stack-name', 's', '--confirm']);
    expect(r.code).toBe(0);
  });
});

describe('run / exec pass-through (classification-driven policy)', () => {
  test('run: --args JSON array, --query passthrough, read executes', async () => {
    const r = await cli(['run', '--service', 'ec2', '--op', 'describe-instances', '--args', '["--filters","Name=a,Values=b"]', '--query', 'Reservations']);
    expect(r.code).toBe(0);
    expect(argvs()).toEqual([['ec2', 'describe-instances', '--filters', 'Name=a,Values=b', ...J, '--query', 'Reservations']]);
  });

  test('run without --args; unknown op defaults to write (dry-run simulated, read-only refused)', async () => {
    const sim = await cli(['run', '--service', 'madeup', '--op', 'do-thing', '--dryrun']);
    expect((sim.json as { simulated?: string }).simulated).toBe('aws_madeup_do-thing');
    const ro = await cli(['run', '--service', 'madeup', '--op', 'do-thing', '--readonly']);
    expect(ro.code).toBe(6);
    expect(fake.calls()).toHaveLength(0);
  });

  test('run: credential-issuing override (sts assume-role) is refused under --readonly', async () => {
    const r = await cli(['run', '--service', 'sts', '--op', 'assume-role', '--readonly']);
    expect(r.code).toBe(6);
    const read = await cli(['run', '--service', 'sts', '--op', 'get-caller-identity', '--readonly']);
    expect(read.code).toBe(0);
  });

  test('run: --max-pages follows tokens and returns the _pagination envelope', async () => {
    const r = await cli(['run', '--service', 'logs', '--op', 'describe-log-groups', '--max-pages', '2'], {
      sequence: [
        { json: { logGroups: [{ n: 1 }], nextToken: 'a' } },
        { json: { logGroups: [{ n: 2 }], nextToken: 'b' } },
        { json: { logGroups: [{ n: 3 }] } },
      ],
    });
    expect(r.code).toBe(0);
    expect(r.json).toEqual({
      logGroups: [{ n: 1 }, { n: 2 }],
      _pagination: { pages: 2, maxPages: 2, hasMore: true, nextToken: { nextToken: 'b' } },
    });
    expect(argvs()).toEqual([
      ['logs', 'describe-log-groups', ...J],
      ['logs', 'describe-log-groups', '--starting-token', 'a', ...J],
    ]);
  });

  test('run: malformed --args JSON is reported as an error envelope', async () => {
    const r = await cli(['run', '--service', 'ec2', '--op', 'describe-vpcs', '--args', '[not json']);
    expect(r.code).toBe(1);
    expect(errorOf(r).code).toBe('UNKNOWN_ERROR');
    expect(fake.calls()).toHaveLength(0);
  });

  test('exec: argv via repeated --_ flags or an --input-json document', async () => {
    const r = await cli(['exec', '--_', 's3api', '--_', 'list-buckets', '--_=--max-items', '--_', '1']);
    expect(r.code).toBe(0);
    expect(argvs()).toEqual([['s3api', 'list-buckets', '--max-items', '1', ...J]]);
    fake.setScenario({ default: { json: { ok: 1 } } });
    const d = await cli(['exec', '--input-json', '{"_":["ec2","describe-vpcs"],"query":"Vpcs"}']);
    expect(d.code).toBe(0);
    expect(argvs()).toEqual([['ec2', 'describe-vpcs', ...J, '--query', 'Vpcs']]);
  });

  test('exec: policy follows classification', async () => {
    const w = await cli(['exec', '--input-json', '{"_":["s3api","put-object","--bucket","b"]}', '--readonly']);
    expect(w.code).toBe(6);
    const sim = await cli(['exec', '--input-json', '{"_":["s3api","delete-bucket","--bucket","b"]}', '--dryrun']);
    expect((sim.json as { dryRun?: boolean }).dryRun).toBe(true);
    const danger = await cli(['exec', '--input-json', '{"_":["s3api","delete-bucket","--bucket","b"]}']);
    expect(danger.code).toBe(9);
    expect(fake.calls()).toHaveLength(0);
  });

  test('exec: requires service and op', async () => {
    const r = await cli(['exec']);
    expect(r.code).toBe(2);
    expect(errorOf(r).message).toContain('requires at least a service and operation');
  });

  // BUG/UX: the documented form `aws2 exec s3api list-buckets` is rejected
  // with EXTRA_POSITIONAL because EXEC_SCHEMA's `_` param is not positional.
  test.failing('exec: documented positional form `aws2 exec s3api list-buckets` runs', async () => {
    const r = await cli(['exec', 's3api', 'list-buckets']);
    expect(r.code).toBe(0);
  });
});

describe('lm_query via the CLI', () => {
  const FIXED = ['--output=json', '--no-cli-pager', '--no-cli-auto-prompt', '--color=off', '--cli-connect-timeout=10', '--cli-read-timeout=30'];

  test('all flags map to the native argv; params JSON is one --cli-input-json entry', async () => {
    const r = await cli(
      [
        'lm_query', '--service', 'ec2', '--operation', 'describe-instances',
        '--params', '{"Filters":[{"Name":"tag:Name","Values":["a b"]}]}',
        '--profile', 'dev', '--region', 'eu-west-1',
        '--max-items', '5', '--page-size', '2', '--starting-token', 'tok',
        '--select', '/Reservations', '--timeout-seconds', '30',
        '--query', 'ignored', '--max-pages', '3',
      ],
      { default: { json: { Reservations: [{ id: 'r-1' }], NextToken: 'n2' } } },
    );
    expect(r.code).toBe(0);
    expect(argvs()).toEqual([[
      'ec2', 'describe-instances', ...FIXED,
      '--cli-input-json={"Filters":[{"Name":"tag:Name","Values":["a b"]}]}',
      '--profile=dev', '--region=eu-west-1', '--max-items=5', '--page-size=2', '--starting-token=tok',
    ]]);
    expect(fake.calls()[0]!.env['AWS_MAX_ATTEMPTS']).toBe('2');
    expect(r.json).toMatchObject({
      schema: 'lmprobe.aws_query.v1',
      exitStatus: 'matched',
      partial: true,
      profile: 'dev',
      region: 'eu-west-1',
      select: '/Reservations',
      data: [{ id: 'r-1' }],
      page: { tokens: { NextToken: 'n2' }, resumeToken: 'n2', startedFromToken: true, maxItems: 5 },
    });
  });

  test('--first-page and document input; params given as a JSON string', async () => {
    const r = await cli(['lm_query', '--service', 's3api', '--operation', 'list-objects-v2', '--params', '"{\\"Bucket\\":\\"b\\"}"', '--first-page'], {
      default: { json: { Contents: [], IsTruncated: false } },
    });
    expect(r.code).toBe(0);
    expect(argvs()).toEqual([['s3api', 'list-objects-v2', ...FIXED, '--cli-input-json={"Bucket":"b"}', '--no-paginate']]);
    fake.setScenario({ default: { json: { Account: '1' } } });
    const d = await cli(['lm_query', '--input-json', '{"service":"sts","operation":"get-caller-identity","params":{}}']);
    expect(d.code).toBe(0);
    expect((d.json as { data: unknown }).data).toEqual({ Account: '1' });
  });

  test('refused op -> INVALID_REQUEST envelope (exit 2), no spawn', async () => {
    const r = await cli(['lm_query', '--service', 'sts', '--operation', 'assume-role']);
    expect(r.code).toBe(2);
    expect(errorOf(r).message).toContain('AWS_OPERATION_REFUSED');
    expect(fake.calls()).toHaveLength(0);
  });

  test('deadline out of bounds -> INVALID_REQUEST', async () => {
    for (const t of ['0', '301']) {
      const r = await cli(['lm_query', '--service', 'sts', '--operation', 'get-caller-identity', '--timeout-seconds', t]);
      expect(r.code).toBe(2);
      expect(errorOf(r).message).toContain('AWS_TIMEOUT_INVALID');
    }
  });

  test('aws failure / invalid JSON / timeout envelopes', async () => {
    const fail = await cli(['lm_query', '--service', 'iam', '--operation', 'get-user'], { default: { stderr: 'AccessDenied', exit: 254 } });
    expect(fail.code).toBe(1);
    expect(errorOf(fail)).toMatchObject({ code: 'COMMAND_FAILED', data: { stderr: 'AccessDenied' } });
    const bad = await cli(['lm_query', '--service', 'iam', '--operation', 'get-user'], { default: { stdout: 'nope' } });
    expect(bad.code).toBe(3);
    expect(errorOf(bad).code).toBe('PARSE_ERROR');
    const slow = await cli(['lm_query', '--service', 'iam', '--operation', 'get-user', '--timeout-seconds', '0.05'], {
      default: { sleepMs: 5000, json: {} },
    });
    expect(slow.code).toBe(7);
    expect(errorOf(slow).code).toBe('TIMEOUT');
  });

  test('redaction and missing --select pointer through the CLI', async () => {
    const r = await cli(['lm_query', '--service', 'lambda', '--operation', 'list-functions', '--select', '/Functions/5'], {
      default: { json: { Functions: [{ Environment: { Variables: { K: 'secret' } } }] } },
    });
    expect(r.code).toBe(0);
    expect(r.stdout).not.toContain('secret');
    expect(r.json).toMatchObject({ exitStatus: 'error', data: null, redactions: 1 });
  });
});

describe('spawned subprocess smoke tests (real `bun src/cli.ts`)', () => {
  function spawnCli(args: string[], env: Record<string, string> = {}) {
    const res = spawnSync(process.execPath, [CLI, ...args], {
      encoding: 'utf-8',
      cwd: fake.cwd,
      env: fake.env(env),
      timeout: 30000,
    });
    return { status: res.status, stdout: res.stdout ?? '', stderr: res.stderr ?? '' };
  }

  test('read op runs the fake aws with pager/auto-prompt disabled', () => {
    fake.setScenario({ default: { json: { Account: '000000000000' } } });
    const r = spawnCli(['get_caller_identity']);
    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout)).toEqual({ Account: '000000000000' });
    const call = fake.calls()[0]!;
    expect(call.argv).toEqual(['sts', 'get-caller-identity', ...J]);
    expect(call.env).toMatchObject({ AWS_PAGER: '', AWS_CLI_AUTO_PROMPT: 'off' });
  });

  test('--readonly write refusal sets the process exit code', () => {
    fake.setScenario({ default: { json: {} } });
    const r = spawnCli(['ec2_stop_instances', '--instance-ids', 'i-1', '--readonly']);
    expect(r.status).toBe(6);
    expect((JSON.parse(r.stdout) as ErrorEnvelope).error.code).toBe('READONLY_VIOLATION');
    expect(fake.calls()).toHaveLength(0);
  });

  test('AWS2_DRYRUN env floor in a subprocess', () => {
    fake.setScenario({ default: { json: {} } });
    const r = spawnCli(['dynamodb_delete_table', '--table-name', 't'], { AWS2_DRYRUN: 'on' });
    expect(r.status).toBe(0);
    expect((JSON.parse(r.stdout) as { dryRun: boolean }).dryRun).toBe(true);
    expect(fake.calls()).toHaveLength(0);
  });
});

// Bun reports function coverage for a module loaded several times (one fresh
// cli.ts instance per in-process run above) from the LAST loaded instance
// only. Drive every op through one captured instance so the per-op runner
// closures in cli.ts are exercised on the instance that is reported. Keep
// this describe last among in-process runs.
describe('all ops through a single cli.ts instance', () => {
  let config: CliConfig;
  beforeAll(async () => {
    config = await loadCliConfig(fake.env(), fake.cwd);
  });
  const run = (args: string[]) => runConfigured(config, args, fake.env(), fake.cwd);

  test('config shape: tool name, version and 31 ops', () => {
    expect(config.toolName).toBe('aws2');
    expect(config.version).toBe('0.1.0');
    expect(config.ops).toHaveLength(31);
  });

  test('every op runs (writes under --dryrun, dangerous with --confirm)', async () => {
    const invocations: string[][] = [
      ['run', '--service', 'ec2', '--op', 'describe-vpcs', '--args', '["--max-results","5"]'],
      ['exec', '--_', 'ec2', '--_', 'describe-vpcs'],
      ['services'],
      ['get_caller_identity'],
      ['s3_list_buckets'],
      ['s3_list_objects', '--bucket', 'b'],
      ['s3_put_object', '--bucket', 'b', '--key', 'k', '--body', 'f', '--dryrun'],
      ['s3_get_object', '--bucket', 'b', '--key', 'k'],
      ['ec2_describe_instances'],
      ['ec2_stop_instances', '--instance-ids', 'i-1', '--dryrun'],
      ['ec2_start_instances', '--instance-ids', 'i-1', '--dryrun'],
      ['ec2_reboot_instances', '--instance-ids', 'i-1', '--dryrun'],
      ['iam_list_roles'],
      ['iam_list_users'],
      ['iam_list_policies'],
      ['lambda_list_functions'],
      ['lambda_invoke', '--function-name', 'f', '--dryrun'],
      ['cfn_list_stacks'],
      ['cfn_describe_stacks'],
      ['cfn_delete_stack', '--stack-name', 's', '--confirm', '--dryrun'],
      ['dynamodb_list_tables'],
      ['dynamodb_create_table', '--table-name', 't', '--attribute-definitions', 'a', '--key-schema', 'k', '--dryrun'],
      ['dynamodb_put_item', '--table-name', 't', '--item', '{}', '--dryrun'],
      ['dynamodb_delete_table', '--table-name', 't', '--confirm', '--dryrun'],
      ['logs_describe_log_groups'],
      ['ecs_list_clusters'],
      ['ecs_list_services', '--cluster', 'c'],
      ['ecs_describe_services', '--cluster', 'c', '--services', 's'],
      ['pricing_describe_services'],
      ['catalog'],
      ['lm_query', '--service', 'sts', '--operation', 'get-caller-identity'],
    ];
    expect(new Set(invocations.map((a) => a[0])).size).toBe(31);
    for (const args of invocations) {
      fake.setScenario({ default: { json: { ok: true } } });
      const r = await run(args);
      expect({ args, code: r.code }).toEqual({ args, code: 0 });
    }
  });

  test('lm_query optional flags and policy gates on the same instance', async () => {
    fake.setScenario({ default: { json: { Contents: [] } } });
    const q = await run(['lm_query', '--service', 's3api', '--operation', 'list-objects-v2', '--params', '"{}"', '--first-page', '--profile', 'p', '--region', 'r', '--select', '', '--timeout-seconds', '10']);
    expect(q.code).toBe(0);
    const ro = await run(['ec2_stop_instances', '--instance-ids', 'i-1', '--readonly']);
    expect(ro.code).toBe(6);
    const danger = await run(['cfn_delete_stack', '--stack-name', 's']);
    expect(danger.code).toBe(9);
    fake.setScenario({ default: { json: { ok: true } } });
    const env = await runConfigured(config, ['get_caller_identity'], fake.env({ AWS_REGION: 'x' }), fake.cwd);
    expect(env.code).toBe(0);
  });
});
