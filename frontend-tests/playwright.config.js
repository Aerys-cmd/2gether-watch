const { defineConfig } = require("@playwright/test");

const launchArgs = [
  "--use-fake-device-for-media-stream",
  "--use-fake-ui-for-media-stream",
  "--autoplay-policy=no-user-gesture-required"
];

module.exports = defineConfig({
  testDir: "./e2e",
  timeout: 30_000,
  retries: 1,
  reporter: "list",
  use: {
    baseURL: "http://127.0.0.1:5188",
    headless: true,
    launchOptions: {
      args: launchArgs
    }
  },
  webServer: {
    command: "cd .. && ASPNETCORE_URLS=http://127.0.0.1:5188 dotnet run --no-launch-profile --project ./2gether-watch/2gether-watch.csproj",
    url: "http://127.0.0.1:5188/",
    timeout: 60_000,
    reuseExistingServer: false
  }
});

