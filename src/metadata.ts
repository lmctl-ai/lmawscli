// Modified by Lattice Systems LLC: derived from awslabs/aws-api-mcp-server (Apache-2.0) read/write classification,
// reimplemented in TypeScript for the aws2 CLI. See NOTICE.
/**
 * @fileoverview AWS operation read/write classification, loaded from
 * metadata derived from awslabs/aws-api-mcp-server's api_metadata.json
 * (plus their explicit overrides and hand-tuned custom read-only list).
 * @module aws2/metadata
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { Access } from '@lmctl-ai/lmts/server';

export interface ServiceMetadata {
  readOnly: string[];
  write: string[];
}

type MetadataFile = Record<string, ServiceMetadata>;

let cached: MetadataFile | undefined;

function loadMetadata(): MetadataFile {
  if (cached) return cached;
  const here = dirname(fileURLToPath(import.meta.url));
  const path = join(here, '..', 'data', 'api-metadata.json');
  cached = JSON.parse(readFileSync(path, 'utf-8')) as MetadataFile;
  return cached;
}

/** Convert an AWS CLI op name (kebab-case or PascalCase) to kebab-case. */
export function toKebabOp(name: string): string {
  if (name.includes('-')) return name.toLowerCase();
  return name.replace(/(?<!^)(?=[A-Z])/g, '-').toLowerCase();
}

/**
 * Aliases from aws CLI command names to service identifier keys used by
 * awslabs' metadata. The aws CLI splits S3 into `s3` (high-level) and
 * `s3api` (low-level); both are modeled against the s3 service metadata.
 */
const SERVICE_ALIASES: Record<string, string> = {
  s3api: 's3',
  efsapi: 'efs',
  'elb-api': 'elb',
  elbv2api: 'elbv2',
};

function resolveServiceKey(service: string): string {
  return SERVICE_ALIASES[service] ?? service;
}

/**
 * Classify an operation. Returns:
 *  - 'read'  when the service metadata says it is a known read-only op
 *  - 'write' when it is a known mutating op
 *  - undefined when the service/op is unknown (caller decides the fallback)
 */
export function classifyOperation(service: string, op: string): Access | undefined {
  const meta = loadMetadata()[resolveServiceKey(service)];
  if (!meta) return undefined;
  const kebab = toKebabOp(op);
  if (meta.readOnly.includes(kebab)) return 'read';
  if (meta.write.includes(kebab)) return 'write';
  return undefined;
}

/** List all services present in metadata. */
export function listServices(): string[] {
  return Object.keys(loadMetadata()).sort();
}
