/**
 * @fileoverview src/exec.ts against a hermetic fake `aws`: argv finalization,
 * env (pager / auto-prompt disabled), JSON parsing fallbacks and error mapping.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';

import { CliError, ErrorCode } from '@lmctl-ai/lmts/server';

import { buildArgv, execAws, execAwsText, execAwsWithCapture } from '../src/exec.js';
import { createBrokenAwsDir, createFakeAws, swapProcessEnv, type FakeAws } from './helpers/fake-aws.js';

let fake: FakeAws;
let restoreEnv: () => void;

beforeAll(() => {
  fake = createFakeAws();
});
afterAll(() => fake.cleanup());
beforeEach(() => {
  restoreEnv = swapProcessEnv(fake.env());
});
afterEach(() => restoreEnv());

async function catchErr(p: Promise<unknown>): Promise<CliError> {
  try {
    await p;
  } catch (error) {
    expect(error).toBeInstanceOf(CliError);
    return error as CliError;
  }
  throw new Error('expected rejection');
}

describe('buildArgv', () => {
  test('appends --output json, --query and global args in order', () => {
    expect(buildArgv(['ec2', 'describe-instances'])).toEqual([
      'aws', 'ec2', 'describe-instances', '--output', 'json',
    ]);
    expect(buildArgv(['s3', 'ls'], { query: 'x', globalArgs: ['--region', 'r'] })).toEqual([
      'aws', 's3', 'ls', '--output', 'json', '--query', 'x', '--region', 'r',
    ]);
  });

  test('does not duplicate --output when the caller set it', () => {
    expect(buildArgv(['s3', 'ls', '--output', 'text'])).toEqual(['aws', 's3', 'ls', '--output', 'text']);
    expect(buildArgv(['s3', 'ls', '--output=yaml'])).toEqual(['aws', 's3', 'ls', '--output=yaml']);
  });

  test('stringifies non-string args as JSON', () => {
    const args = ['x', { a: 1 }, 2] as unknown as string[];
    expect(buildArgv(args)).toEqual(['aws', 'x', '{"a":1}', '2', '--output', 'json']);
  });
});

describe('execAws', () => {
  test('spawns aws with --output json, AWS_PAGER="" and AWS_CLI_AUTO_PROMPT=off in cwd', async () => {
    fake.setScenario({ default: { json: { Account: '123' } } });
    const result = await execAws(['sts', 'get-caller-identity'], fake.cwd, {
      query: 'Account',
      globalArgs: ['--profile', 'p'],
    });
    expect(result).toEqual({ Account: '123' });
    const calls = fake.calls();
    expect(calls).toHaveLength(1);
    expect(calls[0]!.argv).toEqual([
      'sts', 'get-caller-identity', '--output', 'json', '--query', 'Account', '--profile', 'p',
    ]);
    expect(calls[0]!.env['AWS_PAGER']).toBe('');
    expect(calls[0]!.env['AWS_CLI_AUTO_PROMPT']).toBe('off');
    expect(calls[0]!.cwd).toBe(fake.cwd);
  });

  test('pager/auto-prompt overrides win over inherited env', async () => {
    restoreEnv();
    restoreEnv = swapProcessEnv(fake.env({ AWS_PAGER: 'less', AWS_CLI_AUTO_PROMPT: 'on' }));
    fake.setScenario({ default: { json: [] } });
    await execAws(['ec2', 'describe-regions'], fake.cwd);
    expect(fake.calls()[0]!.env['AWS_PAGER']).toBe('');
    expect(fake.calls()[0]!.env['AWS_CLI_AUTO_PROMPT']).toBe('off');
  });

  test('parses JSON arrays, returns undefined for empty stdout, raw text otherwise', async () => {
    fake.setScenario({ default: { stdout: '  [1,2]\n' } });
    expect(await execAws<unknown>(['a', 'b'], fake.cwd)).toEqual([1, 2]);
    fake.setScenario({ default: { stdout: '\n' } });
    expect(await execAws<unknown>(['a', 'b'], fake.cwd)).toBeUndefined();
    fake.setScenario({ default: { stdout: 'plain text\n' } });
    expect(await execAws<unknown>(['a', 'b'], fake.cwd)).toBe('plain text');
    // Invalid JSON that looks like JSON falls back to the trimmed raw text.
    fake.setScenario({ default: { stdout: '{"broken": \n' } });
    expect(await execAws<unknown>(['a', 'b'], fake.cwd)).toBe('{"broken":');
  });

  test('allowNonZeroExit returns stdout instead of throwing', async () => {
    fake.setScenario({ default: { json: { partial: true }, exit: 3 } });
    expect(await execAws<unknown>(['a', 'b'], fake.cwd, { allowNonZeroExit: true })).toEqual({ partial: true });
  });

  const mapping: Array<[string, string, number, ErrorCode]> = [
    ['AccessDenied', 'An error occurred (AccessDenied) when calling the X operation', 254, ErrorCode.Forbidden],
    ['UnauthorizedOperation', 'An error occurred (UnauthorizedOperation)', 254, ErrorCode.Forbidden],
    ['Not authorized', 'User is Not authorized to perform', 254, ErrorCode.Forbidden],
    ['no credentials', 'Unable to locate credentials. You can configure credentials by running "aws configure".', 253, ErrorCode.Forbidden],
    ['missing profile', 'The config profile (nope) could not be found', 255, ErrorCode.Forbidden],
    ['read timeout', 'Read timeout on endpoint URL: "https://ec2.amazonaws.com/"', 255, ErrorCode.Timeout],
    ['command not found', 'aws: command not found', 127, ErrorCode.CommandNotFound],
  ];
  for (const [label, stderr, exit, code] of mapping) {
    test(`maps ${label} to ${code}`, async () => {
      fake.setScenario({ default: { stderr, exit } });
      const err = await catchErr(execAws(['ec2', 'describe-instances'], fake.cwd));
      expect(err.code).toBe(code);
      if (code === ErrorCode.Forbidden && label !== 'no credentials' && label !== 'missing profile') {
        expect(err.data?.['detail']).toContain(stderr);
      }
      if (code !== ErrorCode.CommandNotFound) {
        expect(err.data?.['argv']).toEqual(['aws', 'ec2', 'describe-instances', '--output', 'json']);
      }
    });
  }

  test('ExpiredToken / throttling / not-found map to COMMAND_FAILED with exit code', async () => {
    const cases: Array<[string, number]> = [
      ['An error occurred (ExpiredToken) when calling the DescribeInstances operation: The security token included in the request is expired', 254],
      ['An error occurred (ThrottlingException) when calling the ListRoles operation (reached max retries: 2): Rate exceeded', 254],
      ['An error occurred (ResourceNotFoundException) when calling the DescribeTable operation: Requested resource not found', 254],
      ['usage: aws [options] <command> <subcommand>\naws: error: argument operation: Invalid choice', 252],
    ];
    for (const [stderr, exit] of cases) {
      fake.setScenario({ default: { stderr, exit } });
      const err = await catchErr(execAws(['x', 'y'], fake.cwd));
      expect(err.code).toBe(ErrorCode.CommandFailed);
      expect(err.data?.['exitCode']).toBe(exit);
      expect(err.message).toContain(stderr.split('\n')[0]!);
      expect(err.exitCode).toBe(1);
    }
  });

  test('missing aws on PATH maps to COMMAND_FAILED (Bun message is not ENOENT)', async () => {
    restoreEnv();
    restoreEnv = swapProcessEnv({ ...fake.env(), PATH: fake.home });
    const err = await catchErr(execAws(['sts', 'get-caller-identity'], fake.cwd));
    expect(err.code).toBe(ErrorCode.CommandFailed);
    expect(err.message).toContain('Executable not found');
    expect(err.data?.['exitCode']).toBeUndefined();
  });

  test('spawn ENOENT maps to COMMAND_NOT_FOUND', async () => {
    const broken = createBrokenAwsDir();
    try {
      restoreEnv();
      restoreEnv = swapProcessEnv({ ...fake.env(), PATH: broken.dir });
      const err = await catchErr(execAws(['sts', 'get-caller-identity'], fake.cwd));
      expect(err.code).toBe(ErrorCode.CommandNotFound);
      expect(err.message).toContain('aws CLI not found');
      const err2 = await catchErr(execAwsText(['s3', 'ls'], fake.cwd));
      expect(err2.code).toBe(ErrorCode.CommandNotFound);
    } finally {
      broken.cleanup();
    }
  });
});

describe('execAwsText', () => {
  test('passes argv verbatim (no --output) and trims stdout', async () => {
    fake.setScenario({ default: { stdout: '\n2024-01-01 00:00:00 a\n\n' } });
    expect(await execAwsText(['s3', 'ls'], fake.cwd)).toBe('2024-01-01 00:00:00 a');
    expect(fake.calls()[0]!.argv).toEqual(['s3', 'ls']);
    expect(fake.calls()[0]!.env['AWS_PAGER']).toBe('');
  });

  test('with globalArgs the argv is finalized (adds --output json)', async () => {
    fake.setScenario({ default: { stdout: 'x' } });
    await execAwsText(['s3', 'ls'], fake.cwd, { globalArgs: ['--region', 'eu-west-1'] });
    expect(fake.calls()[0]!.argv).toEqual(['s3', 'ls', '--output', 'json', '--region', 'eu-west-1']);
  });

  test('errors are mapped', async () => {
    fake.setScenario({ default: { stderr: 'AccessDenied', exit: 1 } });
    const err = await catchErr(execAwsText(['s3', 'ls'], fake.cwd));
    expect(err.code).toBe(ErrorCode.Forbidden);
    fake.setScenario({ default: { stderr: 'boom', exit: 2 } });
    const err2 = await catchErr(execAwsText(['s3', 'ls'], fake.cwd, { allowNonZeroExit: false }));
    expect(err2.code).toBe(ErrorCode.CommandFailed);
    expect(err2.data?.['exitCode']).toBe(2);
  });

  test('allowNonZeroExit returns stdout', async () => {
    fake.setScenario({ default: { stdout: 'ok', exit: 1 } });
    expect(await execAwsText(['s3', 'ls'], fake.cwd, { allowNonZeroExit: true })).toBe('ok');
  });
});

describe('execAwsWithCapture', () => {
  test('success returns raw stdout/stderr and uses the given env verbatim', async () => {
    fake.setScenario({ default: { stdout: '{"a":1}', stderr: 'warn' } });
    const r = await execAwsWithCapture(['x', 'y'], fake.cwd, { ...fake.env(), AWS_MAX_ATTEMPTS: '2' }, 10000);
    expect(r).toEqual({ stdout: '{"a":1}', stderr: 'warn', exitCode: 0, timedOut: false });
    expect(fake.calls()[0]!.argv).toEqual(['x', 'y']);
    expect(fake.calls()[0]!.env['AWS_MAX_ATTEMPTS']).toBe('2');
    expect(fake.calls()[0]!.env['AWS_PAGER']).toBeNull();
  });

  test('non-zero exit is captured, not thrown', async () => {
    fake.setScenario({ default: { stdout: 'partial-out', stderr: 'bad things', exit: 254 } });
    const r = await execAwsWithCapture(['x'], fake.cwd, fake.env(), 10000);
    expect(r).toEqual({ stdout: 'partial-out', stderr: 'bad things', exitCode: 254, timedOut: false });
  });

  test('deadline exceeded reports timedOut (fake blocks inside its own process)', async () => {
    fake.setScenario({ default: { sleepMs: 5000, stdout: '{}' } });
    const r = await execAwsWithCapture(['x'], fake.cwd, fake.env(), 50);
    expect(r.timedOut).toBe(true);
    expect(r.exitCode).toBe(-1);
    expect(r.stderr).toContain('timed out');
  });

  test('spawn ENOENT throws COMMAND_NOT_FOUND', async () => {
    const broken = createBrokenAwsDir();
    try {
      const err = await catchErr(execAwsWithCapture(['x'], fake.cwd, { PATH: broken.dir }, 1000));
      expect(err.code).toBe(ErrorCode.CommandNotFound);
    } finally {
      broken.cleanup();
    }
  });

  test('missing executable falls back to exit 1 with the message as stderr', async () => {
    const r = await execAwsWithCapture(['x'], fake.cwd, { PATH: fake.home }, 1000);
    expect(r.exitCode).toBe(1);
    expect(r.stdout).toBe('');
    expect(r.stderr).toContain('Executable not found');
  });
});
