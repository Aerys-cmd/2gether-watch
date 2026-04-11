# Frontend tests (WebRTC/UI behavior)

This folder adds frontend-side tests for `2gether-watch/wwwroot/js/webrtc.js`.

It includes:
- browser E2E tests (`playwright`) with 2 real tabs/peers.

These cover scenarios backend-only tests cannot validate:
- a joiner receives remote camera without enabling local camera,
- remote camera tile does not stay gray/blank when live video is available,
- stream-kind and track routing behavior during negotiation,
- autoplay recovery after browser gesture-gating.

## Install

```bash
cd frontend-tests
npm install
npx playwright install chromium
```

## Run Browser E2E Tests

The Playwright config starts the app from source via `dotnet run`.

```bash
cd frontend-tests
npm run test:e2e
```

## Run Headed / Debug

Use these when diagnosing flaky behavior locally.

```bash
cd frontend-tests
npm run test:e2e:headed
npm run test:e2e:debug
```

## Notes

- E2E runs in a real browser runtime and does not stub CDN scripts.
- Chromium uses fake camera/mic flags so no physical camera is required.
- `webServer.reuseExistingServer` is disabled to keep CI runs deterministic.
- Existing backend xUnit tests remain unchanged in `2gether-watch.Tests`.

