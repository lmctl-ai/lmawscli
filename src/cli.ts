#!/usr/bin/env bun
/**
 * @fileoverview aws2 CLI entry point.
 *
 * Usage:
 *   aws2 <operation> [options]
 *   aws2 run --service ec2 --op describe-instances --args '["--filters","..."]'
 *   aws2 exec ec2 describe-instances --filters ...
 *
 * Global options: --dryrun, --readonly, --list, --region, --profile
 * All results print structured JSON to stdout.
 * @module aws2/cli
 */

import { CliError, ErrorCode, runCli, type OpDef, type Policy } from '@lmctl-ai/lmts/server';
import { readFileSync } from 'node:fs';

import { Aws2, type RunExtras } from './api.js';
import { listServices } from './metadata.js';
import { ALL_AWS2_SCHEMAS } from './schemas.js';

interface Aws2Ctx {
  aws: Aws2;
}

const schemaMap = new Map(ALL_AWS2_SCHEMAS.map((s) => [s.name, s]));

type Runner<P> = (aws: Aws2, p: P, extras?: RunExtras) => Promise<unknown>;

/** Consume extras (--query, --max-pages, --confirm) that apply to all ops. */
function takeExtras(params: Record<string, unknown>, policy?: Policy): RunExtras {
  const extras: RunExtras = {};
  if (typeof params['query'] === 'string') extras.query = params['query'];
  if (typeof params['maxPages'] === 'number') extras.maxPages = params['maxPages'];
  if (policy?.confirmed === true || params['confirm'] === true || params['iUnderstand'] === true) {
    extras.confirmed = true;
  }
  delete params['query'];
  delete params['maxPages'];
  delete params['confirm'];
  delete params['iUnderstand'];
  return extras;
}

function op<P>(
  name: string,
  access: 'read' | 'write' | 'dynamic',
  description: string,
  run: Runner<P>,
  _params: Record<string, string> = {},
): OpDef<Aws2Ctx> {
  const inputSchema = schemaMap.get(name);
  return {
    name,
    access: (inputSchema?.access as 'read' | 'write' | 'dynamic') ?? access,
    description: inputSchema?.description ?? description,
    inputSchema,
    run: async (p, ctx) => {
      const extras = takeExtras(p, ctx.aws.policy);
      return run(ctx.aws, { ...(p as unknown as P), _extras: extras } as P);
    },
  };
}

type WithExtras<P> = P & { _extras?: RunExtras };

function makeOps(): OpDef<Aws2Ctx>[] {
  return [
    // ---- Generic pass-through ----
    op(
      'run',
      'dynamic',
      'Run an arbitrary AWS op: aws2 run --service ec2 --op describe-instances [--args \'["--filters","..."]\']',
      async (raw, p: WithExtras<{ service: string; op: string; args?: string[] | string }>) => {
        const argv: string[] =
          typeof p.args === 'string'
            ? (JSON.parse(p.args) as string[])
            : (p.args ?? []);
        return raw.run(p.service, p.op, argv, p._extras);
      },
      {
        service: 'AWS service, e.g. ec2, s3, s3api (required)',
        op: 'Operation in kebab-case, e.g. describe-instances (required)',
        args: 'Extra args as JSON array, e.g. \'["--filters","Name=..."]\'',
      },
    ),
    {
      name: 'exec',
      access: 'dynamic',
      description: 'Raw argv pass-through: aws2 exec s3api list-buckets',
      inputSchema: schemaMap.get('exec'),
      run: async (p, ctx) => {
        const positional = (p['_'] as string[] | undefined) ?? [];
        const extras = takeExtras(p, ctx.aws.policy);
        return ctx.aws.execArgs(positional, extras);
      },
    },
    op(
      'services',
      'read',
      'List all AWS services present in the read/write metadata (381 services)',
      () => Promise.resolve({ services: listServices() }),
    ),

    // ---- sts ----
    op('get_caller_identity', 'read', 'STS GetCallerIdentity', (aws) => aws.getCallerIdentity()),

    // ---- s3 ----
    op('s3_list_buckets', 'read', 'List all S3 buckets', (aws) => aws.s3ListBuckets()),
    op('s3_list_objects', 'read', 'List objects in an S3 bucket',
      (aws, p: { bucket: string; prefix?: string }) => aws.s3ListObjects(p),
      { bucket: 'Bucket name (required)', prefix: 'Prefix filter' }),
    op('s3_put_object', 'write', 'Put an object into S3',
      (aws, p: { bucket: string; key: string; body: string }) => aws.s3PutObject(p),
      { bucket: 'Bucket (required)', key: 'Object key (required)', body: 'File path to upload (required)' }),
    op('s3_get_object', 'read', 'Get an object body (to stdout)',
      (aws, p: { bucket: string; key: string }) => aws.s3GetObject(p),
      { bucket: 'Bucket (required)', key: 'Object key (required)' }),

    // ---- ec2 ----
    op('ec2_describe_instances', 'read', 'Describe EC2 instances',
      (aws, p: { filters?: string; maxResults?: number }) => aws.ec2DescribeInstances(p),
      { filters: 'ec2 --filters string', maxResults: 'Page size' }),
    op('ec2_stop_instances', 'write', 'Stop EC2 instances',
      (aws, p: { instanceIds: string[] }) => aws.ec2StopInstances(p),
      { instanceIds: 'JSON array of instance IDs (required)' }),
    op('ec2_start_instances', 'write', 'Start EC2 instances',
      (aws, p: { instanceIds: string[] }) => aws.ec2StartInstances(p),
      { instanceIds: 'JSON array of instance IDs (required)' }),
    op('ec2_reboot_instances', 'write', 'Reboot EC2 instances',
      (aws, p: { instanceIds: string[] }) => aws.ec2RebootInstances(p),
      { instanceIds: 'JSON array of instance IDs (required)' }),

    // ---- iam ----
    op('iam_list_roles', 'read', 'List IAM roles',
      (aws, p: { maxItems?: number; pathPrefix?: string }) => aws.iamListRoles(p),
      { maxItems: 'Page size', pathPrefix: 'Filter by path' }),
    op('iam_list_users', 'read', 'List IAM users',
      (aws, p: { maxItems?: number }) => aws.iamListUsers(p),
      { maxItems: 'Page size' }),
    op('iam_list_policies', 'read', 'List IAM policies',
      (aws, p: { scope?: 'All' | 'AWS' | 'Local'; maxItems?: number }) => aws.iamListPolicies(p),
      { scope: 'All|AWS|Local', maxItems: 'Page size' }),

    // ---- lambda ----
    op('lambda_list_functions', 'read', 'List Lambda functions',
      (aws, p: { maxItems?: number }) => aws.lambdaListFunctions(p),
      { maxItems: 'Page size' }),
    op('lambda_invoke', 'write', 'Invoke a Lambda function',
      (aws, p: { functionName: string; payload?: string }) => aws.lambdaInvoke(p),
      { functionName: 'Function name (required)', payload: 'JSON payload' }),

    // ---- cloudformation ----
    op('cfn_list_stacks', 'read', 'List CloudFormation stacks',
      (aws, p: { statusFilter?: string }) => aws.cfnListStacks(p),
      { statusFilter: 'Stack status filter' }),
    op('cfn_describe_stacks', 'read', 'Describe CloudFormation stacks',
      (aws, p: { stackName?: string }) => aws.cfnDescribeStacks(p),
      { stackName: 'Stack name (optional)' }),
    op('cfn_delete_stack', 'write', 'DESTRUCTIVE: delete a CloudFormation stack (requires --confirm)',
      (aws, p: { stackName: string }) => aws.cfnDeleteStack(p),
      { stackName: 'Stack name (required)' }),

    // ---- dynamodb ----
    op('dynamodb_list_tables', 'read', 'List DynamoDB tables',
      (aws, p: { limit?: number }) => aws.dynamodbListTables(p),
      { limit: 'Max tables' }),
    op('dynamodb_create_table', 'write', 'Create a DynamoDB table',
      (aws, p: { tableName: string; attributeDefinitions: string; keySchema: string; billingMode?: 'PROVISIONED' | 'PAY_PER_REQUEST' }) =>
        aws.dynamodbCreateTable(p),
      {
        tableName: 'Table name (required)',
        attributeDefinitions: 'aws shorthand or JSON (required)',
        keySchema: 'aws shorthand or JSON (required)',
        billingMode: 'PROVISIONED|PAY_PER_REQUEST (default PAY_PER_REQUEST)',
      }),
    op('dynamodb_put_item', 'write', 'Put an item into a DynamoDB table',
      (aws, p: { tableName: string; item: string }) => aws.dynamodbPutItem(p),
      { tableName: 'Table name (required)', item: 'Item JSON (required)' }),
    op('dynamodb_delete_table', 'write', 'DESTRUCTIVE: delete a DynamoDB table (requires --confirm)',
      (aws, p: { tableName: string }) => aws.dynamodbDeleteTable(p),
      { tableName: 'Table name (required)' }),

    // ---- logs ----
    op('logs_describe_log_groups', 'read', 'Describe CloudWatch log groups',
      (aws, p: { limit?: number; logGroupNamePrefix?: string }) => aws.logsDescribeLogGroups(p),
      { limit: 'Page size', logGroupNamePrefix: 'Prefix' }),

    // ---- ecs ----
    op('ecs_list_clusters', 'read', 'List ECS clusters', (aws) => aws.ecsListClusters()),
    op('ecs_list_services', 'read', 'List ECS services in a cluster',
      (aws, p: { cluster: string; maxResults?: number }) => aws.ecsListServices(p),
      { cluster: 'Cluster name/ARN (required)', maxResults: 'Page size' }),
    op('ecs_describe_services', 'read', 'Describe ECS services',
      (aws, p: { cluster: string; services: string[] }) => aws.ecsDescribeServices(p),
      { cluster: 'Cluster name/ARN (required)', services: 'JSON array of service names/ARNs (required)' }),

    // ---- pricing ----
    op('pricing_describe_services', 'read', 'Pricing DescribeServices (us-east-1 only)',
      (aws, p: { serviceCode?: string; maxResults?: number }) => aws.pricingDescribeServices(p),
      { serviceCode: 'Service code', maxResults: 'Page size' }),

    // ---- lmprobe-ported ops ----
    op('catalog', 'read', 'List the reviewed, allowlisted read-only AWS operations',
      (aws) => aws.catalog()),
    op(
      'lm_query',
      'read',
      'Allowlisted AWS query with JSON parameters, redaction, and pagination (lmprobe-style)',
      (aws, p: WithExtras<{
        service: string;
        operation: string;
        params?: string | Record<string, unknown>;
        profile?: string;
        region?: string;
        maxItems?: number;
        pageSize?: number;
        startingToken?: string;
        firstPage?: boolean;
        select?: string;
        timeoutSeconds?: number;
      }>) =>
        aws.lmQuery({
          service: p.service,
          operation: p.operation,
          parameters:
            typeof p.params === 'string' ? (JSON.parse(p.params) as Record<string, unknown>) : p.params,
          ...(p.profile !== undefined ? { profile: p.profile } : {}),
          ...(p.region !== undefined ? { region: p.region } : {}),
          pagination: {
            ...(p.maxItems !== undefined ? { maxItems: p.maxItems } : {}),
            ...(p.pageSize !== undefined ? { pageSize: p.pageSize } : {}),
            ...(p.startingToken !== undefined ? { startingToken: p.startingToken } : {}),
            ...(p.firstPage === true ? { firstPage: true } : {}),
          },
          ...(p.select !== undefined ? { select: p.select } : {}),
          ...(p.timeoutSeconds !== undefined ? { timeoutSeconds: p.timeoutSeconds } : {}),
        }),
      {
        service: 'AWS service from the catalog (ec2, s3api, iam, ...)',
        operation: 'Exact operation name (describe-instances, list-objects-v2, ...)',
        params: 'JSON object of AWS API parameters (native field names)',
        profile: 'AWS CLI profile',
        region: 'AWS region',
        maxItems: 'Cap on paginated results (default 100; 1..10000)',
        pageSize: 'Native page size (paginated ops only)',
        startingToken: 'Resume token from a previous query',
        firstPage: 'Only fetch the first page (conflicts with pagination controls)',
        select: 'JSON Pointer, e.g. /Reservations/0/Instances',
        timeoutSeconds: 'Process deadline (1..300; default 60)',
      },
    ),
  ];
}

async function main(): Promise<number> {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf-8')) as { version?: string };
  return runCli<Aws2Ctx>(
    {
      toolName: 'aws2',
      version: pkg.version ?? 'unknown',
      description:
        'Structured AWS CLI wrapper, with metadata-driven read/write classification, dry-run and read-only policy. Reads always execute; writes are simulated in dry-run and refused in read-only. Output is JSON.',
      ops: makeOps(),
      buildContext: (policy: Policy): Aws2Ctx => ({
        aws: new Aws2({
          policy,
          region: process.env['AWS_REGION'] ?? process.env['AWS_DEFAULT_REGION'],
          profile: process.env['AWS_PROFILE'],
        }),
      }),
    },
    process.argv.slice(2),
  );
}

void main().then((code) => process.exit(code));
