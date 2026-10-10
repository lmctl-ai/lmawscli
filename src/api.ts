/**
 * @fileoverview aws2 core API — generic pass-through (aws2_run) with
 * metadata-driven read/write classification, plus curated operation
 * implementations for core services.
 * @module aws2/api
 */

import {
  checkPolicy,
  CliError,
  ErrorCode,
  isDryRunResult,
  type Access,
  type DryRunResult,
  type Policy,
} from '@lmctl-ai/lmts/server';

import { classifyOperation, toKebabOp } from './metadata.js';
import { buildArgv, execAws, execAwsText } from './exec.js';

export interface Aws2Options {
  policy?: Partial<Policy>;
  cwd?: string;
  /** AWS region appended to calls (else rely on aws CLI default chain). */
  region?: string;
  /** AWS profile appended to calls. */
  profile?: string;
}

export interface RunExtras {
  /** JMESPath query (aws --query). */
  query?: string;
  /** Max pages to follow NextToken (default 1 = single page). */
  maxPages?: number;
  /** Attestation for dangerous ops (from --confirm / --i-understand). */
  confirmed?: boolean;
  /** Internal: mark call as destructive (used by curated ops). */
  dangerous?: boolean;
}

/** ops that are destructive/irreversible for a given service, kebab-case. */
const DANGEROUS_OPS: Record<string, string[]> = {
  s3: ['rm', 'rb'],
  s3api: ['delete-bucket', 'delete-object', 'delete-objects'],
  ec2: ['terminate-instances', 'delete-security-group', 'delete-vpc', 'delete-subnet', 'delete-key-pair', 'delete-snapshot', 'delete-volume'],
  lambda: ['delete-function', 'delete-layer-version'],
  iam: ['delete-role', 'delete-user', 'delete-policy', 'delete-access-key', 'detach-role-policy', 'detach-user-policy', 'delete-instance-profile'],
  dynamodb: ['delete-table'],
  logs: ['delete-log-group', 'delete-log-stream'],
  ecs: ['delete-cluster', 'delete-service'],
  cloudformation: ['delete-stack'],
  rds: ['delete-db-instance', 'delete-db-cluster', 'delete-db-snapshot'],
  ecr: ['delete-repository', 'batch-delete-image'],
};

export class Aws2 {
  readonly policy: Policy;
  readonly cwd: string;
  readonly region?: string;
  readonly profile?: string;

  constructor(options: Aws2Options = {}) {
    this.policy = {
      dryRun: options.policy?.dryRun ?? false,
      readOnly: options.policy?.readOnly ?? false,
    };
    this.cwd = options.cwd ?? process.cwd();
    if (options.region) this.region = options.region;
    if (options.profile) this.profile = options.profile;
  }

  private globalArgs(): string[] {
    const args: string[] = [];
    if (this.region) args.push('--region', this.region);
    if (this.profile) args.push('--profile', this.profile);
    return args;
  }

  /**
   * Classify via metadata; unknown services/ops default to 'write' (fail
   * safe: they are refused under read-only mode and simulated under dry-run).
   */
  classify(service: string, op: string): Access {
    return classifyOperation(service, op) ?? 'write';
  }

  /** True when the op is in DANGEROUS_OPS for the service. */
  isDangerous(service: string, op: string): boolean {
    return (DANGEROUS_OPS[service] ?? []).includes(toKebabOp(op));
  }

  private guard(
    access: Access,
    name: string,
    args: string[],
    extras: RunExtras = {},
  ): DryRunResult | undefined {
    return checkPolicy(access, this.policy, {
      name,
      command: buildArgv(args, {
        globalArgs: this.globalArgs(),
        ...(extras.query ? { query: extras.query } : {}),
      }),
      dangerous: extras.dangerous ?? false,
      confirmed: extras.confirmed ?? false,
    });
  }

  // ----------------------------------------------------------------------
  // Generic pass-through
  // ----------------------------------------------------------------------

  /**
   * Run an arbitrary `aws` CLI invocation. Read ops execute; write ops go
   * through policy. Output is JSON-parsed when possible. When the underlying
   * response has no body (common for writes), an explicit success envelope is
   * returned so callers always receive non-empty JSON.
   */
  async run(service: string, op: string, args: string[] = [], extras: RunExtras = {}): Promise<unknown> {
    const access = this.classify(service, op);
    const dangerous = this.isDangerous(service, op);
    const argv = [service, op, ...args];
    const simulated = this.guard(access, `aws_${service}_${op}`, argv, { ...extras, dangerous });
    if (simulated && isDryRunResult(simulated)) return simulated;

    if ((extras.maxPages ?? 1) > 1) {
      const { execAwsPaginated } = await import('./pagination.js');
      return execAwsPaginated(argv, {
        maxPages: extras.maxPages,
        query: extras.query,
        globalArgs: this.globalArgs(),
        cwd: this.cwd,
        serviceForErrors: service,
        opForErrors: op,
      });
    }

    const result = await execAws(argv, this.cwd, {
      globalArgs: this.globalArgs(),
      ...(extras.query ? { query: extras.query } : {}),
    });
    return result === undefined
      ? { success: true, service, op }
      : result;
  }

  /** Raw argv pass-through (aws2 exec). argv[0] is the service. */
  async execArgs(argv: string[], extras: RunExtras = {}): Promise<unknown> {
    const service = argv[0];
    const op = argv[1];
    if (!service || !op) {
      throw new CliError(
        ErrorCode.InvalidRequest,
        'aws2 exec requires at least a service and operation, e.g. "aws2 exec s3api list-buckets"',
      );
    }
    return this.run(service, op, argv.slice(2), extras);
  }

  // ----------------------------------------------------------------------
  // sts
  // ----------------------------------------------------------------------

  async getCallerIdentity() {
    const args = ['sts', 'get-caller-identity'];
    this.guard('read', 'aws_sts_get_caller_identity', args);
    return execAws(args, this.cwd, { globalArgs: this.globalArgs() });
  }

  // ----------------------------------------------------------------------
  // s3
  // ----------------------------------------------------------------------

  /** List buckets (s3 ls) — returns lines + parsed array. */
  async s3ListBuckets(): Promise<unknown> {
    const args = ['s3', 'ls'];
    this.guard('read', 'aws_s3_ls', args);
    const text = await execAwsText(args, this.cwd, { globalArgs: this.globalArgs() });
    const buckets = text
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        const m = line.match(/^(\d{4}-\d{2}-\d{2})\s+(\S+)\s+(.+)$/);
        return m ? { createdAt: m[1], name: m[3] } : { name: line.trim() };
      });
    return { buckets };
  }

  async s3ListObjects(input: { bucket: string; prefix?: string }) {
    const args = ['s3api', 'list-objects-v2', '--bucket', input.bucket];
    if (input.prefix) args.push('--prefix', input.prefix);
    this.guard('read', 'aws_s3_list_objects', args);
    return execAws(args, this.cwd, { globalArgs: this.globalArgs() });
  }

  async s3PutObject(input: { bucket: string; key: string; body: string }) {
    const args = ['s3api', 'put-object', '--bucket', input.bucket, '--key', input.key, '--body', input.body];
    const simulated = this.guard('write', 'aws_s3_put_object', args);
    if (simulated && isDryRunResult(simulated)) return simulated;
    return (
      (await execAws(args, this.cwd, { globalArgs: this.globalArgs() })) ?? {
        success: true,
        service: 's3api',
        op: 'put-object',
        bucket: input.bucket,
        key: input.key,
      }
    );
  }

  async s3GetObject(input: { bucket: string; key: string }) {
    const args = ['s3api', 'get-object', '--bucket', input.bucket, '--key', input.key, '/dev/stdout'];
    this.guard('read', 'aws_s3_get_object', args);
    return execAwsText(args, this.cwd, { globalArgs: this.globalArgs() });
  }

  // ----------------------------------------------------------------------
  // ec2
  // ----------------------------------------------------------------------

  async ec2DescribeInstances(input: { filters?: string; maxResults?: number } = {}) {
    const args = ['ec2', 'describe-instances'];
    if (input.filters) args.push('--filters', input.filters);
    if (input.maxResults) args.push('--max-results', String(input.maxResults));
    this.guard('read', 'aws_ec2_describe_instances', args);
    return execAws(args, this.cwd, { globalArgs: this.globalArgs() });
  }

  async ec2StopInstances(input: { instanceIds: string[] }) {
    const args = ['ec2', 'stop-instances', '--instance-ids', ...input.instanceIds];
    const simulated = this.guard('write', 'aws_ec2_stop_instances', args);
    if (simulated && isDryRunResult(simulated)) return simulated;
    return (
      (await execAws(args, this.cwd, { globalArgs: this.globalArgs() })) ?? {
        success: true,
        service: 'ec2',
        op: 'stop-instances',
        instanceIds: input.instanceIds,
      }
    );
  }

  async ec2StartInstances(input: { instanceIds: string[] }) {
    const args = ['ec2', 'start-instances', '--instance-ids', ...input.instanceIds];
    const simulated = this.guard('write', 'aws_ec2_start_instances', args);
    if (simulated && isDryRunResult(simulated)) return simulated;
    return (
      (await execAws(args, this.cwd, { globalArgs: this.globalArgs() })) ?? {
        success: true,
        service: 'ec2',
        op: 'start-instances',
        instanceIds: input.instanceIds,
      }
    );
  }

  async ec2RebootInstances(input: { instanceIds: string[] }) {
    const args = ['ec2', 'reboot-instances', '--instance-ids', ...input.instanceIds];
    const simulated = this.guard('write', 'aws_ec2_reboot_instances', args);
    if (simulated && isDryRunResult(simulated)) return simulated;
    return (
      (await execAws(args, this.cwd, { globalArgs: this.globalArgs() })) ?? {
        success: true,
        service: 'ec2',
        op: 'reboot-instances',
        instanceIds: input.instanceIds,
      }
    );
  }

  // ----------------------------------------------------------------------
  // iam
  // ----------------------------------------------------------------------

  async iamListRoles(input: { maxItems?: number; pathPrefix?: string } = {}) {
    const args = ['iam', 'list-roles'];
    if (input.maxItems) args.push('--max-items', String(input.maxItems));
    if (input.pathPrefix) args.push('--path-prefix', input.pathPrefix);
    this.guard('read', 'aws_iam_list_roles', args);
    return execAws(args, this.cwd, { globalArgs: this.globalArgs() });
  }

  async iamListUsers(input: { maxItems?: number } = {}) {
    const args = ['iam', 'list-users'];
    if (input.maxItems) args.push('--max-items', String(input.maxItems));
    this.guard('read', 'aws_iam_list_users', args);
    return execAws(args, this.cwd, { globalArgs: this.globalArgs() });
  }

  async iamListPolicies(input: { scope?: 'All' | 'AWS' | 'Local'; maxItems?: number } = {}) {
    const args = ['iam', 'list-policies'];
    if (input.scope) args.push('--scope', input.scope);
    if (input.maxItems) args.push('--max-items', String(input.maxItems));
    this.guard('read', 'aws_iam_list_policies', args);
    return execAws(args, this.cwd, { globalArgs: this.globalArgs() });
  }

  // ----------------------------------------------------------------------
  // lambda
  // ----------------------------------------------------------------------

  async lambdaListFunctions(input: { maxItems?: number } = {}) {
    const args = ['lambda', 'list-functions'];
    if (input.maxItems) args.push('--max-items', String(input.maxItems));
    this.guard('read', 'aws_lambda_list_functions', args);
    return execAws(args, this.cwd, { globalArgs: this.globalArgs() });
  }

  async lambdaInvoke(input: { functionName: string; payload?: string }) {
    // Invocation may mutate state; treat as write.
    const args = ['lambda', 'invoke', '--function-name', input.functionName];
    if (input.payload) args.push('--payload', input.payload);
    args.push('/dev/stdout');
    const simulated = this.guard('write', 'aws_lambda_invoke', args);
    if (simulated && isDryRunResult(simulated)) return simulated;
    return execAwsText(args, this.cwd, { globalArgs: this.globalArgs() });
  }

  // ----------------------------------------------------------------------
  // cloudformation
  // ----------------------------------------------------------------------

  async cfnListStacks(input: { statusFilter?: string } = {}) {
    const args = ['cloudformation', 'list-stacks'];
    if (input.statusFilter) args.push('--stack-status-filter', input.statusFilter);
    this.guard('read', 'aws_cloudformation_list_stacks', args);
    return execAws(args, this.cwd, { globalArgs: this.globalArgs() });
  }

  async cfnDescribeStacks(input: { stackName?: string } = {}) {
    const args = ['cloudformation', 'describe-stacks'];
    if (input.stackName) args.push('--stack-name', input.stackName);
    this.guard('read', 'aws_cloudformation_describe_stacks', args);
    return execAws(args, this.cwd, { globalArgs: this.globalArgs() });
  }

  async cfnDeleteStack(input: { stackName: string }) {
    const args = ['cloudformation', 'delete-stack', '--stack-name', input.stackName];
    const simulated = this.guard('write', 'aws_cloudformation_delete_stack', args, { dangerous: true });
    if (simulated && isDryRunResult(simulated)) return simulated;
    return (
      (await execAws(args, this.cwd, { globalArgs: this.globalArgs() })) ?? {
        success: true,
        service: 'cloudformation',
        op: 'delete-stack',
        stackName: input.stackName,
      }
    );
  }

  // ----------------------------------------------------------------------
  // dynamodb
  // ----------------------------------------------------------------------

  async dynamodbListTables(input: { limit?: number } = {}) {
    const args = ['dynamodb', 'list-tables'];
    if (input.limit) args.push('--limit', String(input.limit));
    this.guard('read', 'aws_dynamodb_list_tables', args);
    return execAws(args, this.cwd, { globalArgs: this.globalArgs() });
  }

  async dynamodbCreateTable(input: {
    tableName: string;
    attributeDefinitions: string; // aws shorthand or JSON
    keySchema: string;
    billingMode?: 'PROVISIONED' | 'PAY_PER_REQUEST';
  }) {
    const args = [
      'dynamodb', 'create-table',
      '--table-name', input.tableName,
      '--attribute-definitions', input.attributeDefinitions,
      '--key-schema', input.keySchema,
      '--billing-mode', input.billingMode ?? 'PAY_PER_REQUEST',
    ];
    const simulated = this.guard('write', 'aws_dynamodb_create_table', args);
    if (simulated && isDryRunResult(simulated)) return simulated;
    return execAws(args, this.cwd, { globalArgs: this.globalArgs() });
  }

  async dynamodbDeleteTable(input: { tableName: string }) {
    const args = ['dynamodb', 'delete-table', '--table-name', input.tableName];
    const simulated = this.guard('write', 'aws_dynamodb_delete_table', args, { dangerous: true });
    if (simulated && isDryRunResult(simulated)) return simulated;
    const result = await execAws(args, this.cwd, { globalArgs: this.globalArgs() });
    return (
      result ?? {
        success: true,
        service: 'dynamodb',
        op: 'delete-table',
        tableName: input.tableName,
      }
    );
  }

  async dynamodbPutItem(input: { tableName: string; item: string }) {
    const args = ['dynamodb', 'put-item', '--table-name', input.tableName, '--item', input.item];
    const simulated = this.guard('write', 'aws_dynamodb_put_item', args);
    if (simulated && isDryRunResult(simulated)) return simulated;
    const result = await execAws(args, this.cwd, { globalArgs: this.globalArgs() });
    return (
      result ?? {
        success: true,
        service: 'dynamodb',
        op: 'put-item',
        tableName: input.tableName,
      }
    );
  }

  // ----------------------------------------------------------------------
  // logs
  // ----------------------------------------------------------------------

  async logsDescribeLogGroups(input: { limit?: number; logGroupNamePrefix?: string } = {}) {
    const args = ['logs', 'describe-log-groups'];
    if (input.limit) args.push('--limit', String(input.limit));
    if (input.logGroupNamePrefix) args.push('--log-group-name-prefix', input.logGroupNamePrefix);
    this.guard('read', 'aws_logs_describe_log_groups', args);
    return execAws(args, this.cwd, { globalArgs: this.globalArgs() });
  }

  // ----------------------------------------------------------------------
  // ecs
  // ----------------------------------------------------------------------

  async ecsListClusters() {
    const args = ['ecs', 'list-clusters'];
    this.guard('read', 'aws_ecs_list_clusters', args);
    return execAws(args, this.cwd, { globalArgs: this.globalArgs() });
  }

  async ecsListServices(input: { cluster: string; maxResults?: number }) {
    const args = ['ecs', 'list-services', '--cluster', input.cluster];
    if (input.maxResults) args.push('--max-results', String(input.maxResults));
    this.guard('read', 'aws_ecs_list_services', args);
    return execAws(args, this.cwd, { globalArgs: this.globalArgs() });
  }

  async ecsDescribeServices(input: { cluster: string; services: string[] }) {
    const args = ['ecs', 'describe-services', '--cluster', input.cluster, '--services', ...input.services];
    this.guard('read', 'aws_ecs_describe_services', args);
    return execAws(args, this.cwd, { globalArgs: this.globalArgs() });
  }

  // ----------------------------------------------------------------------
  // pricing (requires us-east-1)
  // ----------------------------------------------------------------------

  async pricingDescribeServices(input: { serviceCode?: string; maxResults?: number } = {}) {
    const args = ['pricing', 'describe-services', '--region', 'us-east-1'];
    if (input.serviceCode) args.push('--service-code', input.serviceCode);
    if (input.maxResults) args.push('--max-results', String(input.maxResults));
    this.guard('read', 'aws_pricing_describe_services', args);
    return execAws(args, this.cwd, {
      globalArgs: [...this.globalArgs().filter((a) => a !== '--region')],
    });
  }

  // ----------------------------------------------------------------------
  // lmprobe-ported surface (catalog + allowlisted query)
  // ----------------------------------------------------------------------

  async catalog() {
    const { LM_OPERATIONS, paginationSpecFor } = await import('./aws-catalog.js');
    return {
      operations: LM_OPERATIONS.map((spec) => {
        const page = paginationSpecFor(spec);
        return {
          service: spec.service,
          operation: spec.operation,
          paginated: spec.paginated,
          ...(page
            ? {
                pagination: {
                  input_token: page.inputToken,
                  output_token: page.outputToken,
                  ...(page.moreResults ? { more_results: page.moreResults } : {}),
                },
              }
            : {}),
        };
      }),
    };
  }

  async lmQuery(input: import('./lm-query.js').LmQueryInput) {
    const { lmQuery } = await import('./lm-query.js');
    return lmQuery(input, this.cwd);
  }
}
