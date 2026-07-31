# Google Vertex Claude Provider

Run Claude through your Google Cloud project so usage stays on Vertex AI billing and IAM, without Anthropic API keys.

## Prerequisites

- `pi` installed and working
- Google Cloud SDK (`gcloud`) with a project that can call Claude on Vertex AI
- Application Default Credentials (interactive login or a service account key)

## Quick Example

```bash
gcloud auth application-default login
export GOOGLE_CLOUD_PROJECT=your-project-id

pi install git:github.com/myk-org/pi-vertex-claude

pi --provider google-vertex-claude --model claude-sonnet-4-6
```

## Step-by-step

### 1. Install the provider

Interactive installer (choose **pi-vertex-claude** under Pi Packages):

```bash
uv run scripts/install.py
```

Or install / update directly:

```bash
pi install git:github.com/myk-org/pi-vertex-claude
pi update git:github.com/myk-org/pi-vertex-claude
```

npm package name: `@myk-org/pi-vertex-claude`.

### 2. Authenticate

```bash
gcloud auth application-default login
```

Credentials are read from `GOOGLE_APPLICATION_CREDENTIALS` when set; otherwise from the default ADC file under your home directory.

> **Tip:** In CI, set `GOOGLE_APPLICATION_CREDENTIALS` to a service account JSON key instead of using interactive login.

### 3. Set the GCP project

One of these must be set (priority order):

| Variable | Role |
| :--- | :--- |
| `GOOGLE_CLOUD_PROJECT` | Preferred project id |
| `GCLOUD_PROJECT` | Common `gcloud` project id |
| `ANTHROPIC_VERTEX_PROJECT_ID` | Compatible alternate |

```bash
export GOOGLE_CLOUD_PROJECT=your-project-id
```

### 4. (Optional) Set the region

```bash
export GOOGLE_CLOUD_LOCATION=us-east5
```

| Variable | Default | Effect |
| :--- | :--- | :--- |
| `GOOGLE_CLOUD_LOCATION` | `us-east5` | Vertex region |
| `CLOUD_ML_REGION` | — | Used only if `GOOGLE_CLOUD_LOCATION` is unset |

### 5. Start Pi

```bash
pi --provider google-vertex-claude --model claude-sonnet-4-6
```

> **Note:** The provider appears only when a project id **and** ADC credentials exist before `pi` starts. Export them in the same shell (or your profile), then launch Pi.

### 6. Choose a model

| Model id | Context | Max output | Reasoning |
| :--- | ---: | ---: | :---: |
| `claude-opus-4-6` | 200K | 128K | yes |
| `claude-sonnet-4-6` | 200K | 64K | yes |
| `claude-opus-4-5@20251101` | 200K | 32K | yes |
| `claude-opus-4-1@20250805` | 200K | 32K | yes |
| `claude-opus-4@20250514` | 200K | 32K | yes |
| `claude-sonnet-4-5@20250929` | 200K | 64K | yes |
| `claude-sonnet-4@20250514` | 200K | 64K | yes |
| `claude-3-7-sonnet@20250219` | 200K | 64K | yes |
| `claude-haiku-4-5@20251001` | 200K | 64K | yes |
| `claude-3-5-sonnet-v2@20241022` | 200K | 8K | no |
| `claude-3-5-haiku@20241022` | 200K | 8K | no |

All of these accept text and image input.

For async agents, dreaming, and other settings that take provider/model pairs, use `google-vertex-claude` with one of the ids above. See [Configuration & Settings](configuration.html) and [Running Background Agents and Scheduled Tasks](async-agents-and-cron.html).

## Advanced Usage

### 1M context variants

Enable extra catalog entries for Opus 4.6 and Sonnet 4.6:

```bash
export VERTEX_CLAUDE_1M=true
pi --provider google-vertex-claude --model claude-opus-4-6-1m
```

| Model id | Context | Max output |
| :--- | ---: | ---: |
| `claude-opus-4-6-1m` | 1M | 128K |
| `claude-sonnet-4-6-1m` | 1M | 64K |

> **Warning:** Only the string `true` enables these models. Other values leave the `-1m` ids unregistered.

### Shell helper

**bash / zsh:**

```bash
piv() {
  GOOGLE_CLOUD_PROJECT=your-project-id \
  GOOGLE_CLOUD_LOCATION=us-east5 \
  pi --provider google-vertex-claude --model claude-sonnet-4-6 "$@"
}
```

**fish:**

```fish
function piv
  set -x GOOGLE_CLOUD_PROJECT your-project-id
  set -x GOOGLE_CLOUD_LOCATION us-east5
  pi --provider google-vertex-claude --model claude-opus-4-5@20251101 $argv
end
```

### Environment reference

| Variable | Type | Default | Required | Effect |
| :--- | :--- | :--- | :---: | :--- |
| `GOOGLE_CLOUD_PROJECT` | string | — | one of three* | GCP project id (highest priority) |
| `GCLOUD_PROJECT` | string | — | one of three* | GCP project id |
| `ANTHROPIC_VERTEX_PROJECT_ID` | string | — | one of three* | GCP project id |
| `GOOGLE_CLOUD_LOCATION` | string | `us-east5` | no | Vertex region |
| `CLOUD_ML_REGION` | string | — | no | Region fallback |
| `GOOGLE_APPLICATION_CREDENTIALS` | path | ADC default file | no | Service account key path |
| `VERTEX_CLAUDE_1M` | `"true"` \| other | unset | no | When `"true"`, registers `-1m` models |

\*Set exactly one project id variable for the provider to load and stream.

### Using vs extending

| Goal | What you do |
| :--- | :--- |
| **Use** | Install the package, set project + ADC, run `pi --provider google-vertex-claude --model …` |
| **Extend** | Publish another pi package that registers its own provider id with a custom stream handler; this package registers `google-vertex-claude` only when project id and ADC are available at load time |

Lifecycle when you start `pi`:

1. Extension loads.
2. Missing project id or ADC → provider is not registered (models stay hidden).
3. Both present → `google-vertex-claude` registers with the current model catalog (including `-1m` if enabled).
4. Each turn re-checks project, region, and ADC, then streams from Vertex.

For ACPX/CLI backends (separate from Vertex), see [ACPX Provider Integration](acpx-provider.html) and [External AI Agents & CLI](external-ai-agents.html).

## Troubleshooting

| Problem | Fix |
| :--- | :--- |
| Provider missing from `/model` | Export a project id, ensure ADC exists, restart `pi`. |
| `Vertex AI requires a project ID` | Set `GOOGLE_CLOUD_PROJECT`, `GCLOUD_PROJECT`, or `ANTHROPIC_VERTEX_PROJECT_ID`. |
| `Vertex AI requires Application Default Credentials` | Run `gcloud auth application-default login`, or set `GOOGLE_APPLICATION_CREDENTIALS`. |
| `-1m` models not listed | Export `VERTEX_CLAUDE_1M=true` before starting `pi`. |
| Region or quota errors | Set `GOOGLE_CLOUD_LOCATION` to a region where Claude on Vertex is enabled. |

> **Tip:** Env changes apply only after you start a new `pi` process so the provider can re-register.

## Related Pages

- [External AI Agents & CLI](external-ai-agents.html)
- [Pi Sidecar HTTP API](pi-sidecar.html)
- [Configuration & Settings](configuration.html)
- [Installation & Quickstart](quickstart.html)
- [ACPX Provider Integration](acpx-provider.html)
