# 2gether Watch 🎬

> Watch videos together, in sync, from anywhere — no account required.

**Live at [2gether-watch.lunavex.com](https://2gether-watch.lunavex.com)**

---

## What is it?

2gether Watch is a lightweight, privacy-first watch-party app. You and your friends share a room link, paste a video URL, and watch in perfect sync. Audio/video calls, live chat, and screen sharing are all included — powered entirely by peer-to-peer WebRTC so media never touches the server.

---

## Features

| Feature | Details |
|---|---|
| 🎬 **Synced video** | YouTube and direct HTTP/HTTPS video URLs stay in sync across all viewers |
| 💬 **Live chat** | Real-time text chat inside every room |
| 🎤 **Audio/video calls** | Optional webcam & microphone support |
| 🖥️ **Screen sharing** | Share your screen with everyone in the room |
| 🔒 **Private rooms** | Rooms are identified by a random ID — share only with people you trust |
| 👥 **Up to 10 viewers** | Full-mesh WebRTC topology supports up to 10 participants |
| 🚫 **No sign-up** | No accounts, no emails, no tracking |

---

## How to use it

### Hosted version

1. Go to **[2gether-watch.lunavex.com](https://2gether-watch.lunavex.com)**
2. Enter a display name (optional — defaults to "Viewer")
3. Click **✨ Create a New Room** — or paste a room ID someone sent you and click **Join →**
4. Share the URL in your browser's address bar with your friends
5. Paste a YouTube link or direct video URL into the bar at the top of the room and click **▶ Load**
6. Use the footer controls to toggle your microphone 🎤, camera 📷, and screen share 🖥️

### Room controls

| Button | Action |
|---|---|
| **▶ Load** | Load a YouTube or direct video URL for everyone |
| **📋** (header) | Copy the room invite link to your clipboard |
| **🎤 Mic / 🔇 Unmute** | Toggle your microphone |
| **📷 Camera / Stop Cam** | Toggle your webcam |
| **🖥️ Screen / Stop Share** | Toggle screen sharing |
| **💬** (mobile) | Open/close the chat drawer |
| **🚪 Leave** | Return to the home page |

### Supported video sources

- **YouTube** — paste any `youtube.com/watch?v=…`, `youtu.be/…`, or `youtube.com/embed/…` URL
- **Direct video** — any publicly accessible `http://` or `https://` video file (MP4, WebM, etc.)

---

## Self-hosting

See **[docs/SELF-HOSTING.md](docs/SELF-HOSTING.md)** for full instructions to run 2gether Watch on your own server using Docker Compose or by building from source.

---

## Architecture

```
Browser A ──WebSocket──▶ ASP.NET Core server ◀──WebSocket── Browser B
              (signaling only — SDP, ICE candidates)
                         │
Browser A ◀──────────── WebRTC P2P ──────────────▶ Browser B
          (audio, video, screen — never via server)
```

- **Backend**: ASP.NET Core 9 (`RoomManager.cs`) — accepts WebSocket connections, assigns peer IDs, relays JSON signaling messages, enforces room capacity
- **Frontend**: Vanilla JS + [Alpine.js](https://alpinejs.dev/) + [Tailwind CSS](https://tailwindcss.com/) (CDN) — handles WebRTC negotiation, video sync, chat, and media controls
- **ICE**: Public Google STUN servers (`stun.l.google.com`) — no TURN server by default
- **Deployment**: Docker image served behind a Traefik reverse proxy with Let's Encrypt TLS

---

## Security

See **[docs/SECURITY.md](docs/SECURITY.md)** for a full write-up of the security model and known considerations.

---

## Tech stack

| Layer | Technology |
|---|---|
| Server | [ASP.NET Core 9](https://learn.microsoft.com/aspnet/core) |
| Language | C# 13 / .NET 9 |
| Frontend framework | [Alpine.js 3](https://alpinejs.dev/) |
| Styling | [Tailwind CSS](https://tailwindcss.com/) (CDN) |
| Real-time comms | WebRTC (`RTCPeerConnection`, `getUserMedia`, `getDisplayMedia`) |
| Signaling transport | WebSockets (built-in ASP.NET Core middleware) |
| Container | Docker + [Traefik](https://traefik.io/) |

---

## Development

**Prerequisites**: [.NET 9 SDK](https://dotnet.microsoft.com/download)

```bash
# Clone the repo
git clone https://github.com/Aerys-cmd/2gether-watch.git
cd 2gether-watch

# Run the app
dotnet run --project 2gether-watch/2gether-watch.csproj

# Run tests
dotnet test 2gether-watch.Tests/2gether-watch.Tests.csproj
```

The app will be available at `https://localhost:7120` / `http://localhost:5021` (as configured in `Properties/launchSettings.json`).

> **Note**: WebRTC camera/microphone access requires HTTPS. For local development the dev certificate is enough.

---

## Contributing

Pull requests are welcome! Please open an issue first for significant changes.

---

## License

MIT — see [LICENSE](LICENSE).
