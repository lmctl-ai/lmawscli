/**
 * @fileoverview Controlled client-side pagination for aws2's generic `run`
 * pass-through. Follows NextToken (and common alias shapes) up to a
 * `--max-pages` cap; never runs unbounded loops.
 * @module aws2/pagination
 */

import { CliError, ErrorCode } from '@lmctl-ai/lmts/server';

import { execAws } from './exec.js';

export interface PaginationOptions {
  /** Hard page cap (default 1 = single page, no pagination). */
  maxPages?: number;
  /** --query passthrough. */
  query?: string;
  /** Extra global args (region/profile). */
  globalArgs?: string[];
  /** Cwd for the spawned process. */
  cwd: string;
  /** Service + op, for error context. */
  serviceForErrors: string;
  opForErrors: string;
}

/** Common continuation-token key names across AWS services. */
const NEXT_TOKEN_KEYS = [
  'NextToken',
  'NextMarker',
  'nextToken',
  'Marker',
  'LastEvaluatedKey',
  'LastEvaluatedTableName',
] as const;

/**
 * Map a token's envelope key to the flag that feeds it back into the service.
 * Default (--starting-token) matches the CLI's own paginator convention;
 * services with a different flag name go in TOKEN_FLAG_BY_KEY.
 */
const TOKEN_FLAG_BY_KEY: Record<string, string> = {
  LastEvaluatedTableName: '--exclusive-start-table-name',
};

function nextTokenFlag(tokenKey: string): string {
  return TOKEN_FLAG_BY_KEY[tokenKey] ?? '--starting-token';
}

function findNextToken(payload: unknown): { value: string; key: string } | undefined {
  if (payload === null || typeof payload !== 'object') return undefined;
  const obj = payload as Record<string, unknown>;
  for (const key of NEXT_TOKEN_KEYS) {
    const v = obj[key];
    if (typeof v === 'string' && v.length > 0) return { value: v, key };
    // LastEvaluatedKey is an object
    if (v !== null && typeof v === 'object' && !Array.isArray(v)) return { value: JSON.stringify(v), key };
  }
  return undefined;
}

/**
 * Execute an `aws` op following pagination up to maxPages. Pages are merged:
 * arrays under the same key are concatenated; scalar keys are overwritten by
 * later pages; the envelope records how many pages were fetched and whether
 * another page was still available.
 */
export async function execAwsPaginated<T = Record<string, unknown>>(
  argv: string[],
  options: PaginationOptions,
): Promise<T> {
  const maxPages = Math.max(1, options.maxPages ?? 1);
  const pages: Record<string, unknown>[] = [];
  let next: { value: string; key: string } | undefined;

  for (let page = 0; page < maxPages; page++) {
    const thisArgv = [...argv];
    if (next) {
      thisArgv.push(nextTokenFlag(next.key), next.value);
    }
    const pageResult = await execAws<Record<string, unknown>>(thisArgv, options.cwd, {
      query: options.query,
      globalArgs: options.globalArgs,
    });
    if (pageResult === null || typeof pageResult !== 'object' || Array.isArray(pageResult)) {
      // Non-envelope responses (arrays / scalars): cannot merge; return as-is on page 1.
      if (pages.length === 0) return pageResult as T;
      throw new CliError(
        ErrorCode.ParseError,
        `Pagination for ${options.serviceForErrors} ${options.opForErrors} returned a non-object on page ${pages.length + 1}; cannot merge.`,
      );
    }
    pages.push(pageResult);
    next = findNextToken(pageResult);
    if (!next) break;
  }

  const merged: Record<string, unknown> = {};
  for (const page of pages) {
    for (const [key, value] of Object.entries(page)) {
      if (NEXT_TOKEN_KEYS.includes(key as (typeof NEXT_TOKEN_KEYS)[number])) {
        continue; // handled by pagination envelope
      }
      const existing = merged[key];
      if (existing === undefined) {
        merged[key] = value;
      } else if (Array.isArray(existing) && Array.isArray(value)) {
        merged[key] = [...existing, ...value];
      } else {
        merged[key] = value; // later pages win for scalars
      }
    }
  }

  return {
    ...merged,
    _pagination: {
      pages: pages.length,
      maxPages,
      hasMore: Boolean(next),
      ...(next ? { nextToken: { [next.key]: next.value } } : {}),
    },
  } as T;
}
