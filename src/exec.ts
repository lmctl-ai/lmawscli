/**
 * @fileoverview aws CLI execution for aws2. Uses the shared spawnCommand
 * from @lmctl-ai/lmts/server, always passing --output json, and parsing stdout as
 * JSON when possible.
 * @module aws2/exec
 */

import { CliError, ErrorCode, spawnCommand } from '@lmctl-ai/lmts/server';

const AWS_COMMAND_TIMEOUT_MS = 120000;

function buildAwsEnv(): Record<string, string> {
  return {
    ...(process.env as Record<string, string>),
    AWS_PAGER: '', // never invoke a pager
    AWS_CLI_AUTO_PROMPT: 'off',
  };
}

function mapAwsError(error: unknown, argv: string[]): never {
  if (error instanceof CliError) throw error;
  const message = error instanceof Error ? error.message : String(error);
  if (/command not found|ENOENT|spawn aws/i.test(message)) {
    throw new CliError(
      ErrorCode.CommandNotFound,
      'aws CLI not found. Install: https://docs.aws.amazon.com/cli/latest/userguide/getting-started-install.html',
      undefined,
      { cause: error },
    );
  }
  if (/Unable to locate credentials|NoCredentialsError|could not be found/i.test(message)) {
    throw new CliError(
      ErrorCode.Forbidden,
      'AWS credentials not found. Configure via instance role, environment, or "aws configure".',
      { argv },
      { cause: error },
    );
  }
  if (/AccessDenied|Not authorized|UnauthorizedOperation/i.test(message)) {
    throw new CliError(ErrorCode.Forbidden, 'AWS access denied.', { argv, detail: message }, { cause: error });
  }
  if (/timed out|timeout/i.test(message)) {
    throw new CliError(ErrorCode.Timeout, message, { argv }, { cause: error });
  }
  const exitMatch = message.match(/Exit Code: (\d+)/);
  throw new CliError(
    ErrorCode.CommandFailed,
    message,
    { argv, exitCode: exitMatch ? Number(exitMatch[1]) : undefined },
    { cause: error },
  );
}

export interface ExecAwsOptions {
  /** Extra args appended to every call (e.g. --profile, --region). */
  globalArgs?: string[];
  /** JMESPath query (aws --query). */
  query?: string;
  allowNonZeroExit?: boolean;
}

function finalizeArgs(args: unknown[], options: ExecAwsOptions): string[] {
  const finalArgs = args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a)));
  if (!finalArgs.some((a) => a === '--output' || a.startsWith('--output='))) {
    finalArgs.push('--output', 'json');
  }
  if (options.query) {
    finalArgs.push('--query', options.query);
  }
  if (options.globalArgs) finalArgs.push(...options.globalArgs);
  return finalArgs;
}

/**
 * Execute an `aws` command. Always appends `--output json` unless the caller
 * already specified --output. Attempts to parse stdout as JSON; falls back to
 * raw trimmed text.
 */
export async function execAws<T = unknown>(
  args: string[],
  cwd: string,
  options: ExecAwsOptions = {},
): Promise<T> {
  const finalArgs = finalizeArgs(args, options);
  try {
    const result = await spawnCommand(
      'aws',
      finalArgs,
      cwd,
      buildAwsEnv(),
      AWS_COMMAND_TIMEOUT_MS,
      undefined,
      options.allowNonZeroExit,
    );
    return parseMaybeJson<T>(result.stdout);
  } catch (error) {
    mapAwsError(error, ['aws', ...finalArgs]);
  }
}

/**
 * Execute an `aws` command and always return raw text (e.g. for
 * `aws s3 ls` whose default output is not JSON).
 */
export async function execAwsText(
  args: string[],
  cwd: string,
  options: ExecAwsOptions = {},
): Promise<string> {
  const finalArgs = options.globalArgs ? finalizeArgs(args, options) : [...args];
  try {
    const result = await spawnCommand(
      'aws',
      finalArgs,
      cwd,
      buildAwsEnv(),
      AWS_COMMAND_TIMEOUT_MS,
      undefined,
      options.allowNonZeroExit,
    );
    return result.stdout.trim();
  } catch (error) {
    mapAwsError(error, ['aws', ...finalArgs]);
  }
}

function parseMaybeJson<T>(stdout: string): T {
  const trimmed = stdout.trim();
  if (trimmed === '') return undefined as T;
  const first = trimmed[0];
  if (first === '{' || first === '[') {
    try {
      return JSON.parse(trimmed) as T;
    } catch {
      // fall through
    }
  }
  return trimmed as T;
}

/** The argv that would be executed (used for dry-run results). */
export function buildArgv(args: string[], options: Omit<ExecAwsOptions, 'allowNonZeroExit'> = {}): string[] {
  return ['aws', ...finalizeArgs(args, options)];
}

export interface AwsCaptureResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  timedOut: boolean;
}

/**
 * Execute an `aws` command already fully formed (caller controls every flag;
 * used by the lmprobe-ported query layer and anything that needs raw stdout).
 * Never appends --output; the caller must include it.
 */
export async function execAwsWithCapture(
  args: string[],
  cwd: string,
  env: Record<string, string>,
  timeoutMs: number,
): Promise<AwsCaptureResult> {
  try {
    const result = await spawnCommand('aws', args, cwd, env, timeoutMs, undefined, false);
    return { stdout: result.stdout, stderr: result.stderr, exitCode: result.exitCode, timedOut: false };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/timed out/i.test(message)) {
      return { stdout: '', stderr: message, exitCode: -1, timedOut: true };
    }
    if (/command not found|ENOENT|spawn aws/i.test(message)) {
      throw new CliError(
        ErrorCode.CommandNotFound,
        'aws CLI not found.',
        undefined,
        { cause: error },
      );
    }
    // Non-zero exit: capture what we can from the combined error.
    const exitMatch = message.match(/Exit Code: (\d+)/);
    const stderrMatch = message.match(/Stderr: ([\s\S]*?)\nStdout: /);
    const stdoutMatch = message.match(/\nStdout: ([\s\S]*)$/);
    return {
      stdout: stdoutMatch?.[1] ?? '',
      stderr: stderrMatch?.[1] ?? message,
      exitCode: exitMatch ? Number(exitMatch[1]) : 1,
      timedOut: false,
    };
  }
}
