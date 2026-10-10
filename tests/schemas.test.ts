import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { ALL_AWS2_SCHEMAS } from '../src/schemas.js';
import { createFakeAws, type FakeAws } from './helpers/fake-aws.js';

const AWS2_CLI = resolve(import.meta.dir, '../src/cli.ts');

// Hermetic: fake aws first on PATH, temp HOME/cwd, no real AWS config.
let fake: FakeAws;
beforeAll(() => {
  fake = createFakeAws();
  fake.setScenario({ default: { json: {} } });
});
afterAll(() => fake.cleanup());

function runAws2(args: string[]) {
  const res = spawnSync(process.execPath, [AWS2_CLI, ...args], {
    encoding: 'utf-8',
    cwd: fake.cwd,
    env: fake.env({ NO_COLOR: '1' }),
    timeout: 30000,
  });
  return {
    status: res.status ?? 0,
    stdout: res.stdout ?? '',
    stderr: res.stderr ?? '',
  };
}

describe('aws2 authored schemas', () => {
  test('(a) every op in --list has an authored schema and --schema has 0 derived ops', () => {
    // 1. Check --schema output
    const schemaRes = runAws2(['--schema']);
    expect(schemaRes.status).toBe(0);
    const derivedMatches = schemaRes.stdout.match(/"derived"\s*:\s*true/g) ?? [];
    expect(derivedMatches.length).toBe(0);

    // 2. Check --list output
    const listRes = runAws2(['--list']);
    expect(listRes.status).toBe(0);
    const ops = JSON.parse(listRes.stdout) as Array<{ name: string; schema?: unknown }>;
    expect(ops.length).toBe(31);
    for (const op of ops) {
      expect(op.schema).toBeDefined();
    }
  });

  test('(b) every op has a non-empty description and every param has a description', () => {
    expect(ALL_AWS2_SCHEMAS.length).toBe(31);
    for (const schema of ALL_AWS2_SCHEMAS) {
      expect(schema.name).toBeTruthy();
      expect(typeof schema.description).toBe('string');
      expect(schema.description!.trim().length).toBeGreaterThan(0);
      for (const param of schema.params) {
        expect(param.name).toBeTruthy();
        expect(typeof param.description).toBe('string');
        expect(param.description!.trim().length).toBeGreaterThan(0);
      }
    }
  });

  test('(c) at least 5 ops pass validation with minimal valid input', () => {
    const opsToTest: Array<{ args: string[]; name: string }> = [
      { name: 's3_put_object', args: ['s3_put_object', '--bucket', 'b', '--key', 'k', '--body', '/tmp/f', '--dryrun'] },
      { name: 'ec2_stop_instances', args: ['ec2_stop_instances', '--instance-ids', '["i-123"]', '--dryrun'] },
      { name: 'lambda_invoke', args: ['lambda_invoke', '--function-name', 'fn', '--dryrun'] },
      { name: 'dynamodb_create_table', args: ['dynamodb_create_table', '--table-name', 't', '--attribute-definitions', 'a', '--key-schema', 'k', '--dryrun'] },
      { name: 'cfn_delete_stack', args: ['cfn_delete_stack', '--stack-name', 's', '--confirm', '--dryrun'] },
      { name: 'services', args: ['services'] },
    ];

    for (const { name, args } of opsToTest) {
      const res = runAws2(args);
      expect(res.status).toBe(0);
      expect(res.stdout).not.toContain('VALIDATION_ERROR');
      const parsed = JSON.parse(res.stdout);
      expect(parsed).toBeDefined();
      expect(name).toBeTruthy();
    }
    // every write above was --dryrun and `services` needs no aws: nothing spawned
    expect(fake.calls()).toHaveLength(0);
  });
});
