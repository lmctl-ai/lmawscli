/**
 * @fileoverview Port of lmctl-ai/lmprobe `aws_command.rs` (the `lmprobe aws query`
 * family) as an aws2 module.
 *
 * Guarantees preserved:
 *  - Parameters flow to the AWS CLI as a single `--cli-input-json` argv
 *    entry; they are not expanded by the shell, treated as flags, or
 *    interpolated with `file://`.
 *  - Read-only allowlist enforced before any spawn (no mutation, no
 *    credential issuance, no secret extraction).
 *  - Response `Environment` fields are recursively redacted to [REDACTED].
 *  - First-page mode returns the native review-token model; paginated mode
 *    (default 100 items) uses the CLI's own NextToken as --starting-token.
 *  - --select is a JSON Pointer applied after coverage/redaction.
 * @module aws2/lm-query
 */

import { CliError, ErrorCode } from '@lmctl-ai/lmts/server';

import { lookupLmOperation, paginationSpecFor, type OperationSpec } from './aws-catalog.js';
import { execAwsWithCapture } from './exec.js';

const REQUEST_SCHEMA = 'lmprobe.aws.request.v1' as const;
const DEFAULT_TIMEOUT_SECONDS = 60;
const MAX_TIMEOUT_SECONDS = 300;
const MAX_ITEMS_CAP = 10000;

export interface LmQueryPagination {
  maxItems?: number;
  pageSize?: number;
  startingToken?: string;
  firstPage?: boolean;
}

export interface LmQueryInput {
  service: string;
  operation: string;
  /** AWS API parameters as a JSON object (native field names). */
  parameters?: Record<string, unknown>;
  profile?: string;
  region?: string;
  pagination?: LmQueryPagination;
  /** JSON Pointer applied after coverage/redaction. */
  select?: string;
  timeoutSeconds?: number;
}

export interface LmQueryResult {
  schema: 'lmprobe.aws_query.v1';
  exitStatus: 'matched' | 'no_match' | 'error';
  partial: boolean;
  complete: boolean;
  redactions: number;
  service: string;
  operation: string;
  profile?: string;
  region?: string;
  select?: string;
  data: unknown;
  page: {
    tokens: Record<string, unknown>;
    resumeToken?: string;
    nativeInputKey?: string;
    nativeOutputKey?: string;
    firstPage: boolean;
    startedFromToken: boolean;
    maxItems?: number;
  };
  awsFailures?: unknown[];
  exitCode?: number;
  warnings: Array<{ code: string; message: string; hint?: string }>;
}

function warn(code: string, message: string, hint?: string) {
  return { code, message, ...(hint !== undefined ? { hint } : undefined) };
}

function validatePointer(select: string): void {
  if (select !== '' && !select.startsWith('/')) {
    throw new CliError(ErrorCode.InvalidRequest, 'select must be a JSON Pointer (empty or /...)', {
      select,
    });
  }
  // Escape syntax: only ~0 and ~1 are defined by RFC 6901.
  for (let i = 0; i < select.length; i++) {
    if (select[i] === '~') {
      const next = select[i + 1];
      if (next !== '0' && next !== '1') {
        throw new CliError(
          ErrorCode.InvalidRequest,
          'invalid JSON Pointer escape (~ must be followed by 0 or 1)',
          { select },
        );
      }
      i++;
    }
  }
}

function jsonPointerGet(value: unknown, pointer: string): unknown | undefined {
  if (pointer === '') return value;
  if (!pointer.startsWith('/')) return undefined;
  const parts = pointer
    .slice(1)
    .split('/')
    .map((p) => p.replace(/~1/g, '/').replace(/~0/g, '~'));
  let current = value;
  for (const part of parts) {
    if (current === null || current === undefined || typeof current !== 'object') {
      return undefined;
    }
    if (Array.isArray(current)) {
      const idx = Number(part);
      if (!Number.isInteger(idx) || idx < 0 || idx >= current.length) return undefined;
      current = current[idx];
    } else {
      if (!(part in current)) return undefined;
      current = (current as Record<string, unknown>)[part];
    }
  }
  return current;
}

/** Recursively redact `Environment` fields (mirrors the Rust `redact`). */
function redact(data: unknown): { value: unknown; count: number } {
  if (Array.isArray(data)) {
    const items = data.map(redact);
    return { value: items.map((i) => i.value), count: items.reduce((n, i) => n + i.count, 0) };
  }
  if (data !== null && typeof data === 'object') {
    let count = 0;
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(data as Record<string, unknown>)) {
      if (key.toLowerCase() === 'environment' && value !== null) {
        out[key] = '[REDACTED]';
        count += 1;
      } else {
        const inner = redact(value);
        out[key] = inner.value;
        count += inner.count;
      }
    }
    return { value: out, count };
  }
  return { value: data, count: 0 };
}

function buildArgv(spec: OperationSpec, input: LmQueryInput): string[] {
  const args: string[] = [
    spec.service,
    spec.operation,
    '--output=json',
    '--no-cli-pager',
    '--no-cli-auto-prompt',
    '--color=off',
    '--cli-connect-timeout=10',
    '--cli-read-timeout=30',
  ];
  args.push(`--cli-input-json=${JSON.stringify(input.parameters ?? {})}`);
  if (input.profile) args.push(`--profile=${input.profile}`);
  if (input.region) args.push(`--region=${input.region}`);

  if (spec.paginated) {
    const p = input.pagination ?? {};
    if (p.firstPage) {
      args.push('--no-paginate');
    } else {
      args.push(`--max-items=${p.maxItems ?? 100}`);
      if (p.pageSize) args.push(`--page-size=${p.pageSize}`);
      if (p.startingToken) args.push(`--starting-token=${p.startingToken}`);
    }
  }
  return args;
}

function validate(input: LmQueryInput): OperationSpec {
  const spec = lookupLmOperation(input.service, input.operation);
  if (!spec) {
    throw new CliError(
      ErrorCode.InvalidRequest,
      `AWS_OPERATION_REFUSED: ${input.service} ${input.operation} is not in the read-only catalog`,
      { service: input.service, operation: input.operation },
    );
  }
  if (spec.paginated && paginationSpecFor(spec) === undefined) {
    throw new CliError(
      ErrorCode.InvalidRequest,
      'AWS_PAGINATION_UNSUPPORTED: no reviewed paginator model',
      { service: input.service, operation: input.operation },
    );
  }
  if (input.parameters !== undefined && (typeof input.parameters !== 'object' || input.parameters === null || Array.isArray(input.parameters))) {
    throw new CliError(ErrorCode.InvalidRequest, 'AWS_PARAMETERS_INVALID: parameters must be an object');
  }
  const timeout = input.timeoutSeconds ?? DEFAULT_TIMEOUT_SECONDS;
  if (timeout === 0 || timeout > MAX_TIMEOUT_SECONDS) {
    throw new CliError(
      ErrorCode.InvalidRequest,
      `AWS_TIMEOUT_INVALID: timeout_seconds must be 1..=${MAX_TIMEOUT_SECONDS}`,
    );
  }
  const page = input.pagination ?? {};
  const bad = (v: number | undefined) => v !== undefined && (v === 0 || v > MAX_ITEMS_CAP);
  if (bad(page.maxItems) || bad(page.pageSize)) {
    throw new CliError(
      ErrorCode.InvalidRequest,
      `AWS_PAGINATION_INVALID: item and page sizes must be 1..=${MAX_ITEMS_CAP}`,
    );
  }
  const controls =
    page.maxItems !== undefined || page.pageSize !== undefined || page.startingToken !== undefined;
  if (!spec.paginated && (controls || page.firstPage === true)) {
    throw new CliError(ErrorCode.InvalidRequest, 'AWS_PAGINATION_UNSUPPORTED: operation is not paginated');
  }
  if (page.firstPage === true && controls) {
    throw new CliError(
      ErrorCode.InvalidRequest,
      'AWS_PAGINATION_INVALID: firstPage cannot combine with pagination controls',
    );
  }
  if (input.select !== undefined) validatePointer(input.select);
  return spec;
}

export async function lmQuery(input: LmQueryInput, cwd: string): Promise<LmQueryResult> {
  const spec = validate(input);
  const args = buildArgv(spec, input);
  const timeoutMs = (input.timeoutSeconds ?? DEFAULT_TIMEOUT_SECONDS) * 1000;

  const page = input.pagination ?? {};
  const pageSpec = paginationSpecFor(spec);
  const warnings: LmQueryResult['warnings'] = [];

  const processEnv: Record<string, string> = {
    ...(process.env as Record<string, string>),
    AWS_PAGER: '',
    AWS_CLI_AUTO_PROMPT: 'off',
    AWS_MAX_ATTEMPTS: '2',
  };

  const result = await execAwsWithCapture(args, cwd, processEnv, timeoutMs);
  if (result.timedOut) {
    throw new CliError(ErrorCode.Timeout, 'AWS query exceeded the configured process deadline', {
      timeoutSeconds: input.timeoutSeconds ?? DEFAULT_TIMEOUT_SECONDS,
    });
  }
  if (result.exitCode !== 0) {
    throw new CliError(ErrorCode.CommandFailed, `aws exited non-zero: ${result.exitCode}`, {
      stderr: result.stderr.slice(0, 2048),
    });
  }

  let data: unknown;
  try {
    data = JSON.parse(result.stdout);
  } catch {
    throw new CliError(ErrorCode.ParseError, 'AWS_CLI_ERROR: AWS CLI did not return valid JSON');
  }

  const tokens: Record<string, unknown> = {};
  let resumeToken: string | undefined;
  let moreResults = false;
  if (page.firstPage === true && pageSpec) {
    const indicator =
      pageSpec.moreResults !== undefined
        ? ((data as Record<string, unknown>)?.[pageSpec.moreResults] as boolean | undefined)
        : undefined;
    const outTok = (data as Record<string, unknown> | undefined)?.[pageSpec.outputToken];
    if (
      typeof outTok === 'string' &&
      outTok !== '' &&
      indicator !== false
    ) {
      tokens[pageSpec.outputToken] = outTok;
    }
    moreResults = indicator === true;
  } else if (spec.paginated && page.firstPage !== true) {
    const nextTok = (data as Record<string, unknown> | undefined)?.['NextToken'];
    if (typeof nextTok === 'string' && nextTok !== '') {
      tokens['NextToken'] = nextTok;
      resumeToken = nextTok;
    }
  }

  const truncated = Object.keys(tokens).length > 0 || moreResults;
  const failuresRaw = (data as Record<string, unknown> | undefined)?.['failures']
    ?? (data as Record<string, unknown> | undefined)?.['Failures'];
  const failures = Array.isArray(failuresRaw) && failuresRaw.length > 0;

  if (truncated) {
    warnings.push(warn('AWS_PAGE_INCOMPLETE', 'Result has continuation data; coverage is incomplete'));
  }
  if (failures) {
    warnings.push(warn('AWS_PARTIAL_FAILURE', 'AWS returned per-resource failures alongside the result'));
  }

  const redacted = redact(data);
  data = redacted.value;
  if (redacted.count > 0) {
    warnings.push(warn('AWS_VALUES_REDACTED', 'Sensitive environment values were redacted'));
  }

  if (input.select !== undefined) {
    const selected = jsonPointerGet(data, input.select);
    if (selected === undefined) {
      warnings.push(warn('AWS_SELECT_NOT_FOUND', 'JSON Pointer does not exist in AWS response'));
      return {
        schema: 'lmprobe.aws_query.v1',
        exitStatus: 'error',
        partial: truncated || failures,
        complete: false,
        redactions: redacted.count,
        service: input.service,
        operation: input.operation,
        ...(input.profile !== undefined ? { profile: input.profile } : {}),
        ...(input.region !== undefined ? { region: input.region } : {}),
        select: input.select,
        data: null,
        page: {
          tokens,
          ...(resumeToken !== undefined ? { resumeToken } : {}),
          ...(pageSpec !== undefined ? { nativeInputKey: pageSpec.inputToken } : {}),
          ...(pageSpec !== undefined ? { nativeOutputKey: pageSpec.outputToken } : {}),
          firstPage: page.firstPage === true,
          startedFromToken: page.startingToken !== undefined,
          ...(spec.paginated && page.firstPage !== true
            ? { maxItems: page.maxItems ?? 100 }
            : {}),
        },
        warnings,
      };
    }
    data = selected;
  }

  const isEmptyArray = Array.isArray(data) && data.length === 0;
  return {
    schema: 'lmprobe.aws_query.v1',
    exitStatus: isEmptyArray ? 'no_match' : 'matched',
    partial: truncated || failures,
    complete: !truncated && !failures,
    redactions: redacted.count,
    service: input.service,
    operation: input.operation,
    ...(input.profile !== undefined ? { profile: input.profile } : {}),
    ...(input.region !== undefined ? { region: input.region } : {}),
    ...(input.select !== undefined ? { select: input.select } : {}),
    data,
    page: {
      tokens,
      ...(resumeToken !== undefined ? { resumeToken } : {}),
      ...(pageSpec !== undefined ? { nativeInputKey: pageSpec.inputToken } : {}),
      ...(pageSpec !== undefined ? { nativeOutputKey: pageSpec.outputToken } : {}),
      firstPage: page.firstPage === true,
      startedFromToken: page.startingToken !== undefined,
      ...(spec.paginated && page.firstPage !== true
        ? { maxItems: page.maxItems ?? 100 }
        : {}),
    },
    ...(failures ? { awsFailures: failuresRaw } : {}),
    warnings,
  };
}
