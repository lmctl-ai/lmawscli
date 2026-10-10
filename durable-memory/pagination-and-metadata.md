# aws2 pagination and metadata quirks

Two things non-obvious from the code that you will rediscover if you ignore
this note.

## `--max-pages` semantic in `aws2 run`

`run` never pages by default. `--max-pages N` with N>1 enables the
client-side pagination loop in `pagination.ts`: it follows the continuation
token up to N pages, merging arrays across pages, and emits a final envelope
with `_pagination: {pages, maxPages, hasMore, nextToken?}`. The token flag
fed back into the next call is service-specific (`--starting-token` default;
DynamoDB's `LastEvaluatedTableName` maps to `--exclusive-start-table-name`
via `TOKEN_FLAG_BY_KEY`).

If you add a service to the loop, extend that table; don't guess flag names
from the response field name.

## Service-name aliasing

The AWS CLI splits S3 into `s3` (high-level) and `s3api` (low-level), but the
awslabs metadata covers only `s3`. `metadata.ts` keeps a small alias table:
`s3api→s3`, plus the `efsapi`/`elb-api`/`elbv2api` shims for services where
the CLI name and service-model name diverge.

## lmquery's pagination is different from `run`'s

`lm_query` runs inside the lmprobe envelope: default `--max-items 100`,
`--first-page` uses native service paginators (e.g. `--no-paginate`),
`--page-size` sets native page size. Its resume token is the CLI's own
NextToken when paginated, or the native output-token (e.g. `NextMarker`) in
first-page mode. It's a different contract than `run`'s page loop and both
shapes coexist deliberately — `lm_query` when you want guardrails and
redaction, `run` when you want the full aws CLI surface with structured
output.
