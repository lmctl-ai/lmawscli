# LMScript Recipes for lmaws (`aws2`)

Practical automation recipes in [LMScript](https://github.com/lmctl-ai/lmctl) using the `@lmctl-ai/lmaws` schema module import (defaulting to the `latest` channel defined by `cli.schema.latest.json`).

## Recipe Index

| File | What it does | Access | Arguments |
|---|---|---|---|
| `whoami.lms` | Queries STS GetCallerIdentity to inspect current account, ARN, and user ID | Read-only | `[region] [profile]` |
| `list-buckets.lms` | Lists all S3 buckets in the AWS account with creation dates | Read-only | None |
| `running-instances.lms` | Lists EC2 instances currently in the running state | Read-only | None |
| `table-inventory.lms` | Lists DynamoDB tables present in the AWS account | Read-only | `[limit]` |
| `stack-status.lms` | Lists CloudFormation stacks and their current deployment status | Read-only | `[filter]` |
| `caller-identity.lms` | Directly queries STS caller identity for active account and principal | Read-only | None |
| `lambda-functions.lms` | Lists serverless AWS Lambda functions configured in the account | Read-only | `[limit]` |

## Running Recipes

Run any recipe with `lmscript`:

```bash
lmscript examples/whoami.lms us-east-1 default
```

To preview without side effects or spawning tool processes:

```bash
lmscript --dry-run examples/list-buckets.lms
```
