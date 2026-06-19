# Self-Hosting 2gether Watch

This guide covers two ways to run your own instance of 2gether Watch.

---

## Option A — Docker Compose (recommended)

The easiest way to self-host. The published image is
`ghcr.io/aerys-cmd/2gether-watch:latest`.

### Prerequisites

- A Linux server with [Docker](https://docs.docker.com/engine/install/) and the
  [Compose plugin](https://docs.docker.com/compose/install/)
- A domain name pointed at your server (required for HTTPS, which WebRTC
  camera/mic access needs in production browsers)
- Ports **80** and **443** open in your firewall

### 1. Set up Traefik (reverse proxy + TLS)

If you do not already have Traefik running, here is a minimal bootstrap:

```bash
# Create the shared network
docker network create web

# Create a Traefik data directory
mkdir -p /opt/traefik && cd /opt/traefik

cat > docker-compose.yml <<'EOF'
services:
  traefik:
    image: traefik:v3
    restart: unless-stopped
    command:
      - "--providers.docker=true"
      - "--providers.docker.exposedbydefault=false"
      - "--entrypoints.web.address=:80"
      - "--entrypoints.web.http.redirections.entrypoint.to=websecure"
      - "--entrypoints.websecure.address=:443"
      - "--certificatesresolvers.letsencrypt.acme.tlschallenge=true"
      - "--certificatesresolvers.letsencrypt.acme.email=you@example.com"
      - "--certificatesresolvers.letsencrypt.acme.storage=/acme.json"
    ports:
      - "80:80"
      - "443:443"
    volumes:
      - "/var/run/docker.sock:/var/run/docker.sock:ro"
      - "./acme.json:/acme.json"
    networks:
      - web

networks:
  web:
    external: true
EOF

touch acme.json && chmod 600 acme.json
docker compose up -d
```

### 2. Deploy 2gether Watch

```bash
mkdir -p /opt/2gether-watch && cd /opt/2gether-watch

curl -fsSL https://raw.githubusercontent.com/Aerys-cmd/2gether-watch/main/docker-compose.yml \
  -o docker-compose.yml
```

Edit `docker-compose.yml` and replace `2gether-watch.lunavex.com` with **your own domain**:

```yaml
- "traefik.http.routers.2gether-watch.rule=Host(`your.domain.com`)"
```

Then start the service:

```bash
docker compose up -d
docker compose logs -f   # watch for startup errors
```

The app will be live at `https://your.domain.com` within a few seconds once
Let's Encrypt issues a certificate.

### Updating

```bash
docker compose pull
docker compose up -d
```

---

## Option B — Build from source

### Prerequisites

- [.NET 10 SDK](https://dotnet.microsoft.com/download/dotnet/10)
- A reverse proxy (nginx, Caddy, Traefik…) in front for HTTPS

### Steps

```bash
git clone https://github.com/Aerys-cmd/2gether-watch.git
cd 2gether-watch

dotnet publish 2gether-watch/2gether-watch.csproj \
  -c Release \
  -o ./publish \
  /p:UseAppHost=false

dotnet ./publish/2gether-watch.dll
```

The app listens on `http://localhost:5000` by default. Set the `ASPNETCORE_URLS`
environment variable to change the address:

```bash
ASPNETCORE_URLS=http://+:8080 dotnet ./publish/2gether-watch.dll
```

### Behind a reverse proxy

Set the following environment variables so ASP.NET Core honours forwarded headers
(required for HTTPS detection and WebSocket upgrades):

```bash
ASPNETCORE_FORWARDEDHEADERS_ENABLED=true
```

Refer to the
[ASP.NET Core reverse proxy documentation](https://learn.microsoft.com/aspnet/core/host-and-deploy/proxy-load-balancer)
for nginx/Caddy configuration examples.

---

## Configuration reference

| Environment variable | Default | Description |
|---|---|---|
| `ASPNETCORE_URLS` | `http://+:8080` | Listening address inside the container |
| `ASPNETCORE_FORWARDEDHEADERS_ENABLED` | `true` (compose) | Trust `X-Forwarded-*` headers from a reverse proxy |
| `ASPNETCORE_ENVIRONMENT` | `Production` | Set to `Development` for verbose logs |

---

## Adding a TURN server (optional)

By default the app uses only public Google STUN servers. Users behind strict NAT
or corporate firewalls may fail to establish peer-to-peer connections without a
TURN relay.

To add your own TURN server, edit `wwwroot/js/webrtc.js` (or override it in your
own build) and extend the `ICE_SERVERS` constant:

```js
const ICE_SERVERS = [
    { urls: "stun:stun.l.google.com:19302" },
    { urls: "stun:stun1.l.google.com:19302" },
    {
        urls:       "turn:your-turn-server.example.com:3478",
        username:   "user",
        credential: "password",
    },
];
```

> **Note**: TURN credentials are visible in the browser's source. Use
> time-limited credentials generated server-side for production deployments.

---

## Running tests

```bash
dotnet test 2gether-watch.Tests/2gether-watch.Tests.csproj
```
