# Paperclip OMP Adapter

[![CI](https://github.com/tickernelz/paperclip-omp-adapter/actions/workflows/ci.yml/badge.svg)](https://github.com/tickernelz/paperclip-omp-adapter/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/%40zhafron%2Fpaperclip-omp-adapter.svg)](https://www.npmjs.com/package/@zhafron/paperclip-omp-adapter)
[![license](https://img.shields.io/npm/l/%40zhafron%2Fpaperclip-omp-adapter.svg)](LICENSE)

Run [Oh My Pi](https://github.com/can1357/oh-my-pi) as a first-class external adapter in [Paperclip](https://github.com/paperclipai/paperclip)—with native model discovery, custom providers, resumable local sessions, skills, tools, and structured transcripts.

## What it maps

| OMP capability | Paperclip behavior |
|---|---|
| Built-in, fetched, local, and custom models | Native `omp models --json` discovery and refresh |
| Custom providers and `models.yml` | Schema-driven config with environment-bound credentials |
| Tools, skills, rules, hooks, extensions, LSP, PTY | Direct OMP CLI flag mapping |
| JSONL sessions and tool events | Structured Paperclip transcript entries |
| Local session state | Exact session resume across heartbeats |
| SSH and sandbox targets | Workspace and sanitized runtime-asset staging |

## Quick start

Requirements: Node.js 22+, Paperclip with external-adapter support, and OMP installed and authenticated in the execution environment.

```sh
npm install -g @oh-my-pi/pi-coding-agent@17.0.5
```

Install the adapter in Paperclip:

```text
Settings → Adapters → Install from npm → @zhafron/paperclip-omp-adapter
```

Or through the API:

```sh
curl -X POST http://localhost:3102/api/adapters \
  -H 'Content-Type: application/json' \
  -d '{"packageName":"@zhafron/paperclip-omp-adapter"}'
```

Create an agent with adapter type `omp_local`, then select an OMP model such as `provider/model` or a role alias such as `@smol`. Leaving tool and skill allowlists empty preserves OMP's complete defaults.

## Custom provider

Bind the credential in Paperclip's environment/secrets configuration, then reference only its environment variable name:

```yaml
providers:
  my-gateway:
    baseUrl: https://gateway.example.com/v1
    api: openai-completions
    apiKey: MY_GATEWAY_API_KEY
    models:
      - id: my-model
        name: My Model
        contextWindow: 128000
        maxTokens: 8192
```

Paste that into the adapter's **Isolated models.yml** field and select `my-gateway/my-model`.

## Safety and remote behavior

- Inline and materialized YAML is parsed structurally; literal credentials and credential-bearing URLs are rejected.
- Auth databases are never copied to remote targets. Use Paperclip secret bindings.
- Remote config, extension, hook, and plugin paths must live inside the synchronized workspace.
- Local sessions resume exactly. Remote sessions are ephemeral because Paperclip remote runtime directories are per run.
- Paperclip-owned identity and workspace environment values cannot be overridden by agent config.

## Development

```sh
npm install
npm test
npm pack --dry-run
```

Tag a version such as `v0.1.0` to run the npm publish workflow and create a GitHub Release. The workflow expects an `NPM_TOKEN` repository secret.

## License

MIT
