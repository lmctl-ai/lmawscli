/**
 * @fileoverview src/metadata.ts classification against data/api-metadata.json.
 */

import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { classifyOperation, listServices, toKebabOp, type ServiceMetadata } from '../src/metadata.js';

const DATA = JSON.parse(
  readFileSync(resolve(import.meta.dir, '../data/api-metadata.json'), 'utf-8'),
) as Record<string, ServiceMetadata>;

describe('metadata', () => {
  test('every readOnly / write entry in the data file classifies accordingly', () => {
    let checked = 0;
    for (const [service, meta] of Object.entries(DATA)) {
      for (const op of meta.readOnly) {
        // An op in both lists resolves to read (readOnly is checked first).
        expect(classifyOperation(service, op)).toBe('read');
        checked++;
      }
      for (const op of meta.write) {
        if (meta.readOnly.includes(op)) continue;
        expect(classifyOperation(service, op)).toBe('write');
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(1000);
  });

  test('credential-issuing overrides are writes', () => {
    expect(classifyOperation('sts', 'AssumeRole')).toBe('write');
    expect(classifyOperation('sts', 'AssumeRoleWithSAML')).toBe('write');
    expect(classifyOperation('sts', 'get-federation-token')).toBe('write');
    expect(classifyOperation('iam', 'CreateAccessKey')).toBe('write');
    expect(classifyOperation('sso', 'GetRoleCredentials')).toBe('write');
    expect(classifyOperation('sts', 'GetCallerIdentity')).toBe('read');
  });

  test('service aliases map to the underlying metadata', () => {
    const pairs: Array<[string, string]> = [['s3api', 's3'], ['efsapi', 'efs'], ['elb-api', 'elb'], ['elbv2api', 'elbv2']];
    for (const [alias, key] of pairs) {
      const meta = DATA[key]!;
      expect(classifyOperation(alias, meta.readOnly[0]!)).toBe('read');
      expect(classifyOperation(alias, meta.write[0]!)).toBe('write');
    }
    // high-level s3 'rb' is not in the metadata: unknown -> Aws2 defaults it to write
    expect(classifyOperation('s3', 'rb')).toBeUndefined();
    expect(classifyOperation('s3api', 'ls')).toBe('read');
  });

  test('unknown service or op is undefined (Aws2 then fails safe to write)', () => {
    expect(classifyOperation('nope', 'describe-x')).toBeUndefined();
    expect(classifyOperation('ec2', 'DescribeNothing')).toBeUndefined();
  });

  test('toKebabOp', () => {
    expect(toKebabOp('ListObjectsV2')).toBe('list-objects-v2');
    expect(toKebabOp('Describe-Instances')).toBe('describe-instances');
    expect(toKebabOp('x')).toBe('x');
  });

  test('listServices is sorted and matches the data file', () => {
    const services = listServices();
    expect(services).toEqual(Object.keys(DATA).sort());
    expect(services.length).toBe(381);
    // cached: same content on second call
    expect(listServices()).toEqual(services);
  });
});
