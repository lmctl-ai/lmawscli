/**
 * @fileoverview Declarative input schemas for all aws2 operations.
 * @module aws2/schemas
 */

import type { OperationSchema } from '@lmctl-ai/lmts';

const queryParam = {
  name: 'query',
  type: 'string' as const,
  occurs: '?' as const,
  description: 'JMESPath expression (aws --query)',
};

const maxPagesParam = {
  name: 'maxPages',
  type: 'number' as const,
  occurs: '?' as const,
  description: 'Follow NextToken up to N pages (default 1)',
};

export const RUN_SCHEMA: OperationSchema = {
  name: 'run',
  access: 'dynamic',
  description: "Run an arbitrary AWS op: aws2 run --service ec2 --op describe-instances [--args '[\"--filters\",\"...\"]']",
  params: [
    {
      name: 'service',
      type: 'string',
      description: 'AWS service, e.g. ec2, s3, s3api',
    },
    {
      name: 'op',
      type: 'string',
      description: 'Operation in kebab-case, e.g. describe-instances',
    },
    {
      name: 'args',
      type: 'string',
      occurs: '?',
      description: 'Extra args as JSON array or string',
    },
    queryParam,
    maxPagesParam,
  ],
};

export const EXEC_SCHEMA: OperationSchema = {
  name: 'exec',
  access: 'dynamic',
  description: 'Raw argv pass-through: aws2 exec s3api list-buckets',
  params: [
    {
      name: '_',
      type: 'array',
      items: 'string',
      occurs: '*',
      description: 'Full aws CLI argv',
    },
    queryParam,
    maxPagesParam,
  ],
};

export const SERVICES_SCHEMA: OperationSchema = {
  name: 'services',
  access: 'read',
  description: 'List all AWS services present in the read/write metadata (381 services)',
  params: [queryParam, maxPagesParam],
};

export const GET_CALLER_IDENTITY_SCHEMA: OperationSchema = {
  name: 'get_caller_identity',
  access: 'read',
  description: 'STS GetCallerIdentity',
  params: [queryParam, maxPagesParam],
};

export const S3_LIST_BUCKETS_SCHEMA: OperationSchema = {
  name: 's3_list_buckets',
  access: 'read',
  description: 'List all S3 buckets',
  params: [queryParam, maxPagesParam],
};

export const S3_LIST_OBJECTS_SCHEMA: OperationSchema = {
  name: 's3_list_objects',
  access: 'read',
  description: 'List objects in an S3 bucket',
  params: [
    { name: 'bucket', type: 'string', description: 'Bucket name' },
    { name: 'prefix', type: 'string', occurs: '?', description: 'Prefix filter' },
    queryParam,
    maxPagesParam,
  ],
};

export const S3_PUT_OBJECT_SCHEMA: OperationSchema = {
  name: 's3_put_object',
  access: 'write',
  description: 'Put an object into S3',
  params: [
    { name: 'bucket', type: 'string', description: 'Bucket' },
    { name: 'key', type: 'string', description: 'Object key' },
    { name: 'body', type: 'string', description: 'File path to upload' },
    queryParam,
    maxPagesParam,
  ],
};

export const S3_GET_OBJECT_SCHEMA: OperationSchema = {
  name: 's3_get_object',
  access: 'read',
  description: 'Get an object body (to stdout)',
  params: [
    { name: 'bucket', type: 'string', description: 'Bucket' },
    { name: 'key', type: 'string', description: 'Object key' },
    queryParam,
    maxPagesParam,
  ],
};

export const EC2_DESCRIBE_INSTANCES_SCHEMA: OperationSchema = {
  name: 'ec2_describe_instances',
  access: 'read',
  description: 'Describe EC2 instances',
  params: [
    { name: 'filters', type: 'string', occurs: '?', description: 'ec2 --filters string' },
    { name: 'maxResults', type: 'number', occurs: '?', description: 'Page size' },
    queryParam,
    maxPagesParam,
  ],
};

const instanceIdsParam = {
  name: 'instanceIds',
  type: 'array' as const,
  items: 'string' as const,
  occurs: '+' as const,
  description: 'Array of instance IDs',
};

export const EC2_STOP_INSTANCES_SCHEMA: OperationSchema = {
  name: 'ec2_stop_instances',
  access: 'write',
  description: 'Stop EC2 instances',
  params: [instanceIdsParam, queryParam, maxPagesParam],
};

export const EC2_START_INSTANCES_SCHEMA: OperationSchema = {
  name: 'ec2_start_instances',
  access: 'write',
  description: 'Start EC2 instances',
  params: [instanceIdsParam, queryParam, maxPagesParam],
};

export const EC2_REBOOT_INSTANCES_SCHEMA: OperationSchema = {
  name: 'ec2_reboot_instances',
  access: 'write',
  description: 'Reboot EC2 instances',
  params: [instanceIdsParam, queryParam, maxPagesParam],
};

export const IAM_LIST_ROLES_SCHEMA: OperationSchema = {
  name: 'iam_list_roles',
  access: 'read',
  description: 'List IAM roles',
  params: [
    { name: 'maxItems', type: 'number', occurs: '?', description: 'Page size' },
    { name: 'pathPrefix', type: 'string', occurs: '?', description: 'Filter by path' },
    queryParam,
    maxPagesParam,
  ],
};

export const IAM_LIST_USERS_SCHEMA: OperationSchema = {
  name: 'iam_list_users',
  access: 'read',
  description: 'List IAM users',
  params: [
    { name: 'maxItems', type: 'number', occurs: '?', description: 'Page size' },
    queryParam,
    maxPagesParam,
  ],
};

export const IAM_LIST_POLICIES_SCHEMA: OperationSchema = {
  name: 'iam_list_policies',
  access: 'read',
  description: 'List IAM policies',
  params: [
    {
      name: 'scope',
      type: 'string',
      occurs: '?',
      enum: ['All', 'AWS', 'Local'],
      description: 'Policy scope (All|AWS|Local)',
    },
    { name: 'maxItems', type: 'number', occurs: '?', description: 'Page size' },
    queryParam,
    maxPagesParam,
  ],
};

export const LAMBDA_LIST_FUNCTIONS_SCHEMA: OperationSchema = {
  name: 'lambda_list_functions',
  access: 'read',
  description: 'List Lambda functions',
  params: [
    { name: 'maxItems', type: 'number', occurs: '?', description: 'Page size' },
    queryParam,
    maxPagesParam,
  ],
};

export const LAMBDA_INVOKE_SCHEMA: OperationSchema = {
  name: 'lambda_invoke',
  access: 'write',
  description: 'Invoke a Lambda function',
  params: [
    { name: 'functionName', type: 'string', description: 'Function name' },
    { name: 'payload', type: 'string', occurs: '?', description: 'JSON payload' },
    queryParam,
    maxPagesParam,
  ],
};

export const CFN_LIST_STACKS_SCHEMA: OperationSchema = {
  name: 'cfn_list_stacks',
  access: 'read',
  description: 'List CloudFormation stacks',
  params: [
    { name: 'statusFilter', type: 'string', occurs: '?', description: 'Stack status filter' },
    queryParam,
    maxPagesParam,
  ],
};

export const CFN_DESCRIBE_STACKS_SCHEMA: OperationSchema = {
  name: 'cfn_describe_stacks',
  access: 'read',
  description: 'Describe CloudFormation stacks',
  params: [
    { name: 'stackName', type: 'string', occurs: '?', description: 'Stack name' },
    queryParam,
    maxPagesParam,
  ],
};

export const CFN_DELETE_STACK_SCHEMA: OperationSchema = {
  name: 'cfn_delete_stack',
  access: 'write',
  description: 'DESTRUCTIVE: delete a CloudFormation stack (requires --confirm)',
  params: [
    { name: 'stackName', type: 'string', description: 'Stack name' },
    queryParam,
    maxPagesParam,
  ],
};

export const DYNAMODB_LIST_TABLES_SCHEMA: OperationSchema = {
  name: 'dynamodb_list_tables',
  access: 'read',
  description: 'List DynamoDB tables',
  params: [
    { name: 'limit', type: 'number', occurs: '?', description: 'Max tables' },
    queryParam,
    maxPagesParam,
  ],
};

export const DYNAMODB_CREATE_TABLE_SCHEMA: OperationSchema = {
  name: 'dynamodb_create_table',
  access: 'write',
  description: 'Create a DynamoDB table',
  params: [
    { name: 'tableName', type: 'string', description: 'Table name' },
    {
      name: 'attributeDefinitions',
      type: 'string',
      description: 'Attribute definitions (aws shorthand or JSON)',
    },
    { name: 'keySchema', type: 'string', description: 'Key schema (aws shorthand or JSON)' },
    {
      name: 'billingMode',
      type: 'string',
      occurs: '?',
      enum: ['PROVISIONED', 'PAY_PER_REQUEST'],
      default: 'PAY_PER_REQUEST',
      description: 'Billing mode (PROVISIONED|PAY_PER_REQUEST)',
    },
    queryParam,
    maxPagesParam,
  ],
};

export const DYNAMODB_PUT_ITEM_SCHEMA: OperationSchema = {
  name: 'dynamodb_put_item',
  access: 'write',
  description: 'Put an item into a DynamoDB table',
  params: [
    { name: 'tableName', type: 'string', description: 'Table name' },
    { name: 'item', type: 'string', description: 'Item JSON' },
    queryParam,
    maxPagesParam,
  ],
};

export const DYNAMODB_DELETE_TABLE_SCHEMA: OperationSchema = {
  name: 'dynamodb_delete_table',
  access: 'write',
  description: 'DESTRUCTIVE: delete a DynamoDB table (requires --confirm)',
  params: [
    { name: 'tableName', type: 'string', description: 'Table name' },
    queryParam,
    maxPagesParam,
  ],
};

export const LOGS_DESCRIBE_LOG_GROUPS_SCHEMA: OperationSchema = {
  name: 'logs_describe_log_groups',
  access: 'read',
  description: 'Describe CloudWatch log groups',
  params: [
    { name: 'limit', type: 'number', occurs: '?', description: 'Page size' },
    { name: 'logGroupNamePrefix', type: 'string', occurs: '?', description: 'Prefix' },
    queryParam,
    maxPagesParam,
  ],
};

export const ECS_LIST_CLUSTERS_SCHEMA: OperationSchema = {
  name: 'ecs_list_clusters',
  access: 'read',
  description: 'List ECS clusters',
  params: [queryParam, maxPagesParam],
};

export const ECS_LIST_SERVICES_SCHEMA: OperationSchema = {
  name: 'ecs_list_services',
  access: 'read',
  description: 'List ECS services in a cluster',
  params: [
    { name: 'cluster', type: 'string', description: 'Cluster name/ARN' },
    { name: 'maxResults', type: 'number', occurs: '?', description: 'Page size' },
    queryParam,
    maxPagesParam,
  ],
};

export const ECS_DESCRIBE_SERVICES_SCHEMA: OperationSchema = {
  name: 'ecs_describe_services',
  access: 'read',
  description: 'Describe ECS services',
  params: [
    { name: 'cluster', type: 'string', description: 'Cluster name/ARN' },
    {
      name: 'services',
      type: 'array',
      items: 'string',
      occurs: '+',
      description: 'Array of service names/ARNs',
    },
    queryParam,
    maxPagesParam,
  ],
};

export const PRICING_DESCRIBE_SERVICES_SCHEMA: OperationSchema = {
  name: 'pricing_describe_services',
  access: 'read',
  description: 'Pricing DescribeServices (us-east-1 only)',
  params: [
    { name: 'serviceCode', type: 'string', occurs: '?', description: 'Service code' },
    { name: 'maxResults', type: 'number', occurs: '?', description: 'Page size' },
    queryParam,
    maxPagesParam,
  ],
};

export const CATALOG_SCHEMA: OperationSchema = {
  name: 'catalog',
  access: 'read',
  description: 'List the reviewed, allowlisted read-only AWS operations',
  params: [queryParam, maxPagesParam],
};

export const LM_QUERY_SCHEMA: OperationSchema = {
  name: 'lm_query',
  access: 'read',
  description:
    'Allowlisted AWS query with JSON parameters, redaction, and pagination (lmprobe-style)',
  params: [
    { name: 'service', type: 'string', description: 'AWS service from the catalog (ec2, s3api, iam, ...)' },
    {
      name: 'operation',
      type: 'string',
      description: 'Exact operation name (describe-instances, list-objects-v2, ...)',
    },
    {
      name: 'params',
      type: 'object',
      occurs: '?',
      description: 'AWS API parameters object (native field names)',
    },
    { name: 'profile', type: 'string', occurs: '?', description: 'AWS CLI profile' },
    { name: 'region', type: 'string', occurs: '?', description: 'AWS region' },
    {
      name: 'maxItems',
      type: 'number',
      occurs: '?',
      description: 'Cap on paginated results (default 100; 1..10000)',
    },
    {
      name: 'pageSize',
      type: 'number',
      occurs: '?',
      description: 'Native page size (paginated ops only)',
    },
    { name: 'startingToken', type: 'string', occurs: '?', description: 'Resume token from a previous query' },
    {
      name: 'firstPage',
      type: 'boolean',
      occurs: '?',
      description: 'Only fetch the first page (conflicts with pagination controls)',
    },
    {
      name: 'select',
      type: 'string',
      occurs: '?',
      description: 'JSON Pointer, e.g. /Reservations/0/Instances',
    },
    {
      name: 'timeoutSeconds',
      type: 'number',
      occurs: '?',
      default: 60,
      description: 'Process deadline (1..300; default 60)',
    },
    queryParam,
    maxPagesParam,
  ],
};

export const ALL_AWS2_SCHEMAS: OperationSchema[] = [
  RUN_SCHEMA,
  EXEC_SCHEMA,
  SERVICES_SCHEMA,
  GET_CALLER_IDENTITY_SCHEMA,
  S3_LIST_BUCKETS_SCHEMA,
  S3_LIST_OBJECTS_SCHEMA,
  S3_PUT_OBJECT_SCHEMA,
  S3_GET_OBJECT_SCHEMA,
  EC2_DESCRIBE_INSTANCES_SCHEMA,
  EC2_STOP_INSTANCES_SCHEMA,
  EC2_START_INSTANCES_SCHEMA,
  EC2_REBOOT_INSTANCES_SCHEMA,
  IAM_LIST_ROLES_SCHEMA,
  IAM_LIST_USERS_SCHEMA,
  IAM_LIST_POLICIES_SCHEMA,
  LAMBDA_LIST_FUNCTIONS_SCHEMA,
  LAMBDA_INVOKE_SCHEMA,
  CFN_LIST_STACKS_SCHEMA,
  CFN_DESCRIBE_STACKS_SCHEMA,
  CFN_DELETE_STACK_SCHEMA,
  DYNAMODB_LIST_TABLES_SCHEMA,
  DYNAMODB_CREATE_TABLE_SCHEMA,
  DYNAMODB_PUT_ITEM_SCHEMA,
  DYNAMODB_DELETE_TABLE_SCHEMA,
  LOGS_DESCRIBE_LOG_GROUPS_SCHEMA,
  ECS_LIST_CLUSTERS_SCHEMA,
  ECS_LIST_SERVICES_SCHEMA,
  ECS_DESCRIBE_SERVICES_SCHEMA,
  PRICING_DESCRIBE_SERVICES_SCHEMA,
  CATALOG_SCHEMA,
  LM_QUERY_SCHEMA,
];
