/**
 * @fileoverview Exact read-only AWS operation catalog, ported from
 * lmctl-ai/lmprobe crates/lmprobe/src/aws_policy.rs.
 *
 * The catalog is deliberately small; an op absent from OPERATIONS is refused
 * by the lmprobe_query op. PaginationSpecs carry the service-model
 * input/output token names for first-page mode (not a generic heuristic).
 * @module aws2/aws-catalog
 */

export interface OperationSpec {
  service: string;
  operation: string;
  paginated: boolean;
}

function op(service: string, operation: string, paginated: boolean): OperationSpec {
  return { service, operation, paginated };
}

/**
 * The reviewed, read-only AWS operation surface (mirrors aws_policy.rs::OPERATIONS).
 * Order preserved from the source file.
 */
export const LM_OPERATIONS: readonly OperationSpec[] = [
  op('sts', 'get-caller-identity', false),
  op('ec2', 'describe-instances', true),
  op('ec2', 'describe-vpcs', true),
  op('ec2', 'describe-subnets', true),
  op('ec2', 'describe-security-groups', true),
  op('ec2', 'describe-volumes', true),
  op('ec2', 'describe-images', true),
  op('ec2', 'describe-regions', false),
  op('s3api', 'list-buckets', true),
  op('s3api', 'list-objects-v2', true),
  op('s3api', 'head-object', false),
  op('s3api', 'get-bucket-location', false),
  op('s3api', 'get-bucket-versioning', false),
  op('s3api', 'get-bucket-tagging', false),
  op('s3api', 'get-public-access-block', false),
  op('iam', 'list-users', true),
  op('iam', 'list-roles', true),
  op('iam', 'list-groups', true),
  op('iam', 'list-policies', true),
  op('iam', 'list-attached-role-policies', true),
  op('iam', 'list-attached-user-policies', true),
  op('iam', 'get-role', false),
  op('iam', 'get-user', false),
  op('iam', 'get-policy', false),
  op('iam', 'get-policy-version', false),
  op('lambda', 'list-functions', true),
  op('ecs', 'list-clusters', true),
  op('ecs', 'list-services', true),
  op('ecs', 'describe-clusters', false),
  op('ecs', 'describe-services', false),
  op('ecs', 'list-tasks', true),
  op('ecs', 'describe-tasks', false),
  op('rds', 'describe-db-instances', true),
  op('rds', 'describe-db-clusters', true),
  op('logs', 'describe-log-groups', true),
  op('logs', 'describe-log-streams', true),
  op('cloudwatch', 'list-metrics', true),
  op('cloudwatch', 'describe-alarms', true),
  op('dynamodb', 'list-tables', true),
  op('dynamodb', 'describe-table', false),
  op('cloudformation', 'list-stacks', true),
];

export function lookupLmOperation(
  service: string,
  operation: string,
): OperationSpec | undefined {
  return LM_OPERATIONS.find((s) => s.service === service && s.operation === operation);
}

export interface PaginationSpec {
  /** Parameter that carries the continuation token back into the request. */
  inputToken: string;
  /** Response field containing the next request's continuation token. */
  outputToken: string;
  /** Optional boolean field signaling "more results" (e.g. IsTruncated). */
  moreResults?: string;
}

/**
 * Field names from the installed AWS service paginator models, per
 * service/operation — not a global token-name heuristic.
 * Mirrors aws_policy.rs::pagination.
 */
export function paginationSpecFor(spec: OperationSpec): PaginationSpec | undefined {
  if (!spec.paginated) return undefined;

  const key = `${spec.service} ${spec.operation}`;
  switch (true) {
    case [
      'ec2 describe-instances', 'ec2 describe-vpcs', 'ec2 describe-subnets',
      'ec2 describe-security-groups', 'ec2 describe-volumes', 'ec2 describe-images',
      'cloudwatch list-metrics', 'cloudwatch describe-alarms',
      'cloudformation list-stacks',
    ].includes(key):
      return { inputToken: 'NextToken', outputToken: 'NextToken' };

    case key === 's3api list-buckets':
      return { inputToken: 'ContinuationToken', outputToken: 'ContinuationToken' };

    case key === 's3api list-objects-v2':
      return {
        inputToken: 'ContinuationToken',
        outputToken: 'NextContinuationToken',
        moreResults: 'IsTruncated',
      };

    case [
      'iam list-users', 'iam list-roles', 'iam list-groups', 'iam list-policies',
      'iam list-attached-role-policies', 'iam list-attached-user-policies',
    ].includes(key):
      return { inputToken: 'Marker', outputToken: 'Marker', moreResults: 'IsTruncated' };

    case key === 'lambda list-functions':
      return { inputToken: 'Marker', outputToken: 'NextMarker' };

    case [
      'ecs list-clusters', 'ecs list-services', 'ecs list-tasks',
      'logs describe-log-groups', 'logs describe-log-streams',
    ].includes(key):
      return { inputToken: 'nextToken', outputToken: 'nextToken' };

    case ['rds describe-db-instances', 'rds describe-db-clusters'].includes(key):
      return { inputToken: 'Marker', outputToken: 'Marker' };

    case key === 'dynamodb list-tables':
      return { inputToken: 'ExclusiveStartTableName', outputToken: 'LastEvaluatedTableName' };

    default:
      return undefined;
  }
}
