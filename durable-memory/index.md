# lmaws (`aws2`) — durable memory

Portable knowledge. Read this, then `./pagination-and-metadata.md` (S3 /
DynamoDB quirks) and `./lm-query.md` (the allowlisted query layer).

## What aws2 is

A structured CLI over the `aws` binary: no boto3, no direct HTTP. It is an
lmapi server: `aws2 --schema` prints its `cli.schema.v1` document, and that
document is the contract (see https://github.com/lmctl-ai/lmapi). The runtime
(input forms, validation, policy flags, error envelope, spawning) is
`@lmctl-ai/lmts/server`; read/write classification data is derived from
awslabs/aws-api-mcp-server (see `NOTICE`).

## Surfaces

- **`aws2 run --service X --op Y [--args '[...]']`** — generic pass-through,
  `access: 'dynamic'`. Classification comes from `data/api-metadata.json` plus
  the aliases in `src/metadata.ts`. Unknown services/ops count as write
  (fail-safe).
- **`aws2 exec <argv>`** — raw argv pass-through, `access: 'dynamic'`.
- **Curated ops** in `src/cli.ts` — typed, always `--output json`, JMESPath
  `--query` passthrough, `_pagination` envelope when `--max-pages N > 1`. Every
  curated op has an authored schema in `src/schemas.ts`.
- **`aws2 catalog`** — the 41 reviewed read-only ops of the query allowlist.
- **`aws2 lm_query`** — allowlisted JSON-parameter query with redaction, native
  pagination tokens, `--select` JSON Pointer and a 60 s default deadline (1..300).

## Read/write classification authority

`data/api-metadata.json` is the source of truth, including awslabs' overrides
(STS `AssumeRole`, IAM `CreateAccessKey`, SSO `GetRoleCredentials` are write even
though their names look like reads). Don't reclassify an op locally; regenerate
the data file when upstream changes.

The query allowlist (`src/aws-catalog.ts`) is separate and only used by
`lm_query` / `catalog`: a reviewed subset (41 ops). `run` uses the full metadata.

## Dangerous ops and confirmation

`DANGEROUS_OPS` in `src/api.ts` lists delete/terminate-style ops. They need
`--confirm` (or `--i-understand`) outside dry-run and read-only mode; the gate is
`checkPolicy(..., dangerous: true, confirmed)`. A delete-style op missing from
that table is a bug.

## Process safety

- `AWS_PAGER=''`, `AWS_CLI_AUTO_PROMPT=off` in every spawned command.
- `--cli-connect-timeout=10` and `--cli-read-timeout=30` apply in `lm-query.ts`
  only; per-op process deadlines use `timeoutSeconds`.
- Parameters travel as one `--cli-input-json=<json>` argv entry; never through
  a shell.
- `Environment` fields in responses are redacted recursively to `[REDACTED]`
  before `--select`.

## Tests

`bun test --coverage` (thresholds in `bunfig.toml`). Tests use a fake `aws`
executable first on `PATH` that records argv and prints canned JSON (including
multi-page responses); no AWS account, credentials or network are needed, and
the real `HOME`/`~/.aws` is never read. Live tests run only when explicitly
enabled and credentials are present; otherwise they skip.

## Published schemas (`cli.schema.latest.json` & `cli.schema.dev.json`)

The repository root commits two channel schemas:
- `cli.schema.latest.json`: the contract of the latest release (default for `import "@lmctl-ai/lmaws"`).
- `cli.schema.dev.json`: the development contract, kept byte-for-byte identical to `bun src/cli.ts --schema`.

Releasing a tool version consists of copying `cli.schema.dev.json` to `cli.schema.latest.json` in the release commit.
`tests/schema-file.test.ts` guards against drift and breaking changes:
1. `cli.schema.dev.json` matches `bun src/cli.ts --schema` byte-for-byte.
2. `cli.schema.latest.json` parses cleanly with `parsePublishedSchema` and declares the same tool identifier.
3. All changes between `latest` and `dev` are strictly additive (no operation removal, no required param removal/tightening, no access weakening).
4. Operation access (`read|write|dynamic`), non-empty descriptions, and path hygiene.

## Product compatibility

`aws2` publishes its underlying product requirement in `--schema`:
- `product.name`: `"aws"`
- `product.supported`: `">=2.34.0 <3.0.0"`
- `product.detect`: `argv: ["aws", "--version"]`, `pattern: "aws-cli/(\\d+\\.\\d+\\.\\d+)"`

At runtime, `runCli` detects the `aws` version once per process (bounded by timeout and cached). If the installed `aws` executable is outside this range, missing, or produces unparseable output, operations are rejected with exit code 10 and envelope code `UNSUPPORTED_PRODUCT_VERSION`. Introspection commands (`--schema`, `--list`, `--help`) remain operational.
