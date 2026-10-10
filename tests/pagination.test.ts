/**
 * @fileoverview src/pagination.ts against a hermetic fake `aws` scripted per
 * call index: token discovery, token->flag mapping, merging, caps and stops.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';

import { CliError, ErrorCode } from '@lmctl-ai/lmts/server';

import { execAwsPaginated } from '../src/pagination.js';
import { createFakeAws, swapProcessEnv, type FakeAws } from './helpers/fake-aws.js';

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

function opts(maxPages: number | undefined, extra: { query?: string; globalArgs?: string[] } = {}) {
  return {
    ...(maxPages !== undefined ? { maxPages } : {}),
    ...extra,
    cwd: fake.cwd,
    serviceForErrors: 'svc',
    opForErrors: 'op',
  };
}

const J = ['--output', 'json'];

describe('execAwsPaginated', () => {
  test('follows NextToken across pages, concatenates arrays, later scalars win', async () => {
    fake.setScenario({
      sequence: [
        { json: { Items: [1, 2], Count: 2, Meta: 'a', NextToken: 'tok1' } },
        { json: { Items: [3], Count: 1, Meta: 'b', NextToken: 'tok2' } },
        { json: { Items: [4], Count: 1, Extra: true } },
      ],
    });
    const r = await execAwsPaginated(['svc', 'op'], opts(10, { query: 'Q', globalArgs: ['--region', 'r'] }));
    expect(r).toEqual({
      Items: [1, 2, 3, 4],
      Count: 1,
      Meta: 'b',
      Extra: true,
      _pagination: { pages: 3, maxPages: 10, hasMore: false },
    });
    expect(fake.calls().map((c) => c.argv)).toEqual([
      ['svc', 'op', ...J, '--query', 'Q', '--region', 'r'],
      ['svc', 'op', '--starting-token', 'tok1', ...J, '--query', 'Q', '--region', 'r'],
      ['svc', 'op', '--starting-token', 'tok2', ...J, '--query', 'Q', '--region', 'r'],
    ]);
  });

  test('--max-pages caps the loop and reports hasMore + nextToken', async () => {
    fake.setScenario({ default: { json: { Things: ['x'], NextMarker: 'm' } } });
    const r = await execAwsPaginated(['svc', 'op'], opts(2));
    expect(r).toEqual({
      Things: ['x', 'x'],
      _pagination: { pages: 2, maxPages: 2, hasMore: true, nextToken: { NextMarker: 'm' } },
    });
    expect(fake.calls()).toHaveLength(2);
  });

  test('a service repeating the same token is still bounded by maxPages (no repeated-token guard)', async () => {
    fake.setScenario({ default: { json: { L: [0], NextToken: 'same' } } });
    const r = (await execAwsPaginated(['svc', 'op'], opts(3))) as Record<string, unknown>;
    expect(fake.calls()).toHaveLength(3);
    expect(fake.calls()[2]!.argv).toContain('same');
    expect(r['_pagination']).toMatchObject({ pages: 3, hasMore: true });
  });

  test('default / non-positive maxPages means a single page', async () => {
    fake.setScenario({ default: { json: { L: [1], NextToken: 'n' } } });
    expect(await execAwsPaginated<unknown>(['svc', 'op'], opts(undefined))).toEqual({
      L: [1],
      _pagination: { pages: 1, maxPages: 1, hasMore: true, nextToken: { NextToken: 'n' } },
    });
    fake.setScenario({ default: { json: { L: [1] } } });
    expect(await execAwsPaginated<unknown>(['svc', 'op'], opts(0))).toEqual({
      L: [1],
      _pagination: { pages: 1, maxPages: 1, hasMore: false },
    });
  });

  const tokenStyles: Array<[string, unknown, string, string]> = [
    ['NextToken', 'a', '--starting-token', 'a'],
    ['NextMarker', 'b', '--starting-token', 'b'],
    ['nextToken', 'c', '--starting-token', 'c'],
    ['Marker', 'd', '--starting-token', 'd'],
    ['LastEvaluatedKey', { id: { S: '1' } }, '--starting-token', '{"id":{"S":"1"}}'],
    ['LastEvaluatedTableName', 'tbl', '--exclusive-start-table-name', 'tbl'],
  ];
  for (const [key, value, flag, sent] of tokenStyles) {
    test(`token style ${key} -> ${flag}`, async () => {
      fake.setScenario({ sequence: [{ json: { R: [1], [key]: value } }, { json: { R: [2] } }] });
      const r = (await execAwsPaginated(['svc', 'op'], opts(3))) as Record<string, unknown>;
      expect(r['R']).toEqual([1, 2]);
      expect(r[key]).toBeUndefined(); // token keys are stripped from the merged body
      expect(fake.calls()[1]!.argv).toEqual(['svc', 'op', flag, sent, ...J]);
    });
  }

  test('empty-string / array / null tokens stop pagination', async () => {
    for (const body of [{ NextToken: '' }, { NextToken: ['x'] }, { NextToken: null }]) {
      fake.setScenario({ default: { json: { R: [1], ...body } } });
      const r = (await execAwsPaginated(['svc', 'op'], opts(4))) as Record<string, unknown>;
      expect(fake.calls()).toHaveLength(1);
      expect(r['_pagination']).toEqual({ pages: 1, maxPages: 4, hasMore: false });
    }
  });

  test('non-object first page is returned as-is (array, scalar, empty)', async () => {
    fake.setScenario({ default: { json: ['a', 'b'] } });
    expect(await execAwsPaginated<unknown>(['svc', 'op'], opts(3))).toEqual(['a', 'b']);
    fake.setScenario({ default: { stdout: 'text' } });
    expect(await execAwsPaginated<unknown>(['svc', 'op'], opts(3))).toBe('text');
    fake.setScenario({ default: { stdout: '' } });
    expect(await execAwsPaginated<unknown>(['svc', 'op'], opts(3))).toBeUndefined();
  });

  test('non-object on a later page is a PARSE_ERROR', async () => {
    fake.setScenario({ sequence: [{ json: { R: [1], NextToken: 'n' } }, { json: [1] }] });
    try {
      await execAwsPaginated(['svc', 'op'], opts(3));
      throw new Error('expected rejection');
    } catch (error) {
      expect(error).toBeInstanceOf(CliError);
      expect((error as CliError).code).toBe(ErrorCode.ParseError);
      expect((error as CliError).message).toContain('svc op');
      expect((error as CliError).message).toContain('page 2');
    }
  });

  test('aws failure mid-loop propagates the mapped error', async () => {
    fake.setScenario({
      sequence: [{ json: { R: [1], NextToken: 'n' } }, { stderr: 'ThrottlingException: Rate exceeded', exit: 254 }],
    });
    try {
      await execAwsPaginated(['svc', 'op'], opts(3));
      throw new Error('expected rejection');
    } catch (error) {
      expect((error as CliError).code).toBe(ErrorCode.CommandFailed);
      expect((error as CliError).data?.['exitCode']).toBe(254);
    }
  });
});
