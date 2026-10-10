# lmaws — `aws2`, a structured AWS CLI

`aws2` runs `aws` (argv only, pager and auto-prompt off, always `--output json`) and returns JSON. It offers curated typed operations, a generic `run` whose read/write class comes from per-service metadata, an allowlisted `lm_query` with redaction, JSON-Pointer `--select` and deadlines, and client-side pagination. Credentials are the AWS CLI's own.

`aws2` is an [lmapi](https://github.com/lmctl-ai/lmapi) server: `aws2 --schema` prints its
`cli.schema.v1` document, which is the contract. A client (an LLM tool, a script,
an SDK) validates against it before calling, and `aws2` validates again and
enforces its policy. Built on [@lmctl-ai/lmts](https://github.com/lmctl-ai/lmts).

## Install

`aws2` runs on [Bun](https://bun.sh) and needs the `aws` CLI on `PATH`.

```sh
git clone https://github.com/lmctl-ai/lmaws.git
cd lmaws
bun install
bun link            # puts `aws2` on PATH
```

## Usage

```sh
aws2 --list                 # operations with access (read/write) and descriptions
aws2 --schema               # the cli.schema.v1 document
aws2 --explain <op>         # one operation's schema (--format text for help text)
aws2 <op> [--param value ...] [--dryrun] [--readonly] [--confirm]
```

```sh
aws2 get_caller_identity
aws2 run --service ec2 --op describe-instances --max-pages 3
aws2 lm_query --service dynamodb --operation list-tables --select /TableNames
aws2 dynamodb_delete_table --table-name scratch --confirm --dryrun
```

Input can be flags, a JSON document (`--input-json '{"op":...,"params":{...}}'`
or `--input-file`) or a GraphQL document (`--input-graphql`). Output is JSON on
stdout; errors are `{"success":false,"error":{"code","message","data"}}` with a
non-zero exit code.

## Safety flags

Every write goes through the same policy before any command is built:

- `--dryrun` — report what would run, change nothing (reads still execute).
- `--readonly` — refuse every write operation.
- `--confirm` — required for operations marked dangerous.
- Environment floors `AWS2_READONLY=1` / `AWS2_DRYRUN=1` turn the same modes on for every call;
  flags cannot loosen them.

Operations whose schema does not declare `access: "read"` are treated as effectful.

## Development

Requires [Bun](https://bun.sh) (version in `.bun-version`).

```sh
bun install --frozen-lockfile
bunx tsc --noEmit
bun test --coverage   # fails below the thresholds in bunfig.toml
```

The tests are hermetic: no network, no credentials, and they never touch your
`HOME` or working directory; a fake `aws` executable on `PATH` stands in for AWS, and live tests run only when explicitly enabled with real credentials.

## Provenance

- `data/api-metadata.json` and `src/metadata.ts` (read/write classification) are
  derived from the AWS API MCP Server in [awslabs/mcp](https://github.com/awslabs/mcp)
  (Apache-2.0); the data was restructured and extended with awslabs' overrides and
  custom read-only list. Details in [NOTICE](NOTICE).
- The allowlisted query and policy (`src/lm-query.ts`, `src/aws-catalog.ts`)
  originated in [lmctl-ai/lmprobe](https://github.com/lmctl-ai/lmprobe) (MIT, Lattice Systems LLC).
- The CLI runtime is [@lmctl-ai/lmts](https://github.com/lmctl-ai/lmts).

## License

MIT for original code; Apache-2.0 for derived portions, see [NOTICE](NOTICE).
The MIT license is in [LICENSE](LICENSE), the Apache License 2.0 in
[LICENSE-APACHE](LICENSE-APACHE).
