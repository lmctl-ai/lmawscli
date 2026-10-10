# aws2 lm_query / catalog — the allowlisted query surface

`src/aws-catalog.ts` is a port of lmctl-ai/lmprobe's `aws_policy.rs` (41 reviewed
read-only ops, each with a per-service PaginationSpec). `lm-query.ts` ports
`aws_command.rs`.

## Contract invariants

1. **Allowlist is exact** — `(service, operation)` must match a row; no prefix,
   substring, or case folding. "ec2 describe-instance" is refused, so is
   "EC2 describe-instances", so is "s3api delete-bucket" — refuse, not best-effort.
2. **Parameters go via --cli-input-json=<json>** as one argv entry; the shell
   never sees them, so `file://` interpolation, glob expansion, and metachars
   don't apply. `--query` is **not** mixed in; `--select` (RFC 6901 JSON
   Pointer) is evaluated client-side after coverage + redaction.
3. **Redaction before select** — any key equal to `Environment` (case-insensitive)
   is rewritten to `[REDACTED]` recursively. This happens before `--select`
   can narrow the shape, so the caller cannot accidentally re-expose it.
4. **Coverage flags** — `complete: true` iff no pagination continuation *and*
   no per-resource failures. `partial: true` when continuation tokens
   exist or failures are non-empty. Both are computed before `--select`.
5. **Deadline** — `timeoutSeconds ∈ [1, 300]`, default 60. The child is
   killed on deadline; the error is `TIMEOUT`. Never run unbounded.
6. **stdin is /dev/null**, `AWS_PAGER=''`, `AWS_CLI_AUTO_PROMPT=off`,
   `AWS_MAX_ATTEMPTS=2`, `--no-cli-pager`, `--color=off` — all non-negotiable.

## Failure envelope

Even on failure, the returned shape is the `lmprobe.aws_query.v1` envelope:
```
{ schema, exitStatus, partial, complete, data, page, warnings, ... }
```
`warnings` carries `AWS_PAGE_INCOMPLETE`, `AWS_PARTIAL_FAILURE`,
`AWS_VALUES_REDACTED`, `AWS_SELECT_NOT_FOUND`.
`awsFailures` is populated when AWS returns a `failures` array.
If the AWS CLI returns non-JSON output, execution aborts throwing `CliError(ErrorCode.ParseError)`.

## When to extend

Adding a new op to the allowlist is a deliberate review step — the
`aws-catalog.ts` file is also the test list. Add the row, add a pagination
model if paginated, add at least one test that the row exists with the
expected shape, and mention the review in your commit message.
