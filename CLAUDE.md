# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
# Run the app
dotnet run --project 2gether-watch

# Build (solution-level)
dotnet build 2gether-watch.sln

# Backend unit tests (xUnit)
dotnet test 2gether-watch.sln

# E2E tests (Playwright) — requires the app running on port 5000
cd frontend-tests
npm ci
npx playwright install --with-deps chromium
npm run test:e2e

# Single E2E test file
npx playwright test e2e/video-sync.spec.js
```

## Architecture

**Stack:** ASP.NET Core 10 Razor Pages + vanilla JS (no build step). Frontend CSS/Alpine.js loaded from CDN — there is no `package.json` at the repo root and no bundler.

**WebSocket signaling (`/ws`)** — `RoomManager` (singleton) is the entire backend. It maintains a `ConcurrentDictionary<roomId, Dictionary<peerId, WebSocket>>` protected by a single `Lock`. The server is a pure signaling relay; it never touches media. The text protocol is documented in the `RoomManager` class summary.

**WebRTC topology** — full mesh; each peer opens an `RTCPeerConnection` to every other peer. Max 10 peers per room (`RoomManager.MaxRoomSize`).

**Frontend entry point** — `2gether-watch/wwwroot/js/webrtc.js` is a single non-module `<script>`. Alpine.js state lives on `window.alpineApp`; Playwright tests access runtime state via `window.rtcActions` (exposed at the bottom of the file).

**Room ID validation** — `RoomValidation.RoomIdPattern()` (`[A-Za-z0-9_-]{1,64}`) is shared between `Room.cshtml.cs` (HTTP) and `RoomManager` (WebSocket). Update both sides together if the pattern changes.

**Deployment** — Docker image pushed to GHCR on release, deployed to a VPS behind Traefik via `docker-compose.yml`. `FeedbackHub__PublicKey` is the only optional runtime secret.

**E2E test strategy** — two-peer tests open two browser contexts and go through the real WS relay. Single-peer tests use `page.on("websocket")` to capture outbound frames. `applyRemoteSync` is called directly as a global function to test the receiving side in isolation.
