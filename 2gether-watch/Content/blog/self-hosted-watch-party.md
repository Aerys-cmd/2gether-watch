---
title: "Self-Hosted Watch Party: Run Your Own With Docker"
description: How to self-host 2gether Watch with Docker Compose, and why you'd want to run your own watch party server instead of using a third-party one.
keyword: self hosted watch party
date: 2026-08-01
published: true
---

Most watch-party apps are SaaS-only — you use their server, or you don't use the app. [2gether Watch](/) is open source and built to be self-hosted, so you can run the whole thing on your own server instead.

## Why self-host a watch party app

- **You control the signaling server.** The server's only job is to relay WebSocket signaling messages (SDP, ICE candidates) between peers in a room — it never touches the actual audio, video, or screen-share media, since that travels peer-to-peer over WebRTC. Self-hosting means you control the one piece of infrastructure involved.
- **No dependency on a third party staying online.** If a hosted service shuts down or changes its pricing, a self-hosted instance keeps working as long as your server does.
- **Custom domain, no branding.** Run it at your own subdomain, behind your own reverse proxy, with your own TLS certificate.

## Running it with Docker Compose

The repository ships a `docker-compose.yml` designed to run behind a reverse proxy like Traefik with Let's Encrypt TLS. At a high level:

```bash
git clone https://github.com/Aerys-cmd/2gether-watch.git
cd 2gether-watch
docker compose up -d
```

The container exposes the ASP.NET Core app; a reverse proxy in front handles TLS termination, since WebRTC camera/microphone access requires HTTPS. Two optional environment variables control integrations that are otherwise disabled: a feedback-widget public key, and a Google Analytics measurement ID. Neither is required to run the app.

Full instructions, including building from source instead of using the prebuilt image, live in `docs/SELF-HOSTING.md` in the repository.

## What you're actually running

Under the hood it's an ASP.NET Core app with a single WebSocket endpoint (`/ws`) that assigns peer IDs, relays signaling messages within a room, and enforces a room-size cap. There's no database — rooms are ephemeral and exist only in server memory for as long as peers are connected. That's also why there's nothing to back up: if the process restarts, in-progress rooms end, but no data is lost because there was none to begin with.

If you're already running a few self-hosted services and want your watch-party server to be one more container in the same stack rather than another third-party account, this is built for exactly that.
