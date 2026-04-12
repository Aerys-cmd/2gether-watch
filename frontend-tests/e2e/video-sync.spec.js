/**
 * E2E tests for the synced video feature.
 *
 * Coverage:
 *  - HTML5 video URL sync: "load" propagated to an active peer and to a late joiner.
 *  - Sync message sending: onplay / onpause / onseeked handlers emit the correct
 *    WebSocket frame.
 *  - Regression — throttle bug: pause/play must NOT be dropped even when they
 *    occur immediately after a seek (previously the SYNC_THROTTLE_MS guard that
 *    was applied to all three event types would silently discard play/pause
 *    events fired within 500 ms of any prior sync message).
 *  - applyRemoteSync: a received pause/seek message updates the receiver's
 *    video player state.
 *
 * Strategy
 * --------
 * Two-peer tests open two browser contexts and exercise the full path:
 *   Peer A user-action → wsSend → server WS relay → Peer B applyRemoteSync → DOM
 *
 * Single-peer WS-capture tests use Playwright's page.on("websocket") listener to
 * inspect outbound WebSocket frames, letting us verify the sending side without
 * requiring actual video file playback.
 *
 * applyRemoteSync tests call the function directly (it is a global function in the
 * non-module script) to verify the receiving-side logic in isolation.
 *
 * Note on Alpine.js
 * -----------------
 * Alpine is loaded from a CDN that may be unavailable in CI.  All helpers in this
 * file intentionally avoid window.alpineApp and instead use DOM-based checks that
 * work regardless of whether Alpine has initialised (matching the approach used in
 * the existing room-media.real.spec.js tests).
 */

const { test, expect } = require("@playwright/test");

// ── helpers ───────────────────────────────────────────────────────────────────

function roomId() {
    return `e2e-vsync-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

/** Navigate to the room and wait until the JS runtime has bootstrapped. */
async function waitForBootstrap(page, id) {
    await page.goto(`/room/${id}`);
    await expect(page.locator("header")).toBeVisible();
    await expect
        .poll(() => page.evaluate(() => !!window.rtcActions?.toggleCamera), { timeout: 20_000 })
        .toBe(true);
}

/**
 * Wait until at least one remote peer cam-tile has been added to the DOM.
 * addPeerCamTile() creates div#cam-tile-{peerId} as soon as ensurePeerState runs,
 * which happens the moment the WS delivers "peers:" or "peer-joined:".
 * This is a pure DOM check — no Alpine dependency.
 */
async function waitForPeerConnected(page, timeout = 15_000) {
    await expect
        .poll(
            () =>
                page.evaluate(
                    () => document.querySelectorAll("[id^='cam-tile-']").length > 0
                ),
            { timeout }
        )
        .toBe(true);
}

/**
 * Wait until the receiving peer shows the expected URL in the URL input AND the
 * #videoPlayer element is no longer hidden.
 */
async function waitForVideoUrl(page, url, timeout = 15_000) {
    await expect
        .poll(
            () =>
                page.evaluate(
                    (u) => {
                        const v = document.getElementById("videoPlayer");
                        const inp = document.getElementById("urlInput");
                        return inp?.value === u && !v?.classList.contains("hidden");
                    },
                    url
                ),
            { timeout }
        )
        .toBe(true);
}

/**
 * Collect outbound sync WebSocket frames on `page`.
 * Must be called BEFORE page.goto so the listener is registered for the WS
 * connection opened during bootstrap.
 * Returns a live array that is filled as frames arrive.
 */
function captureSyncFrames(page) {
    const frames = [];
    page.on("websocket", (socket) => {
        socket.on("framesent", ({ payload }) => {
            try {
                const msg = JSON.parse(payload);
                if (msg.type === "sync") frames.push(msg);
            } catch {
                // non-JSON frames (e.g. "join:…") — ignore
            }
        });
    });
    return frames;
}

// A test-only video URL — the browser will try (and fail) to load it, but the
// sync logic only cares about the URL string being relayed, not the video content.
const VIDEO_URL = "https://test.example.com/sample.mp4";

// Must be longer than APPLY_SYNC_GUARD_MS (600 ms) so the guard has cleared by
// the time we inject the next sync message in two-peer tests.
const SYNC_GUARD_CLEARANCE_MS = 800;

// ── two-peer load-sync tests ──────────────────────────────────────────────────

test.describe("video sync — load URL", () => {
    test("broadcaster loads URL, active peer sees video player appear", async ({ browser }) => {
        const id = roomId();
        const ctxA = await browser.newContext();
        const ctxB = await browser.newContext();
        const pageA = await ctxA.newPage();
        const pageB = await ctxB.newPage();

        try {
            await waitForBootstrap(pageA, id);
            await waitForBootstrap(pageB, id);
            // Wait until both sides have each other's cam-tile — confirms the WS
            // relay is fully operational between Peer A and Peer B.
            await waitForPeerConnected(pageA);
            await waitForPeerConnected(pageB);

            // Peer A loads a URL through the UI — the real user-facing path.
            await pageA.fill("#urlInput", VIDEO_URL);
            await pageA.click("#btnLoad");

            // Peer B should receive the "sync load" WS relay and call
            // applyRemoteSync({ action:"load", url }) — which fills urlInput
            // and shows #videoPlayer.
            await waitForVideoUrl(pageB, VIDEO_URL);
        } finally {
            await ctxA.close();
            await ctxB.close();
        }
    });

    test("late joiner receives current video URL via sendVideoStateTo", async ({ browser }) => {
        const id = roomId();
        const ctxA = await browser.newContext();
        const ctxB = await browser.newContext();
        const pageA = await ctxA.newPage();
        const pageB = await ctxB.newPage();

        try {
            await waitForBootstrap(pageA, id);

            // Peer A loads the URL while alone in the room.
            await pageA.fill("#urlInput", VIDEO_URL);
            await pageA.click("#btnLoad");

            // Wait until Peer A has recorded the URL before Peer B joins, so
            // sendVideoStateTo has a URL to relay.
            await waitForVideoUrl(pageA, VIDEO_URL, 5_000);

            // Peer B joins late.  ensurePeerState → sendVideoStateTo fires
            // immediately for "load" and after SYNC_SHARE_DELAY_MS for play/pause.
            await waitForBootstrap(pageB, id);
            await waitForPeerConnected(pageA);

            // Peer B must receive the video URL (generous timeout covers the
            // SYNC_SHARE_DELAY_MS = 1200 ms window inside sendVideoStateTo).
            await waitForVideoUrl(pageB, VIDEO_URL, 20_000);
        } finally {
            await ctxA.close();
            await ctxB.close();
        }
    });
});

// ── single-peer WS-capture tests ─────────────────────────────────────────────
// These tests exercise the *sending* side without needing a second peer or a
// playable video file.  They verify that the video event handlers emit the
// correct sync WebSocket frames.

test.describe("video sync — outbound sync messages", () => {
    test("clicking Load sends a sync load frame over WebSocket", async ({ page }) => {
        const id = roomId();
        const frames = captureSyncFrames(page);

        await waitForBootstrap(page, id);

        await page.fill("#urlInput", VIDEO_URL);
        await page.click("#btnLoad");

        await expect
            .poll(() => frames.some((f) => f.action === "load" && f.url === VIDEO_URL), {
                timeout: 5_000,
            })
            .toBe(true);
    });

    test("onpause handler sends a sync pause frame", async ({ page }) => {
        const id = roomId();
        const frames = captureSyncFrames(page);

        await waitForBootstrap(page, id);

        await page.fill("#urlInput", VIDEO_URL);
        await page.click("#btnLoad");

        // Wait for the load frame to confirm the handlers are wired up.
        await expect
            .poll(() => frames.some((f) => f.action === "load"), { timeout: 5_000 })
            .toBe(true);

        // Trigger the pause handler directly (simulates user pausing the video).
        await page.evaluate(() => document.getElementById("videoPlayer").onpause?.());

        await expect
            .poll(() => frames.some((f) => f.action === "pause"), { timeout: 5_000 })
            .toBe(true);
    });

    test("onplay handler sends a sync play frame", async ({ page }) => {
        const id = roomId();
        const frames = captureSyncFrames(page);

        await waitForBootstrap(page, id);

        await page.fill("#urlInput", VIDEO_URL);
        await page.click("#btnLoad");

        await expect
            .poll(() => frames.some((f) => f.action === "load"), { timeout: 5_000 })
            .toBe(true);

        await page.evaluate(() => document.getElementById("videoPlayer").onplay?.());

        await expect
            .poll(() => frames.some((f) => f.action === "play"), { timeout: 5_000 })
            .toBe(true);
    });

    test("onseeked handler sends a sync seek frame", async ({ page }) => {
        const id = roomId();
        const frames = captureSyncFrames(page);

        await waitForBootstrap(page, id);

        await page.fill("#urlInput", VIDEO_URL);
        await page.click("#btnLoad");

        await expect
            .poll(() => frames.some((f) => f.action === "load"), { timeout: 5_000 })
            .toBe(true);

        await page.evaluate(() => document.getElementById("videoPlayer").onseeked?.());

        await expect
            .poll(() => frames.some((f) => f.action === "seek"), { timeout: 5_000 })
            .toBe(true);
    });

    test("regression: pause is NOT dropped immediately after seek (throttle bug)", async ({
        page,
    }) => {
        /**
         * Before the fix, SYNC_THROTTLE_MS (500 ms) was applied to ALL three
         * event handlers — play, pause, and seeked alike.  Calling onseeked()
         * updated lastSyncSent to Date.now(), which caused a pause fired within
         * the next 500 ms to be silently discarded.
         *
         * After the fix, only onseeked retains a throttle; onpause and onplay
         * always send their frame immediately.
         */
        const id = roomId();
        const frames = captureSyncFrames(page);

        await waitForBootstrap(page, id);

        await page.fill("#urlInput", VIDEO_URL);
        await page.click("#btnLoad");

        await expect
            .poll(() => frames.some((f) => f.action === "load"), { timeout: 5_000 })
            .toBe(true);

        // Fire seek then pause in the same microtask — far inside the 500 ms window
        // that the old throttle would have blocked.
        await page.evaluate(() => {
            const v = document.getElementById("videoPlayer");
            v.onseeked?.(); // updates lastSyncSent → now
            v.onpause?.();  // must NOT be throttled
        });

        await expect
            .poll(
                () =>
                    frames.some((f) => f.action === "seek") &&
                    frames.some((f) => f.action === "pause"),
                { timeout: 5_000 }
            )
            .toBe(true);
    });

    test("regression: play is NOT dropped immediately after seek (throttle bug)", async ({
        page,
    }) => {
        const id = roomId();
        const frames = captureSyncFrames(page);

        await waitForBootstrap(page, id);

        await page.fill("#urlInput", VIDEO_URL);
        await page.click("#btnLoad");

        await expect
            .poll(() => frames.some((f) => f.action === "load"), { timeout: 5_000 })
            .toBe(true);

        await page.evaluate(() => {
            const v = document.getElementById("videoPlayer");
            v.onseeked?.(); // updates lastSyncSent → now
            v.onplay?.();   // must NOT be throttled
        });

        await expect
            .poll(
                () =>
                    frames.some((f) => f.action === "seek") &&
                    frames.some((f) => f.action === "play"),
                { timeout: 5_000 }
            )
            .toBe(true);
    });
});

// ── applyRemoteSync tests ─────────────────────────────────────────────────────
// These tests call applyRemoteSync directly to verify the receiving-side state
// machine, isolated from network and video decoding concerns.

test.describe("video sync — applyRemoteSync", () => {
    test("load action fills URL input and shows videoPlayer", async ({ page }) => {
        const id = roomId();
        await waitForBootstrap(page, id);

        await page.evaluate((url) => applyRemoteSync({ action: "load", url }), VIDEO_URL);

        await expect(page.locator("#urlInput")).toHaveValue(VIDEO_URL);
        await expect(page.locator("#videoPlayer")).not.toHaveClass(/hidden/);
    });

    test("load action with unsafe URL is rejected (videoPlayer stays hidden)", async ({ page }) => {
        const id = roomId();
        await waitForBootstrap(page, id);

        await page.evaluate(() =>
            applyRemoteSync({ action: "load", url: "javascript:alert(1)" })
        );

        await expect(page.locator("#videoPlayer")).toHaveClass(/hidden/);
    });

    test("pause action seeks videoPlayer to remote time", async ({ browser }) => {
        /**
         * We use two peers so that applyRemoteSync on Peer B runs AFTER the
         * "load" sync has set currentVideoType = "html5".  We then inject a
         * targeted pause sync directly via wsSend on Peer A and wait for Peer B's
         * #videoPlayer to reflect the requested time.
         *
         * Note: setting video.currentTime requires the element to have been
         * through at least one loadHtml5Video call (sets currentVideoType) so
         * applyRemoteSync reaches the html5 branch.  The video src need not be
         * playable for currentTime to be updated.
         */
        const id = roomId();
        const ctxA = await browser.newContext();
        const ctxB = await browser.newContext();
        const pageA = await ctxA.newPage();
        const pageB = await ctxB.newPage();

        try {
            await waitForBootstrap(pageA, id);
            await waitForBootstrap(pageB, id);
            await waitForPeerConnected(pageA);
            await waitForPeerConnected(pageB);

            // Load the URL on both peers first so currentVideoType = "html5".
            await pageA.fill("#urlInput", VIDEO_URL);
            await pageA.click("#btnLoad");
            await waitForVideoUrl(pageB, VIDEO_URL);
            // Allow isApplyingSync guard (APPLY_SYNC_GUARD_MS = 600 ms) to clear.
            await pageB.waitForTimeout(SYNC_GUARD_CLEARANCE_MS);

            // Peer A broadcasts a pause with time=30.
            await pageA.evaluate(() => wsSend({ type: "sync", action: "pause", time: 30 }));

            // Peer B should apply the seek portion: |0 − 30| > SYNC_TOLERANCE_S (2).
            await expect
                .poll(
                    () => pageB.evaluate(() => document.getElementById("videoPlayer")?.currentTime),
                    { timeout: 8_000 }
                )
                .toBeCloseTo(30, 0);
        } finally {
            await ctxA.close();
            await ctxB.close();
        }
    });

    test("seek action updates videoPlayer currentTime on peer", async ({ browser }) => {
        const id = roomId();
        const ctxA = await browser.newContext();
        const ctxB = await browser.newContext();
        const pageA = await ctxA.newPage();
        const pageB = await ctxB.newPage();

        try {
            await waitForBootstrap(pageA, id);
            await waitForBootstrap(pageB, id);
            await waitForPeerConnected(pageA);
            await waitForPeerConnected(pageB);

            await pageA.fill("#urlInput", VIDEO_URL);
            await pageA.click("#btnLoad");
            await waitForVideoUrl(pageB, VIDEO_URL);
            await pageB.waitForTimeout(SYNC_GUARD_CLEARANCE_MS);

            await pageA.evaluate(() => wsSend({ type: "sync", action: "seek", time: 45 }));

            await expect
                .poll(
                    () => pageB.evaluate(() => document.getElementById("videoPlayer")?.currentTime),
                    { timeout: 8_000 }
                )
                .toBeCloseTo(45, 0);
        } finally {
            await ctxA.close();
            await ctxB.close();
        }
    });
});
