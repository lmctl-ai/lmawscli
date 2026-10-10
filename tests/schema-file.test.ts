import { describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { parsePublishedSchema } from '@lmctl-ai/lmts/validate';

const REPO_ROOT = resolve(import.meta.dir, '..');
const DEV_SCHEMA_FILE = resolve(REPO_ROOT, 'cli.schema.dev.json');
const LATEST_SCHEMA_FILE = resolve(REPO_ROOT, 'cli.schema.latest.json');
const PACKAGE_JSON = resolve(REPO_ROOT, 'package.json');

describe('channel schema files (cli.schema.dev.json & cli.schema.latest.json)', () => {
  test('(a) committed cli.schema.dev.json matches bun src/cli.ts --schema exactly byte-for-byte', () => {
    const committed = readFileSync(DEV_SCHEMA_FILE, 'utf-8');
    const stdout = execFileSync('bun', ['src/cli.ts', '--schema'], {
      cwd: REPO_ROOT,
      encoding: 'utf-8',
    });

    if (stdout !== committed) {
      throw new Error('run: bun src/cli.ts --schema > cli.schema.dev.json');
    }
    expect(stdout).toBe(committed);
  });

  test('(b) both dev and latest parse successfully with parsePublishedSchema', () => {
    const devRaw = readFileSync(DEV_SCHEMA_FILE, 'utf-8');
    const devJson = JSON.parse(devRaw);
    const devRes = parsePublishedSchema(devJson);
    expect(devRes.ok).toBe(true);

    const latestRaw = readFileSync(LATEST_SCHEMA_FILE, 'utf-8');
    const latestJson = JSON.parse(latestRaw);
    const latestRes = parsePublishedSchema(latestJson);
    expect(latestRes.ok).toBe(true);
  });

  test('(c) latest tool name matches dev and matches package.json bin', () => {
    const devSchema = JSON.parse(readFileSync(DEV_SCHEMA_FILE, 'utf-8'));
    const latestSchema = JSON.parse(readFileSync(LATEST_SCHEMA_FILE, 'utf-8'));
    const pkg = JSON.parse(readFileSync(PACKAGE_JSON, 'utf-8'));
    const binNames = Object.keys(pkg.bin || {});

    expect(latestSchema.tool).toBe(devSchema.tool);
    expect(binNames).toContain(devSchema.tool);
  });

  test('(d) evolution rules: differences between latest and dev are additive only', () => {
    const devSchema = JSON.parse(readFileSync(DEV_SCHEMA_FILE, 'utf-8'));
    const latestSchema = JSON.parse(readFileSync(LATEST_SCHEMA_FILE, 'utf-8'));

    const devOps = new Map<string, any>(devSchema.operations.map((o: any) => [o.name, o]));

    // Every operation in latest must exist in dev
    for (const latestOp of latestSchema.operations) {
      const devOp = devOps.get(latestOp.name);
      expect(devOp).toBeDefined();
      if (!devOp) {
        throw new Error(`Breaking change: operation "${latestOp.name}" present in latest was removed from dev`);
      }

      // Access must not be weaker (must match or preserve protection)
      expect(devOp.access).toBe(latestOp.access);

      // All required params in latest must still exist and be required in dev
      const devParams = new Map<string, any>((devOp.params || []).map((p: any) => [p.name, p]));
      for (const latestParam of (latestOp.params || [])) {
        const isRequired = latestParam.occurs === '1' || latestParam.occurs === '+';
        if (isRequired) {
          const devParam = devParams.get(latestParam.name);
          expect(devParam).toBeDefined();
          if (!devParam) {
            throw new Error(
              `Breaking change: required param "${latestParam.name}" of operation "${latestOp.name}" was removed in dev`,
            );
          }
          const devRequired = devParam.occurs === '1' || devParam.occurs === '+';
          expect(devRequired).toBe(true);
          expect(devParam.type).toBe(latestParam.type);
        }
      }
    }
  });

  test('(e) every operation in dev and latest has description and valid access', () => {
    for (const file of [DEV_SCHEMA_FILE, LATEST_SCHEMA_FILE]) {
      const schema = JSON.parse(readFileSync(file, 'utf-8'));
      expect(Array.isArray(schema.operations)).toBe(true);
      expect(schema.operations.length).toBeGreaterThan(0);

      for (const op of schema.operations) {
        expect(['read', 'write', 'dynamic']).toContain(op.access);
        expect(typeof op.description).toBe('string');
        expect(op.description.trim().length).toBeGreaterThan(0);
      }
    }
  });

  test('(f) no absolute paths or home directories inside dev or latest schema files', () => {
    const home = process.env.HOME || homedir();
    for (const file of [DEV_SCHEMA_FILE, LATEST_SCHEMA_FILE]) {
      const raw = readFileSync(file, 'utf-8');
      expect(raw).not.toContain(home);
      expect(raw).not.toMatch(/\/home\/[a-zA-Z0-9_.-]+/);
      expect(raw).not.toMatch(/\/Users\/[a-zA-Z0-9_.-]+/);
      expect(raw).not.toMatch(/\/root\/[a-zA-Z0-9_.-]+/);
      expect(raw).not.toMatch(/\/tmp\/[a-zA-Z0-9_.-]+/);
    }
  });
});
