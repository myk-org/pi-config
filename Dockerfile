FROM ghcr.io/astral-sh/uv:latest AS uv

# Pinned to 22.22.3 — node:22.23.0+ has a keep-alive regression that breaks
# google-auth-library/gaxios/node-fetch@2 (https://github.com/nodejs/node/issues/63989)
FROM node:22.22.3-slim

LABEL maintainer="myk-org" \
  description="Sandboxed pi coding agent with all required tools" \
  org.opencontainers.image.source="https://github.com/myk-org/pi-config"

# Avoid interactive prompts
ENV DEBIAN_FRONTEND=noninteractive

# Install base system dependencies
RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \
  --mount=type=cache,target=/var/lib/apt/lists,sharing=locked \
  apt-get update && apt-get install -y --no-install-recommends \
  acl \
  ca-certificates \
  curl \
  gcc \
  git \
  gnupg \
  jq \
  libxml2-dev \
  openssh-client \
  procps \
  psmisc \
  ripgrep \
  unzip \
  && rm -rf /var/lib/apt/lists/*

# Install GitHub CLI (signed repo, uses curl+gpg from above)
RUN curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
  | gpg --dearmor -o /usr/share/keyrings/githubcli-archive-keyring.gpg && \
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
  | tee /etc/apt/sources.list.d/github-cli.list > /dev/null && \
  apt-get update && apt-get install -y --no-install-recommends gh && \
  rm -rf /var/lib/apt/lists/*

# Install GitLab CLI (latest release .deb from GitLab API)
RUN GLAB_VERSION=$(curl -fsSL "https://gitlab.com/api/v4/projects/gitlab-org%2Fcli/releases" | grep -o '"tag_name":"v[^"]*"' | head -1 | cut -d'"' -f4 | sed 's/^v//') && \
  curl -fsSL -o /tmp/glab.deb "https://gitlab.com/gitlab-org/cli/-/releases/v${GLAB_VERSION}/downloads/glab_${GLAB_VERSION}_linux_amd64.deb" && \
  dpkg -i /tmp/glab.deb && \
  rm -f /tmp/glab.deb

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

# Install Bun (required by coms-net-server)
RUN curl -fsSL https://bun.sh/install | BUN_INSTALL=/usr/local bash

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

# Install acpx, agent-browser, pi-web-access, gemini-cli, pi-tasks (pi itself is installed at runtime in entrypoint.sh)
RUN --mount=type=cache,target=/root/.npm,sharing=locked \
  npm install -g acpx agent-browser pi-web-access @google/gemini-cli @tintinweb/pi-tasks


# Switch to non-root user (node:22 ships with user 'node' at UID 1000)
RUN chown -R node:node /home/node
USER node
RUN mkdir -p /home/node/.npm-global && npm config set prefix /home/node/.npm-global
ENV PATH="/home/node/.npm-global/bin:/home/node/.pi/agent/bin:/home/node/.local/bin:$PATH"
ENV TERM=xterm-256color
ENV COLORTERM=truecolor
ENV PLAYWRIGHT_BROWSERS_PATH=/home/node/.cache/ms-playwright

# Cursor auth: create config dir (auth.json mounted or symlinked at runtime)
RUN mkdir -p /home/node/.config/cursor

# agent-browser: use Playwright's Chromium with container-safe flags
ENV AGENT_BROWSER_ARGS="--no-sandbox,--disable-dev-shm-usage"

# acpx agents to register as pi model providers (comma-separated)
ENV ACPX_AGENTS=""

# Install remote uv tools (cached independently of local source changes)
RUN --mount=type=cache,target=/home/node/.cache/uv,sharing=locked,uid=1000,gid=1000 \
  uv tool install mcp-launchpad --from "mcp-launchpad @ git+https://github.com/kenneth-liao/mcp-launchpad.git" && \
  uv tool install prek && \
  uv tool install mcp-proxy

# myk-pi-tools is installed at runtime by entrypoint.sh from the latest
# pi-config source (pulled via pi update). No need to bake it into the image.

# Workaround for buildah bug #6747: cache mount above resets /home/node
# ownership. Re-chown before CLI installs that need to write there.
USER root
RUN chown node:node /home/node
USER node

# Install Cursor Agent CLI and Claude Code (after uv tools)
RUN /bin/bash -o pipefail -c "curl -fsSL https://cursor.com/install | bash"
RUN /bin/bash -o pipefail -c "curl -fsSL https://claude.ai/install.sh | bash"

# CodeRabbit CLI — local AI code reviews
RUN CI=true /bin/bash -o pipefail -c "curl -fsSL https://cli.coderabbit.ai/install.sh | sh"

COPY --chmod=755 entrypoint.sh /usr/local/bin/entrypoint.sh

# Workaround: re-chown /home/node after cache mounts (buildah bug #6747).
USER root
# sudo for init-entrypoint (node needs root to chown/symlink host HOME)
RUN apt-get update && apt-get install -y --no-install-recommends sudo && rm -rf /var/lib/apt/lists/* && \
    echo 'node ALL=(ALL) NOPASSWD:SETENV: /usr/local/bin/init-entrypoint.sh' >> /etc/sudoers.d/pi-init && \
    chmod 0440 /etc/sudoers.d/pi-init

RUN chown node:node /home/node

COPY --chmod=755 init-entrypoint.sh /usr/local/bin/init-entrypoint.sh

# USER node so docker exec enters as node.
# Entrypoint uses sudo for root operations then runs as node.
USER node

WORKDIR /workspace

ENTRYPOINT ["init-entrypoint.sh"]
