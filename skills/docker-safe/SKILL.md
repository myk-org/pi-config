---
name: docker-safe
description: ALL Docker and Podman operations — list containers, view logs, inspect, check status, debug. This is the ONLY way to interact with Docker/Podman. Use for ANY container-related request including simple ones like listing running containers.
---

# Docker Safe — ALL Docker/Podman Operations

**ALWAYS use `docker-safe` for ANY Docker or Podman interaction.** Direct `docker` or `podman` commands are blocked in the container. This wrapper allows read-only commands only.

## Runtime Selection

Default runtime is `docker`. Use `--runtime podman` for Podman containers:

```bash
docker-safe --runtime podman ps          # List Podman containers
docker-safe --runtime docker logs foo    # Docker container logs
docker-safe ps                           # Uses docker by default
```

Or set `DOCKER_SAFE_RUNTIME=podman` env var to change the default.

## Commands

### List containers

```bash
docker-safe ps                    # Running containers
docker-safe ps -a                 # All containers (including stopped)
docker-safe ps --filter name=foo  # Filter by name
docker-safe ps --format '{{.Names}} {{.Status}}'  # Custom format
```

### View logs

```bash
docker-safe logs <container>              # All logs
docker-safe logs <container> --tail 100   # Last 100 lines
docker-safe logs <container> -f           # Follow (stream) — use with caution, blocks
docker-safe logs <container> --since 5m   # Last 5 minutes
docker-safe logs <container> 2>&1 | grep ERROR  # Search for errors
```

### Inspect container

```bash
docker-safe inspect <container>                        # Full JSON
docker-safe inspect <container> --format '{{.State.Status}}'  # Status only
docker-safe inspect <container> --format '{{json .Config.Env}}'  # Environment
docker-safe inspect <container> --format '{{json .NetworkSettings.Ports}}'  # Ports
docker-safe inspect <container> --format '{{.Config.Image}}'  # Image used
```

### Process and resource info

```bash
docker-safe top <container>        # Running processes
docker-safe stats --no-stream      # Resource usage snapshot
docker-safe stats <container> --no-stream  # Single container
docker-safe port <container>       # Port mappings
```

### Filesystem changes

```bash
docker-safe diff <container>       # Changed files since start
```

### Images and system

```bash
docker-safe images                 # List images
docker-safe version                # Docker/Podman version
docker-safe info                   # System-wide info
```

## Common Debug Patterns

### Find a container by name pattern

```bash
docker-safe ps --filter name=pi-config --format '{{.Names}} {{.Status}} {{.RunningFor}}'
```

### Check why a container exited

```bash
docker-safe inspect <container> --format '{{.State.ExitCode}} {{.State.Error}}'
docker-safe logs <container> --tail 50
```

### Check resource usage

```bash
docker-safe stats --no-stream --format 'table {{.Name}}\t{{.CPUPerc}}\t{{.MemUsage}}'
```

### Find stuck processes in a container

```bash
docker-safe top <container> -eo pid,ppid,stat,etime,args
```

## Blocked Commands

The following are **not available** through docker-safe:

- `exec` — cannot run commands inside containers
- `run` — cannot create new containers
- `rm` / `stop` / `kill` — cannot modify container state
- `cp` — cannot copy files in/out
- `build` / `push` / `pull` — cannot manage images
- `network` / `volume` — cannot manage infrastructure

If you need these operations, ask the user to run them directly on the host.

## Prerequisites

Requires container socket mounted with group access:

```bash
# Docker
-v /var/run/docker.sock:/var/run/docker.sock:ro \
--group-add $(stat -c '%g' /var/run/docker.sock)

# Podman
-v /var/run/podman/podman.sock:/var/run/podman/podman.sock:ro
```
