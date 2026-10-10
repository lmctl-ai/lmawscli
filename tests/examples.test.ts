import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const REPO_ROOT = resolve(import.meta.dir, '..');
const EXAMPLES_DIR = resolve(REPO_ROOT, 'examples');
const DEV_SCHEMA_FILE = resolve(REPO_ROOT, 'cli.schema.dev.json');
const LATEST_SCHEMA_FILE = resolve(REPO_ROOT, 'cli.schema.latest.json');

const schema = JSON.parse(readFileSync(DEV_SCHEMA_FILE, 'utf-8'));
const latestSchema = JSON.parse(readFileSync(LATEST_SCHEMA_FILE, 'utf-8'));
const recipeFiles = readdirSync(EXAMPLES_DIR).filter((f) => f.endsWith('.lms')).sort();

describe('LMScript examples contract and validation', () => {
  test('has at least 6 practical recipes', () => {
    expect(recipeFiles.length).toBeGreaterThanOrEqual(6);
  });

  for (const file of recipeFiles) {
    describe(`recipe: ${file}`, () => {
      const filePath = resolve(EXAMPLES_DIR, file);
      const content = readFileSync(filePath, 'utf-8');
      const lines = content.split('\n');

      test('(1) imports @lmctl-ai/lmaws and contains no http or absolute paths', () => {
        const importMatch = content.match(/^import\s+"@lmctl-ai\/lmaws"(?:\s+as\s+([A-Za-z_]\w*))?;/m);
        expect(importMatch).not.toBeNull();

        // No absolute path strings or http URLs
        expect(content).not.toContain('http://');
        expect(content).not.toContain('https://');
        expect(content).not.toMatch(/\/home\/[a-zA-Z0-9_.-]+/i);
        expect(content).not.toMatch(/\/Users\/[a-zA-Z0-9_.-]+/i);
        expect(content).not.toMatch(/\/root\/[a-zA-Z0-9_.-]+/i);
        expect(content).not.toMatch(/\/tmp\/[a-zA-Z0-9_.-]+/i);
      });

      test('(2) every <ns>.<op>( call refers to an operation in both dev and latest schemas', () => {
        const importMatch = content.match(/^import\s+"@lmctl-ai\/lmaws"(?:\s+as\s+([A-Za-z_]\w*))?;/m);
        const ns = importMatch?.[1] || schema.tool;

        const callRegex = new RegExp(`\\b${ns}\\.([a-z0-9_]+)\\s*\\(`, 'g');
        const opsCalled: string[] = [...content.matchAll(callRegex)].map((m) => m[1] as string);
        expect(opsCalled.length).toBeGreaterThan(0);

        const opNamesInDev = new Set<string>(schema.operations.map((o: any) => o.name as string));
        const opNamesInLatest = new Set<string>(latestSchema.operations.map((o: any) => o.name as string));
        for (const op of opsCalled) {
          if (!opNamesInDev.has(op)) {
            throw new Error(`Recipe ${file} calls unknown operation "${op}" (not found in cli.schema.dev.json)`);
          }
          if (!opNamesInLatest.has(op)) {
            throw new Error(`Recipe ${file} calls operation "${op}" not present in cli.schema.latest.json (default import requires latest)`);
          }
          expect(opNamesInDev.has(op)).toBe(true);
          expect(opNamesInLatest.has(op)).toBe(true);
        }
      });

      test('(3) for literal option maps, every key is a declared param (or readonly/confirm)', () => {
        const importMatch = content.match(/^import\s+"@lmctl-ai\/lmaws"(?:\s+as\s+([A-Za-z_]\w*))?;/m);
        const ns = importMatch?.[1] || schema.tool;

        const callWithLiteralRegex = new RegExp(`\\b${ns}\\.([a-z0-9_]+)\\s*\\([^)]*?(\\{[^{}]*\\})`, 'g');
        const matches = [...content.matchAll(callWithLiteralRegex)];

        const opsMap = new Map<string, any>(schema.operations.map((o: any) => [o.name, o]));

        for (const m of matches) {
          const opName = m[1] as string;
          const literalMap = m[2] as string;
          const op = opsMap.get(opName);
          expect(op).toBeDefined();

          const declaredParams = new Set<string>((op.params || []).map((p: any) => p.name as string));
          declaredParams.add('readonly');
          declaredParams.add('confirm');

          const keyMatches: string[] = [...literalMap.matchAll(/([A-Za-z_]\w*)\s*:/g)].map((km) => km[1] as string);
          for (const key of keyMatches) {
            if (!declaredParams.has(key)) {
              throw new Error(`Recipe ${file} passes undeclared param "${key}" to operation "${opName}"`);
            }
            expect(declaredParams.has(key)).toBe(true);
          }
        }
      });

      test('(4) has required header comment lines and <= 45 lines', () => {
        expect(lines.length).toBeLessThanOrEqual(45);

        expect(content).toMatch(/^\/\/\s*access:\s*(read|write)\b/m);
        expect(content).toMatch(/^\/\/\s*What it does:/m);
        expect(content).toMatch(/^\/\/\s*When to use it:/m);
        expect(content).toMatch(/^\/\/\s*How to run:\s*lmscript\s+examples\//m);
        expect(content).toMatch(/^\/\/\s*How to preview:\s*lmscript\s+--dry-run\s+examples\//m);
      });

      test('(6) declared access matches the operations called', () => {
        const accessMatch = content.match(/^\/\/\s*access:\s*(read|write)\b/m);
        expect(accessMatch).not.toBeNull();
        const declaredAccess = accessMatch![1];

        const importMatch = content.match(/^import\s+"@lmctl-ai\/lmaws"(?:\s+as\s+([A-Za-z_]\w*))?;/m);
        const ns = importMatch?.[1] || schema.tool;
        const callRegex = new RegExp(`\\b${ns}\\.([a-z0-9_]+)\\s*\\(`, 'g');
        const opsCalled: string[] = [...content.matchAll(callRegex)].map((m) => m[1] as string);

        const opsMap = new Map<string, any>(schema.operations.map((o: any) => [o.name, o]));

        if (declaredAccess === 'read') {
          for (const op of opsCalled) {
            const schemaOp = opsMap.get(op);
            expect(schemaOp.access).toBe('read');
          }
        } else {
          const hasWrite = opsCalled.some((op: string) => opsMap.get(op)?.access === 'write');
          expect(hasWrite).toBe(true);
        }
      });
    });
  }

  test('(5) examples/README.md indexes every recipe file and no missing/extra ones', () => {
    const readme = readFileSync(resolve(EXAMPLES_DIR, 'README.md'), 'utf-8');
    for (const file of recipeFiles) {
      expect(readme).toContain(`\`${file}\``);
    }
    const readmeRefs = [...readme.matchAll(/`([a-z0-9_-]+\.lms)`/g)].map((m) => m[1] as string);
    expect(readmeRefs.sort()).toEqual(recipeFiles.sort());
  });

  test('at least one recipe shows "as" import alias', () => {
    const hasAlias = recipeFiles.some((f) => {
      const c = readFileSync(resolve(EXAMPLES_DIR, f), 'utf-8');
      return /^import\s+"@lmctl-ai\/lmaws"\s+as\s+[A-Za-z_]\w*;/m.test(c);
    });
    expect(hasAlias).toBe(true);
  });
});
