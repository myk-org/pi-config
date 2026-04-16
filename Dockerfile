FROM ghcr.io/astral-sh/uv:latest AS uv

FROM node:22-slim

LABEL maintainer="myk-org" \
      description="Sandboxed pi coding agent with all required tools" \
      org.opencontainers.image.source="https://github.com/myk-org/pi-config"

# Avoid interactive prompts
ENV DEBIAN_FRONTEND=noninteractive

# Install base system dependencies
RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,target=/var/lib/apt/lists,sharing=locked \
    apt-get update && apt-get install -y --no-install-recommends \
    curl \
    gnupg \
    jq \
    ca-certificates \
    git \
    openssh-client \
    procps \
    psmisc \
    && rm -rf /var/lib/apt/lists/*

# Install GitHub CLI (signed repo, uses curl+gpg from above)
RUN curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
      | gpg --dearmor -o /usr/share/keyrings/githubcli-archive-keyring.gpg && \
    echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
      | tee /etc/apt/sources.list.d/github-cli.list > /dev/null && \
    apt-get update && apt-get install -y --no-install-recommends gh && \
    rm -rf /var/lib/apt/lists/*

# Install Chromium via Playwright (--with-deps installs all system libs)
RUN mkdir -p /home/node/.cache/ms-playwright && \
    PLAYWRIGHT_BROWSERS_PATH=/home/node/.cache/ms-playwright \
    npx playwright install --with-deps chromium && \
    chown -R node:node /home/node/.cache

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

# Install Docker and Podman CLIs (for docker-safe wrapper — read-only container inspection)
RUN DOCKER_VERSION=$(curl -fsSL https://download.docker.com/linux/static/stable/x86_64/ | grep -oP 'docker-\K[0-9.]+(?=\.tgz)' | sort -V | tail -1) && \
    curl -fsSL "https://download.docker.com/linux/static/stable/x86_64/docker-${DOCKER_VERSION}.tgz" \
      | tar -xzf - --strip-components=1 -C /usr/local/bin docker/docker && \
    apt-get update && apt-get install -y --no-install-recommends podman && \
    rm -rf /var/lib/apt/lists/*

# Copy docker-safe wrapper
COPY --chmod=755 scripts/docker-safe /usr/local/bin/docker-safe

# Install acpx, agent-browser, pi-web-access, diffity (pi itself is installed at runtime in entrypoint.sh)
RUN --mount=type=cache,target=/root/.npm,sharing=locked \
    npm install -g acpx agent-browser pi-web-access diffity

# Switch to non-root user (node:22 ships with user 'node' at UID 1000)
RUN chown -R node:node /home/node
USER node
RUN mkdir -p /home/node/.npm-global && npm config set prefix /home/node/.npm-global
ENV PATH="/home/node/.npm-global/bin:/home/node/.pi/agent/bin:/home/node/.local/bin:$PATH"
ENV PLAYWRIGHT_BROWSERS_PATH=/home/node/.cache/ms-playwright

# Cursor auth: symlink from default location to mount-safe path
# (mounting dirs under ~/.config/ breaks Chrome, so cursor auth mounts to ~/.cursor/)
RUN mkdir -p /home/node/.config/cursor /home/node/.cursor && \
    ln -sf /home/node/.cursor/auth.json /home/node/.config/cursor/auth.json

# agent-browser: use Playwright's Chromium with container-safe flags
ENV AGENT_BROWSER_ARGS="--no-sandbox,--disable-dev-shm-usage"

# acpx agents to register as pi model providers (comma-separated)
ENV ACPX_AGENTS=""

# Install remote uv tools (cached independently of local source changes)
RUN --mount=type=cache,target=/home/node/.cache/uv,sharing=locked,uid=1000,gid=1000 \
    uv tool install mcp-launchpad --from "mcp-launchpad @ git+https://github.com/kenneth-liao/mcp-launchpad.git" && \
    uv tool install prek

# Copy and install myk-pi-tools from local source
COPY --chown=node:node pyproject.toml README.md /tmp/myk-pi-tools/
COPY --chown=node:node myk_pi_tools/ /tmp/myk-pi-tools/myk_pi_tools/
RUN --mount=type=cache,target=/home/node/.cache/uv,sharing=locked,uid=1000,gid=1000 \
    uv tool install myk-pi-tools --from /tmp/myk-pi-tools && \
    rm -rf /tmp/myk-pi-tools

# Install Cursor Agent CLI (after uv tools — cursor changes rarely)
RUN /bin/bash -o pipefail -c "curl -fsSL https://cursor.com/install | bash"

COPY --chmod=755 entrypoint.sh /usr/local/bin/entrypoint.sh

WORKDIR /workspace

ENTRYPOINT ["entrypoint.sh"]
