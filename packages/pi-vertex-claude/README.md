# Vertex Claude Provider for Pi

Access Claude models via Google Vertex AI.

## Installation

```bash
pi install npm:@myk-org/pi-vertex-claude
```

## Setup

Authenticate with Google Cloud:

```bash
gcloud auth application-default login
```

Set your project (any of these, checked in this order):

```bash
export GOOGLE_CLOUD_PROJECT=your-project-id
# or
export GCLOUD_PROJECT=your-project-id
# or
export ANTHROPIC_VERTEX_PROJECT_ID=your-project-id
```

Use the provider:

```bash
pi --provider google-vertex-claude --model claude-sonnet-4-6
```

## Shell Helper

Add to `~/.bashrc` or `~/.zshrc`:

```bash
# Set project ID via GOOGLE_CLOUD_PROJECT, GCLOUD_PROJECT, or ANTHROPIC_VERTEX_PROJECT_ID
piv() {
  GOOGLE_CLOUD_PROJECT=your-project-id \
  pi --provider google-vertex-claude --model claude-sonnet-4-6 "$@"
}
```

## Available Models

| Model | Context | Output |
|-------|---------|--------|
| `claude-opus-4-6` | 200K | 128K |
| `claude-sonnet-4-6` | 200K | 64K |
| `claude-opus-4-5@20251101` | 200K | 32K |
| `claude-opus-4-1@20250805` | 200K | 32K |
| `claude-opus-4@20250514` | 200K | 32K |
| `claude-sonnet-4-5@20250929` | 200K | 64K |
| `claude-sonnet-4@20250514` | 200K | 64K |
| `claude-3-7-sonnet@20250219` | 200K | 64K |
| `claude-haiku-4-5@20251001` | 200K | 64K |
| `claude-3-5-sonnet-v2@20241022` | 200K | 8K |
| `claude-3-5-haiku@20241022` | 200K | 8K |

## 1M Context Window

Claude Opus 4.6 and Sonnet 4.6 support up to 1M tokens of context via the `context-1m-2025-08-07` beta header.

To enable 1M model variants, set:

```bash
export VERTEX_CLAUDE_1M=true
```

This adds `-1m` variants alongside the standard models:

| Model | Context | Output |
|-------|---------|--------|
| `claude-opus-4-6-1m` | 1M | 128K |
| `claude-sonnet-4-6-1m` | 1M | 64K |

Use them like any other model:

```bash
pi --provider google-vertex-claude --model claude-opus-4-6-1m
```

## Prerequisites

- Google Cloud project with Vertex AI API enabled
- Claude models enabled in [Model Garden](https://console.cloud.google.com/vertex-ai/model-garden)
- `gcloud` CLI installed

## License

MIT
