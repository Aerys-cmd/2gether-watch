const { test, expect } = require("@playwright/test");

function roomId() {
  return `e2e-real-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

async function waitForBootstrap(page, id) {
  await page.goto(`/room/${id}`);
  await expect(page.locator("header")).toBeVisible();

  // Real-flow smoke test: do not stub CDN scripts; ensure runtime bootstraps naturally.
  await expect
    .poll(() => page.evaluate(() => !!window.rtcActions?.toggleCamera), { timeout: 20_000 })
    .toBe(true);
}

async function expectRemoteLiveVideo(page, timeout = 20_000) {
  await expect
    .poll(
      () =>
        page.evaluate(() => {
          const videos = [...document.querySelectorAll("#camGrid video[data-peer]")];
          return videos.some((v) => {
            const s = v.srcObject;
            return !!(s && s.getVideoTracks && s.getVideoTracks().some((t) => t.readyState === "live"));
          });
        }),
      { timeout }
    )
    .toBe(true);
}

async function expectRemoteScreenLive(page, timeout = 20_000) {
  await expect
    .poll(
      () =>
        page.evaluate(() => {
          const v = document.getElementById("remoteScreen");
          if (!v || v.classList.contains("hidden")) return false;
          const s = v.srcObject;
          return !!(s && s.getVideoTracks && s.getVideoTracks().some((t) => t.readyState === "live"));
        }),
      { timeout }
    )
    .toBe(true);
}

test("@real-live joiner sees remote camera without enabling own camera", async ({ browser }) => {
  const id = roomId();

  const ctxA = await browser.newContext({ permissions: ["camera", "microphone"] });
  const ctxB = await browser.newContext();
  const pageA = await ctxA.newPage();
  const pageB = await ctxB.newPage();

  await waitForBootstrap(pageA, id);

  await pageA.evaluate(() => window.rtcActions.toggleCamera());

  await expect
    .poll(
      () =>
        pageA.evaluate(() => {
          const local = document.getElementById("localCam");
          const s = local?.srcObject;
          return !!(s && s.getVideoTracks && s.getVideoTracks().length > 0);
        }),
      { timeout: 20_000 }
    )
    .toBe(true);

  // Real usage: joiner arrives later after first peer already started camera.
  await pageA.waitForTimeout(5_000);
  await waitForBootstrap(pageB, id);

  await expectRemoteLiveVideo(pageB);

  // Joiner should still not have started local camera.
  await expect
    .poll(() =>
      pageB.evaluate(() => {
        const local = document.getElementById("localCam");
        const s = local?.srcObject;
        return !(s && s.getVideoTracks && s.getVideoTracks().length > 0);
      })
    )
    .toBe(true);

  await ctxA.close();
  await ctxB.close();
});

test("@real-live remote tile hides placeholder once live video arrives", async ({ browser }) => {
  const id = roomId();

  const ctxA = await browser.newContext({ permissions: ["camera", "microphone"] });
  const ctxB = await browser.newContext();
  const pageA = await ctxA.newPage();
  const pageB = await ctxB.newPage();

  await waitForBootstrap(pageA, id);
  await pageA.evaluate(() => window.rtcActions.toggleCamera());
  await pageA.waitForTimeout(5_000);
  await waitForBootstrap(pageB, id);

  await expect
    .poll(
      () =>
        pageB.evaluate(() => {
          const tiles = [...document.querySelectorAll("#camGrid > div[id^='cam-tile-']")];
          return tiles.some((tile) => {
            const video = tile.querySelector("video[data-peer]");
            const placeholder = tile.querySelector("div[id^='cam-ph-']");
            if (!video || !placeholder) return false;

            const s = video.srcObject;
            const hasLiveVideo = !!(
              s && s.getVideoTracks && s.getVideoTracks().some((t) => t.readyState === "live")
            );
            return hasLiveVideo && placeholder.classList.contains("hidden");
          });
        }),
      { timeout: 20_000 }
    )
    .toBe(true);

  await ctxA.close();
  await ctxB.close();
});

test("@real-live late joiner receives remote screen share", async ({ browser }) => {
  const id = roomId();

  const ctxA = await browser.newContext({ permissions: ["camera", "microphone"] });
  const ctxB = await browser.newContext();
  const pageA = await ctxA.newPage();
  const pageB = await ctxB.newPage();

  await waitForBootstrap(pageA, id);
  await pageA.evaluate(() => window.rtcActions.toggleScreenShare());
  await pageA.waitForTimeout(5_000);
  await waitForBootstrap(pageB, id);

  await expectRemoteScreenLive(pageB);

  await ctxA.close();
  await ctxB.close();
});


