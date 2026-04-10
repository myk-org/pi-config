FROM ghcr.io/astral-sh/uv:latest AS uv

FROM node:22-slim

LABEL maintainer="myk-org" \
      description="Sandboxed pi coding agent with all required tools" \
      org.opencontainers.image.source="https://github.com/myk-org/pi-config"

# Avoid interactive prompts
ENV DEBIAN_FRONTEND=noninteractive

# Install system dependencies
RUN apt-get update && apt-get install -y --no-install-recommends \
    curl \
    git \
    jq \
    openssh-client \
    ca-certificates \
    gnupg \
    && rm -rf /var/lib/apt/lists/*

# Install GitHub CLI and Google Cloud SDK
RUN curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
      | dd of=/usr/share/keyrings/githubcli-archive-keyring.gpg 2>/dev/null && \
    echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
      | tee /etc/apt/sources.list.d/github-cli.list > /dev/null && \
    echo "deb [signed-by=/usr/share/keyrings/cloud.google.gpg] https://packages.cloud.google.com/apt cloud-sdk main" \
      | tee /etc/apt/sources.list.d/google-cloud-sdk.list > /dev/null && \
    curl -fsSL https://packages.cloud.google.com/apt/doc/apt-key.gpg \
      | gpg --dearmor -o /usr/share/keyrings/cloud.google.gpg && \
    apt-get update && apt-get install -y --no-install-recommends gh google-cloud-cli && \
    rm -rf /var/lib/apt/lists/*

# Install pi coding agent and acpx
RUN npm install -g @mariozechner/pi-coding-agent acpx

# Copy uv and uvx from official image
COPY --from=uv /uv /usr/local/bin/uv
COPY --from=uv /uvx /usr/local/bin/uvx

# Install Go
RUN curl -fsSL https://go.dev/dl/go1.24.4.linux-amd64.tar.gz | tar -C /usr/local -xzf -
ENV PATH="/usr/local/go/bin:$PATH"

# Install kubectl and oc (OpenShift CLI)
RUN curl -fsSL -o /usr/local/bin/kubectl "https://dl.k8s.io/release/$(curl -fsSL https://dl.k8s.io/release/stable.txt)/bin/linux/amd64/kubectl" && \
    chmod +x /usr/local/bin/kubectl && \
    curl -fsSL https://mirror.openshift.com/pub/openshift-v4/clients/ocp/stable/openshift-client-linux.tar.gz \
      | tar -C /usr/local/bin -xzf - oc

# Switch to non-root user (node:22 ships with user 'node' at UID 1000)
USER node
ENV PATH="/home/node/.local/bin:$PATH"

# Install uv tools
RUN uv tool install mcp-launchpad --from "mcp-launchpad @ git+https://github.com/kenneth-liao/mcp-launchpad.git" && \
    uv tool install myk-pi-tools --from "myk-pi-tools @ git+https://github.com/myk-org/pi-config.git" && \
    uv tool install prek

# Install Cursor Agent CLI
RUN /bin/bash -o pipefail -c "curl -fsSL https://cursor.com/install | bash"

# acpx agents to register as pi model providers (comma-separated)
# e.g., cursor, claude, gemini, copilot
ENV ACPX_AGENTS=""

COPY --chmod=755 entrypoint.sh /usr/local/bin/entrypoint.sh

WORKDIR /workspace

ENTRYPOINT ["entrypoint.sh"]
