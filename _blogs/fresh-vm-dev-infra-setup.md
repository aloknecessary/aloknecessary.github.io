---
title: "Fresh VM to Dev Infra: The Complete Setup Guide"
date: 2026-03-04
last_modified_at: 2026-03-04
author: Alok Ranjan Daftuar
description: "Step-by-step guide to bootstrapping a fresh Linux VM with Docker, GitHub self-hosted runner, SQL Server, Redis, Portainer, and Adminer via docker-compose."
excerpt: "Bootstrap a production-ready dev infrastructure VM with Docker, GitHub Actions runner, SQL, Redis, Portainer and Adminer — from zero to running in under an hour."
keywords: "fresh vm dev setup, github self-hosted runner linux, docker-compose dev infrastructure, portainer adminer redis sql server ubuntu"
twitter_card: summary_large_image
categories:
  - devops
  - infrastructure
tags: [docker, github-actions, self-hosted-runner, redis, sql-server, portainer, ubuntu, dev-infra]
---

Every team eventually needs a dedicated dev or staging VM — a place to run integration tests, host shared services, and fire CI/CD pipelines without routing everything through the cloud. Spinning one up correctly the first time saves hours of debugging later.

This guide walks you through bootstrapping a fresh Ubuntu 22.04 LTS VM from a bare OS install to a fully operational developer infrastructure node. By the end you'll have: a hardened base OS, Docker with proper daemon configuration, a GitHub Actions self-hosted runner registered to your org, and a full stack of shared dev services — SQL Server, Redis, Portainer, and Adminer — all wired together via `docker-compose`.

Everything here is reproducible. You can run it as a script, drop it into user-data for a cloud VM, or hand it to a teammate to replicate the setup.

<!--more-->

---

## Prerequisites and Assumptions

- **OS**: Ubuntu 22.04 LTS (adjust `apt` commands for other distros)
- **VM spec**: Minimum 4 vCPU / 8 GB RAM / 50 GB disk. For SQL Server: 8 GB RAM is the realistic floor.
- **Access**: SSH as a non-root user with `sudo` privileges
- **GitHub**: Org-level or repo-level admin access to register a runner
- **Network**: Ports 443 (outbound to GitHub), 9443 (Portainer UI), 8080 (Adminer), and your DB ports accessible as needed

---

## Step 1: OS Hardening and Base Packages

Start with a clean baseline. Update the system, lock down SSH, and install the tools you'll rely on throughout.

```bash
sudo apt-get update && sudo apt-get upgrade -y

# Essential tooling
sudo apt-get install -y \
  curl wget git unzip jq \
  ca-certificates gnupg lsb-release \
  ufw fail2ban \
  htop iotop net-tools \
  apt-transport-https

# Set timezone (adjust to your region)
sudo timedatectl set-timezone UTC
```

### Configure UFW Firewall

```bash
# Default deny inbound, allow outbound
sudo ufw default deny incoming
sudo ufw default allow outgoing

# SSH (change 22 to your custom port if applicable)
sudo ufw allow 22/tcp

# Docker-managed ports — Docker bypasses UFW iptables by default.
# We'll handle container exposure via docker-compose port binding to localhost
# and open only what's intentionally public.
sudo ufw allow 9443/tcp   # Portainer UI (HTTPS)
sudo ufw allow 8080/tcp   # Adminer

# Enable
sudo ufw --force enable
sudo ufw status verbose
```

> **Important**: Docker modifies iptables directly and can bypass UFW rules for published ports. If your VM is cloud-hosted, use the cloud provider's security groups/NSGs as the primary perimeter, and rely on UFW as a secondary layer.

### Harden SSH

```bash
sudo nano /etc/ssh/sshd_config
```

Ensure these directives are set:

```
PasswordAuthentication no
PermitRootLogin no
PubkeyAuthentication yes
MaxAuthTries 3
ClientAliveInterval 300
ClientAliveCountMax 2
X11Forwarding no
```

```bash
sudo systemctl restart sshd
```

### Create a Dedicated Service User

Avoid running services as your personal user or root. Create a `devops` user for service ownership:

```bash
sudo useradd -m -s /bin/bash devops
sudo usermod -aG sudo devops

# Copy your SSH key to the new user
sudo mkdir -p /home/devops/.ssh
sudo cp ~/.ssh/authorized_keys /home/devops/.ssh/
sudo chown -R devops:devops /home/devops/.ssh
sudo chmod 700 /home/devops/.ssh
sudo chmod 600 /home/devops/.ssh/authorized_keys
```

---

## Step 2: Install Docker Engine

Don't use the `docker.io` package from Ubuntu's default repos — it's always behind. Use Docker's official apt repository.

```bash
# Add Docker's GPG key
sudo install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/ubuntu/gpg | \
  sudo gpg --dearmor -o /etc/apt/keyrings/docker.gpg
sudo chmod a+r /etc/apt/keyrings/docker.gpg

# Add the repository
echo \
  "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] \
  https://download.docker.com/linux/ubuntu \
  $(. /etc/os-release && echo "$VERSION_CODENAME") stable" | \
  sudo tee /etc/apt/sources.list.d/docker.list > /dev/null

# Install
sudo apt-get update
sudo apt-get install -y \
  docker-ce docker-ce-cli containerd.io \
  docker-buildx-plugin docker-compose-plugin

# Add your users to the docker group
sudo usermod -aG docker $USER
sudo usermod -aG docker devops
```

### Configure the Docker Daemon

A production-grade `daemon.json` configures log rotation, sets sane defaults, and prevents runaway disk usage from container logs:

```bash
sudo nano /etc/docker/daemon.json
```

```json
{
  "log-driver": "json-file",
  "log-opts": {
    "max-size": "20m",
    "max-file": "5"
  },
  "default-ulimits": {
    "nofile": {
      "Name": "nofile",
      "Hard": 64000,
      "Soft": 64000
    }
  },
  "live-restore": true,
  "userland-proxy": false,
  "storage-driver": "overlay2",
  "metrics-addr": "127.0.0.1:9323",
  "experimental": true
}
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable docker
sudo systemctl restart docker

# Verify
docker version
docker compose version
```

---

## Step 3: Directory Layout

Establish a clean directory structure before deploying anything. This makes backup, secrets management, and debugging predictable.

```bash
sudo mkdir -p /opt/dev-infra/{runner,services/{data/{mssql,redis},config}}
sudo chown -R devops:devops /opt/dev-infra
```

Final structure:

```
/opt/dev-infra/
├── runner/                  # GitHub Actions runner installation
├── services/
│   ├── docker-compose.yml   # All shared dev services
│   ├── .env                 # Non-secret environment overrides
│   ├── secrets/             # Secret files (gitignored, chmod 600)
│   │   ├── mssql_sa_password
│   │   └── redis_password
│   ├── config/
│   │   └── redis.conf       # Redis configuration
│   └── data/
│       ├── mssql/           # SQL Server data files (persistent volume)
│       └── redis/           # Redis AOF/RDB persistence
```

---

## Step 4: GitHub Actions Self-Hosted Runner

You can register a runner at the repository level or organisation level. Org-level runners are reusable across all repos and are the better default for a shared dev VM.

### Get the Registration Token

**Via GitHub UI**: `Settings → Actions → Runners → New self-hosted runner`

**Via GitHub API** (scriptable, preferred):

```bash
# Org-level runner token (requires admin:org scope)
GITHUB_PAT="ghp_your_pat_here"
ORG="your-org-name"

TOKEN=$(curl -s -X POST \
  -H "Authorization: Bearer ${GITHUB_PAT}" \
  -H "Accept: application/vnd.github+json" \
  "https://api.github.com/orgs/${ORG}/actions/runners/registration-token" \
  | jq -r '.token')

echo "Runner token: $TOKEN"
```

### Download and Install the Runner

```bash
cd /opt/dev-infra/runner

# Get the latest runner version dynamically
RUNNER_VERSION=$(curl -s https://api.github.com/repos/actions/runner/releases/latest \
  | jq -r '.tag_name' | sed 's/v//')

curl -fsSL \
  "https://github.com/actions/runner/releases/download/v${RUNNER_VERSION}/actions-runner-linux-x64-${RUNNER_VERSION}.tar.gz" \
  -o runner.tar.gz

tar xzf runner.tar.gz
rm runner.tar.gz

# Fix ownership
sudo chown -R devops:devops /opt/dev-infra/runner
```

### Configure the Runner

```bash
# Switch to devops user for configuration
sudo -u devops bash -c "
  cd /opt/dev-infra/runner && \
  ./config.sh \
    --url https://github.com/your-org-name \
    --token ${TOKEN} \
    --name $(hostname)-dev \
    --labels self-hosted,linux,x64,dev-vm \
    --runnergroup Default \
    --work _work \
    --unattended \
    --replace
"
```

**Labels** are how your workflows target this runner. Be specific — `dev-vm` lets you distinguish this from a Kubernetes ARC runner with the same `linux` label.

### Install as a systemd Service

```bash
cd /opt/dev-infra/runner

# Install the service (must run as root, but will run as devops)
sudo ./svc.sh install devops
sudo ./svc.sh start
sudo ./svc.sh status
```

Verify the service unit:

```bash
sudo systemctl status actions.runner.*.service
```

The runner should appear as **Online** in your GitHub org settings within 30 seconds.

### Runner Environment Variables

The runner inherits the environment of the service. Set environment variables the runner needs in a dedicated override file:

```bash
sudo systemctl edit actions.runner.your-org.$(hostname)-dev.service
```

```ini
[Service]
Environment="DOCKER_HOST=unix:///var/run/docker.sock"
Environment="RUNNER_ALLOW_RUNASROOT=false"
Environment="HOME=/home/devops"
```

```bash
sudo systemctl daemon-reload
sudo systemctl restart actions.runner.your-org.$(hostname)-dev.service
```

---

## Step 5: Dev Services Stack via Docker Compose

Now deploy the shared dev services. All services go into a single `docker-compose.yml` under a dedicated Docker network, with persistent volumes and proper secret handling.

### Secrets First

Never put passwords directly in `docker-compose.yml` or `.env` files that might be committed. Use Docker secrets for sensitive values:

```bash
cd /opt/dev-infra/services
mkdir -p secrets

# Generate strong passwords
openssl rand -base64 32 | tr -d '\n' > secrets/mssql_sa_password
openssl rand -base64 24 | tr -d '\n' > secrets/redis_password

# Lock down permissions
chmod 600 secrets/mssql_sa_password secrets/redis_password
```

### Redis Configuration

```bash
cat > /opt/dev-infra/services/config/redis.conf << 'EOF'
# Bind to all interfaces within the container (network policy handles exposure)
bind 0.0.0.0

# Require password auth (injected via entrypoint from secret)
# requirepass is set dynamically via command override in compose

# Persistence: AOF for durability, RDB as backup
appendonly yes
appendfilename "appendonly.aof"
appendfsync everysec

save 900 1
save 300 10
save 60 10000

# Memory management
maxmemory 512mb
maxmemory-policy allkeys-lru

# Disable dangerous commands in shared environments
rename-command FLUSHALL ""
rename-command FLUSHDB ""
rename-command CONFIG ""
rename-command DEBUG ""
EOF
```

### .env File

```bash
cat > /opt/dev-infra/services/.env << 'EOF'
# Non-secret configuration
COMPOSE_PROJECT_NAME=dev-infra

# SQL Server
MSSQL_PID=Developer
MSSQL_COLLATION=SQL_Latin1_General_CP1_CI_AS
ACCEPT_EULA=Y

# Portainer
PORTAINER_VERSION=2.39.0-alpine

# Adminer
ADMINER_VERSION=4.8.1

# Redis
REDIS_VERSION=7.2-alpine

# MSSQL
MSSQL_VERSION=2022-latest
EOF
```

### docker-compose.yml

```yaml
# /opt/dev-infra/services/docker-compose.yml
version: "3.9"

secrets:
  mssql_sa_password:
    file: ./secrets/mssql_sa_password
  redis_password:
    file: ./secrets/redis_password

networks:
  dev-net:
    driver: bridge
    ipam:
      config:
        - subnet: 172.20.0.0/24

volumes:
  mssql-data:
    driver: local
    driver_opts:
      type: none
      o: bind
      device: /opt/dev-infra/services/data/mssql
  redis-data:
    driver: local
    driver_opts:
      type: none
      o: bind
      device: /opt/dev-infra/services/data/redis
  portainer-data:
    driver: local

services:

  # ─────────────────────────────────────────
  # SQL Server 2022 (Developer Edition)
  # ─────────────────────────────────────────
  mssql:
    image: mcr.microsoft.com/mssql/server:${MSSQL_VERSION}
    container_name: dev-mssql
    restart: unless-stopped
    networks:
      - dev-net
    ports:
      - "127.0.0.1:1433:1433"   # Bind to localhost only — not exposed externally
    environment:
      ACCEPT_EULA: "${ACCEPT_EULA}"
      MSSQL_PID: "${MSSQL_PID}"
      MSSQL_COLLATION: "${MSSQL_COLLATION}"
      MSSQL_SA_PASSWORD_FILE: /run/secrets/mssql_sa_password
    secrets:
      - mssql_sa_password
    volumes:
      - mssql-data:/var/opt/mssql
    healthcheck:
      test: >
        /opt/mssql-tools18/bin/sqlcmd
        -S localhost -U SA
        -P "$$(cat /run/secrets/mssql_sa_password)"
        -Q "SELECT 1"
        -No -C
      interval: 30s
      timeout: 10s
      retries: 5
      start_period: 60s   # SQL Server is slow to initialize
    deploy:
      resources:
        limits:
          memory: 4G        # SQL Server minimum recommended: 2G, realistic: 4G
        reservations:
          memory: 2G

  # ─────────────────────────────────────────
  # Redis 7.2
  # ─────────────────────────────────────────
  redis:
    image: redis:${REDIS_VERSION}
    container_name: dev-redis
    restart: unless-stopped
    networks:
      - dev-net
    ports:
      - "127.0.0.1:6379:6379"   # localhost only
    secrets:
      - redis_password
    volumes:
      - redis-data:/data
      - ./config/redis.conf:/usr/local/etc/redis/redis.conf:ro
    command: >
      sh -c "redis-server /usr/local/etc/redis/redis.conf
             --requirepass $$(cat /run/secrets/redis_password)"
    healthcheck:
      test: >
        sh -c "redis-cli -a $$(cat /run/secrets/redis_password) ping | grep PONG"
      interval: 15s
      timeout: 5s
      retries: 3
    deploy:
      resources:
        limits:
          memory: 768M
        reservations:
          memory: 256M

  # ─────────────────────────────────────────
  # Portainer CE 2.39 (Docker management UI)
  # HTTPS is on by default (port 9443) since CE 2.9 — no --ssl flag needed.
  # --sslcert/--sslkey deprecated since 2.35; use --tlscert/--tlskey instead.
  # ─────────────────────────────────────────
  portainer:
    image: portainer/portainer-ce:${PORTAINER_VERSION}
    container_name: dev-portainer
    restart: unless-stopped
    networks:
      - dev-net
    ports:
      - "9443:9443"             # HTTPS UI — intentionally exposed for team access
      - "8000:8000"             # Edge Agent tunnel port
      - "127.0.0.1:9000:9000"  # HTTP — localhost only; redirect users to 9443
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock:ro   # Read-only socket
      - portainer-data:/data
      - /opt/dev-infra/services/certs:/certs:ro        # Custom TLS cert (optional)
    # No command needed for default auto-generated self-signed cert.
    # To supply your own cert, use the 2.35+ flag syntax (--tlscert/--tlskey):
    # command: --tlscert /certs/portainer.crt --tlskey /certs/portainer.key
    healthcheck:
      test: ["CMD", "wget", "--no-verbose", "--tries=1", "--spider", "https://localhost:9443", "--no-check-certificate"]
      interval: 30s
      timeout: 10s
      retries: 3

  # ─────────────────────────────────────────
  # Adminer (lightweight DB GUI)
  # ─────────────────────────────────────────
  adminer:
    image: adminer:${ADMINER_VERSION}
    container_name: dev-adminer
    restart: unless-stopped
    networks:
      - dev-net
    ports:
      - "8080:8080"     # Exposed — team access
    environment:
      ADMINER_DEFAULT_SERVER: mssql
      ADMINER_DESIGN: pepa-linha-dark
    depends_on:
      mssql:
        condition: service_healthy
    deploy:
      resources:
        limits:
          memory: 128M
```

> **On Portainer's Docker socket mount**: The compose file mounts the socket read-only (`:ro`). Portainer CE requires write access to manage containers, so in practice you'll need to remove the `:ro` flag if you want full management capabilities. Be aware this is a privileged operation — anyone with Portainer access can escalate to the host. For a shared dev VM with a trusted team, this is acceptable. For multi-tenant environments, run Portainer Agent instead and scope access via Portainer's RBAC.

> **HTTPS by default**: Since Portainer CE 2.9, HTTPS is enabled automatically on port 9443 with a self-generated self-signed cert. You no longer need to pass any `command` flags just to get TLS. The `command` line in the compose file above is commented out — only uncomment it when supplying your own certificate.

### Start the Stack

```bash
cd /opt/dev-infra/services

# Ensure data directories exist with correct ownership
mkdir -p data/mssql data/redis
sudo chown -R 10001:0 data/mssql    # SQL Server runs as uid 10001
chmod -R 755 data/mssql

# Pull images first (avoids timeout issues on first start)
docker compose pull

# Start all services
docker compose up -d

# Watch startup logs
docker compose logs -f --tail=50
```

### Verify Health

```bash
# All services should show "healthy" or "running"
docker compose ps

# Test SQL Server connectivity
MSSQL_PASS=$(cat /opt/dev-infra/services/secrets/mssql_sa_password)
docker exec dev-mssql \
  /opt/mssql-tools18/bin/sqlcmd \
  -S localhost -U SA -P "$MSSQL_PASS" \
  -Q "SELECT @@VERSION" -No -C

# Test Redis
REDIS_PASS=$(cat /opt/dev-infra/services/secrets/redis_password)
docker exec dev-redis redis-cli -a "$REDIS_PASS" ping
# Expected: PONG

# Portainer UI
curl -sk https://localhost:9443 | grep -o "<title>[^<]*"

# Adminer
curl -s http://localhost:8080 | grep -o "<title>[^<]*"
```

---

## Step 6: Portainer Custom TLS Certificate (Optional)

Since Portainer CE 2.9, HTTPS on port 9443 is enabled out of the box with an auto-generated self-signed certificate — you don't need to do anything to get TLS. This step is only needed if you want to supply your **own** certificate (e.g. from an internal CA or Let's Encrypt) to avoid browser warnings.

Generate a self-signed cert with a proper SAN (Subject Alternative Name) so modern browsers don't reject it:

```bash
sudo mkdir -p /opt/dev-infra/services/certs

sudo openssl req -x509 -nodes -days 3650 -newkey rsa:4096 \
  -keyout /opt/dev-infra/services/certs/portainer.key \
  -out /opt/dev-infra/services/certs/portainer.crt \
  -subj "/C=IN/ST=Jharkhand/O=DevInfra/CN=$(hostname -f)" \
  -addext "subjectAltName=IP:$(hostname -I | awk '{print $1}'),DNS:$(hostname -f)"

sudo chmod 600 /opt/dev-infra/services/certs/portainer.key
```

The certs directory is already mounted in the compose file (`/opt/dev-infra/services/certs:/certs:ro`). To activate your cert, uncomment the `command` line in the Portainer service using the **2.35+ flag names**:

```yaml
# Portainer 2.35+ — use --tlscert / --tlskey (--sslcert/--sslkey are deprecated)
command: --tlscert /certs/portainer.crt --tlskey /certs/portainer.key
```

> **Deprecation note**: `--sslcert` and `--sslkey` were deprecated in Portainer 2.35 and will be removed in a future release. Always use `--tlscert` / `--tlskey` on 2.35+. The old `--ssl` flag (which toggled TLS on/off) is also gone — TLS is always on.

---

## Step 7: Using the Runner in Workflows

With the runner online, target it in your workflows using the labels you assigned during registration:

```yaml
# .github/workflows/integration-test.yml
name: Integration Tests

on:
  push:
    branches: [main, develop]
  pull_request:

jobs:
  test:
    runs-on: [self-hosted, linux, dev-vm]   # Targets your VM runner
    
    steps:
      - uses: actions/checkout@v4

      - name: Wait for SQL Server
        run: |
          for i in {1..30}; do
            if docker exec dev-mssql \
              /opt/mssql-tools18/bin/sqlcmd \
              -S localhost -U SA \
              -P "${{ secrets.DEV_MSSQL_SA_PASSWORD }}" \
              -Q "SELECT 1" -No -C 2>/dev/null; then
              echo "SQL Server ready"
              break
            fi
            echo "Waiting... ($i/30)"
            sleep 5
          done

      - name: Run Integration Tests
        env:
          ConnectionStrings__DefaultConnection: >
            Server=localhost,1433;Database=TestDb;
            User Id=SA;Password=${{ secrets.DEV_MSSQL_SA_PASSWORD }};
            TrustServerCertificate=True
          Redis__ConnectionString: "localhost:6379,password=${{ secrets.DEV_REDIS_PASSWORD }}"
        run: dotnet test --configuration Release --filter Category=Integration

      - name: Cleanup Test Database
        if: always()
        run: |
          docker exec dev-mssql \
            /opt/mssql-tools18/bin/sqlcmd \
            -S localhost -U SA \
            -P "${{ secrets.DEV_MSSQL_SA_PASSWORD }}" \
            -Q "DROP DATABASE IF EXISTS TestDb" -No -C
```

Store `DEV_MSSQL_SA_PASSWORD` and `DEV_REDIS_PASSWORD` as GitHub repository or org secrets — read them out of the Docker secrets files:

```bash
cat /opt/dev-infra/services/secrets/mssql_sa_password
cat /opt/dev-infra/services/secrets/redis_password
```

---

## Step 8: Maintenance and Operations

### Update Services

```bash
cd /opt/dev-infra/services
docker compose pull          # Pull latest images matching version tags
docker compose up -d         # Recreate only changed containers
docker image prune -f        # Clean up dangling images
```

### Update the GitHub Runner

```bash
# The runner will auto-update by default when GitHub releases new versions.
# To manually update:
cd /opt/dev-infra/runner
sudo ./svc.sh stop
sudo -u devops ./config.sh remove --token $(./token-refresh.sh)

# Re-download latest and re-register (use Step 4 commands)
```

### Backup Data Volumes

```bash
#!/bin/bash
# /opt/dev-infra/backup.sh

BACKUP_DIR="/opt/backups/$(date +%Y%m%d-%H%M%S)"
mkdir -p "$BACKUP_DIR"

# SQL Server: use sqlcmd for logical backup
MSSQL_PASS=$(cat /opt/dev-infra/services/secrets/mssql_sa_password)
docker exec dev-mssql \
  /opt/mssql-tools18/bin/sqlcmd \
  -S localhost -U SA -P "$MSSQL_PASS" -No -C \
  -Q "BACKUP DATABASE [YourDB] TO DISK = N'/var/opt/mssql/backup/YourDB.bak' WITH INIT"

# Copy backup out of container
docker cp dev-mssql:/var/opt/mssql/backup/ "$BACKUP_DIR/mssql/"

# Redis: trigger BGSAVE and copy RDB
docker exec dev-redis redis-cli -a "$REDIS_PASS" BGSAVE
sleep 5
docker cp dev-redis:/data/ "$BACKUP_DIR/redis/"

echo "Backup complete: $BACKUP_DIR"
```

```bash
chmod +x /opt/dev-infra/backup.sh

# Schedule daily at 2am
(crontab -l 2>/dev/null; echo "0 2 * * * /opt/dev-infra/backup.sh >> /var/log/dev-infra-backup.log 2>&1") | crontab -
```

### Monitor Service Health

```bash
# Quick status check — add to a daily cron or monitoring script
docker compose -f /opt/dev-infra/services/docker-compose.yml ps --format json \
  | jq -r '.[] | "\(.Name): \(.Status)"'
```

---

## Quick Reference: Ports and Access

| Service | Port | Bind | Access |
|---|---|---|---|
| SQL Server | 1433 | `127.0.0.1` | localhost / SSH tunnel only |
| Redis | 6379 | `127.0.0.1` | localhost / SSH tunnel only |
| Portainer UI | 9443 | `0.0.0.0` | `https://VM_IP:9443` |
| Adminer | 8080 | `0.0.0.0` | `http://VM_IP:8080` |
| GitHub Runner | — | outbound only | GitHub API (443) |
| Docker metrics | 9323 | `127.0.0.1` | Prometheus scrape |

**SSH tunnel for local DB access** (from your dev machine):

```bash
# Forward SQL Server to your local machine
ssh -L 1433:localhost:1433 devops@VM_IP -N

# Forward Redis
ssh -L 6379:localhost:6379 devops@VM_IP -N

# Or both at once
ssh -L 1433:localhost:1433 -L 6379:localhost:6379 devops@VM_IP -N
```

Then connect your local tooling (SSMS, DataGrip, RedisInsight) to `localhost` on the respective port.

---

## Common Pitfalls

**SQL Server won't start / exits with code 1**
Almost always a permissions issue on the data directory or the SA password not meeting complexity requirements (min 8 chars, upper + lower + digit + symbol).

```bash
# Check logs
docker logs dev-mssql --tail=50

# Verify directory ownership
ls -la /opt/dev-infra/services/data/mssql
# Should be owned by uid 10001
```

**Redis password not applied after config change**
The password is injected via the `command` override using the secret file. If you change the secret file, recreate the container:

```bash
docker compose up -d --force-recreate redis
```

**GitHub runner shows offline after VM reboot**
The runner service should survive reboots via systemd. If it doesn't:

```bash
sudo systemctl enable actions.runner.*.service
sudo systemctl start actions.runner.*.service
journalctl -u actions.runner.*.service -n 50
```

**Portainer loses data after recreate**
Ensure `portainer-data` is a named volume (not anonymous). The compose file above uses a named volume — it persists across `docker compose down` and `up`.

---

## Summary

Here's what you've built:

Starting from a bare Ubuntu 22.04 VM, you now have a hardened OS baseline with UFW and SSH key auth, Docker Engine with production-grade daemon configuration and log rotation, a GitHub Actions self-hosted runner registered at the org level and running as a systemd service under a dedicated non-root user, and a full dev services stack — SQL Server 2022 Developer Edition with a persistent data volume, Redis 7.2 with AOF persistence and memory limits, Portainer CE 2.39 with default HTTPS on 9443 for container management, and Adminer for database access — all on an isolated bridge network with secrets managed via Docker secrets files rather than environment variables.

The entire setup is idempotent and reproducible. Store the `docker-compose.yml`, `.env`, and `config/` directory in a private git repo (exclude `secrets/` and `data/`) and you can rebuild this environment on a new VM in under 30 minutes.

---

*Questions on runner configuration, SQL Server tuning, or extending this stack with additional services? Drop a comment below.*
