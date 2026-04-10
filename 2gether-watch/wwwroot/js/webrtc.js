// ──────────────────────────────────────────────────────────────
//  2gether Watch — WebRTC + Chat + Video Sync Engine
// ──────────────────────────────────────────────────────────────

// ── Config ────────────────────────────────────────────────────
const USERNAME = localStorage.getItem("2gw_username") || "Viewer";
const BTN_BASE =
    "flex items-center gap-1.5 px-3 sm:px-4 py-2 rounded-full text-sm font-medium " +
    "transition-all active:scale-95 shadow-sm ring-1";

// ── State ─────────────────────────────────────────────────────
let ws, pc;
let localStream  = null;   // camera + mic stream
let screenStream = null;   // screen share stream
let micEnabled   = true;   // audio mute state

// Maps remote stream IDs → their kind ("camera" | "screen")
const streamKindMap = {};

// WebRTC negotiation lock
let makingOffer = false;

// ── Video player state ────────────────────────────────────────
let ytPlayer       = null;    // YouTube IFrame API player instance
let ytReady        = false;   // YT API has loaded
let currentVideoType = null;  // "youtube" | "html5" | "screen" | null
let currentVideoUrl  = "";
let isApplyingSync   = false; // prevents sync-event echo loop
let lastSyncSent     = 0;     // throttle outgoing sync messages

// ── DOM helper ────────────────────────────────────────────────
const $ = (id) => document.getElementById(id);

// ── Status indicator ─────────────────────────────────────────
function updateStatus(text) {
    const el = $("statusText");
    if (el) el.textContent = text;

    const dot = $("statusDot");
    if (!dot) return;
    dot.classList.remove("bg-amber-400", "bg-green-400", "bg-red-400");
    const lc = text.toLowerCase();
    if (lc.includes("connected") || lc.includes("🎉")) {
        dot.classList.add("bg-green-400");
    } else if (lc.includes("left") || lc.includes("error") || lc.includes("failed") || lc.includes("disconnect")) {
        dot.classList.add("bg-red-400");
    } else {
        dot.classList.add("bg-amber-400");
    }
}

// ── WebSocket ─────────────────────────────────────────────────
function initWS() {
    const proto = location.protocol === "https:" ? "wss" : "ws";
    ws = new WebSocket(`${proto}://${location.host}/ws`);
    ws.onopen    = () => { ws.send("join:" + ROOM_ID); updateStatus("Waiting for others…"); };
    ws.onclose   = () => updateStatus("Disconnected — reload to reconnect.");
    ws.onerror   = () => updateStatus("Connection error — reload.");
    ws.onmessage = handleWsMessage;
}

function wsSend(data) {
    if (ws?.readyState === WebSocket.OPEN) {
        ws.send(typeof data === "string" ? data : JSON.stringify(data));
    }
}

async function handleWsMessage(event) {
    const raw = event.data;

    if (raw.startsWith("join:")) {
        updateStatus("Connected 🎉");
        wsSend({ type: "username", name: USERNAME });
        // Renegotiate if we have active streams so the new peer receives them
        if (localStream || screenStream) {
            sendStreamMap();
            await negotiate();
        }
        // Share current video state with the newly-joined peer
        sendVideoState();
        return;
    }

    if (raw.startsWith("leave:")) {
        updateStatus("The other person left.");
        clearRemoteMedia();
        return;
    }

    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    if (!msg?.type) return;

    switch (msg.type) {
        // ── WebRTC signaling ──────────────────────────────────
        case "offer":
            await handleOffer(msg);
            break;
        case "answer":
            if (pc.signalingState === "have-local-offer") {
                await pc.setRemoteDescription(msg);
            }
            break;
        case "candidate":
            if (msg.candidate) {
                try { await pc.addIceCandidate(msg.candidate); } catch { /* stale candidate */ }
            }
            break;

        // ── Stream metadata ───────────────────────────────────
        case "streammap":
            Object.assign(streamKindMap, msg.map);
            break;

        // ── Media events ──────────────────────────────────────
        case "camera-off":
            setCamSrc("remote", null);
            break;
        case "screen-off":
            clearRemoteScreen();
            break;

        // ── Presence ──────────────────────────────────────────
        case "username": {
            const el = $("remoteLabel");
            if (el) el.textContent = msg.name;
            break;
        }

        // ── Chat ──────────────────────────────────────────────
        case "chat":
            appendChatMessage(msg.name, msg.text, msg.ts, false);
            break;

        // ── Video sync ────────────────────────────────────────
        case "sync":
            applyRemoteSync(msg);
            break;
    }
}

// ── WebRTC ────────────────────────────────────────────────────
function initPC() {
    if (pc) {
        pc.onicecandidate          = null;
        pc.ontrack                 = null;
        pc.onnegotiationneeded     = null;
        pc.oniceconnectionstatechange = null;
        pc.close();
    }

    pc = new RTCPeerConnection({
        iceServers: [
            { urls: "stun:stun.l.google.com:19302" },
            { urls: "stun:stun1.l.google.com:19302" },
        ],
    });

    pc.onicecandidate = ({ candidate }) => {
        if (candidate) wsSend({ type: "candidate", candidate });
    };

    pc.ontrack = ({ streams }) => {
        const stream = streams?.[0];
        if (!stream) return;
        const kind = streamKindMap[stream.id];
        if (kind === "screen") {
            setRemoteScreen(stream);
        } else {
            setCamSrc("remote", stream);
        }
    };

    // onnegotiationneeded fires automatically when tracks are added/removed
    pc.onnegotiationneeded = () => negotiate();

    pc.oniceconnectionstatechange = () => {
        const s = pc.iceConnectionState;
        if (s === "connected" || s === "completed") updateStatus("Connected 🎉");
        else if (s === "disconnected")              updateStatus("Connection lost…");
        else if (s === "failed")                    updateStatus("Connection failed — reload.");
    };
}

// Creates and sends an SDP offer (with negotiation-lock guard)
async function negotiate() {
    if (makingOffer || pc.signalingState !== "stable") return;
    makingOffer = true;
    try {
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        wsSend(pc.localDescription);
    } catch (e) {
        console.error("negotiate:", e);
    } finally {
        makingOffer = false;
    }
}

// Handles an incoming offer; rolls back our own offer on collision
async function handleOffer(offer) {
    if (pc.signalingState === "have-local-offer") {
        // Glare / collision — roll back our pending offer
        await pc.setLocalDescription({ type: "rollback" });
        makingOffer = false;
    }
    await pc.setRemoteDescription(offer);
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    wsSend(pc.localDescription);
}

// Sends a streamId→kind map so the remote peer can classify incoming tracks
function sendStreamMap() {
    const map = {};
    if (localStream)  map[localStream.id]  = "camera";
    if (screenStream) map[screenStream.id] = "screen";
    wsSend({ type: "streammap", map });
}

function clearRemoteMedia() {
    setCamSrc("remote", null);
    clearRemoteScreen();
}

// ── Camera helpers ────────────────────────────────────────────
function setCamSrc(side, stream) {
    const vid = $(side === "local" ? "localCam" : "remoteCam");
    const ph  = $(side === "local" ? "localCamPlaceholder" : "remoteCamPlaceholder");
    if (vid) vid.srcObject = stream;
    if (ph)  ph.classList.toggle("hidden", !!stream);
}

// ── Camera + Mic ──────────────────────────────────────────────
async function toggleCamera() {
    if (localStream) {
        localStream.getTracks().forEach(t => t.stop());
        pc.getSenders()
            .filter(s => localStream.getTracks().includes(s.track))
            .forEach(s => pc.removeTrack(s));
        wsSend({ type: "camera-off" });
        setCamSrc("local", null);
        setBtn("btnCam", "🎥", "Camera", "bg-sky-700 hover:bg-sky-600 ring-sky-600/30");
        localStream = null;
        micEnabled  = true;
        updateMicButton();
        return;
    }

    try {
        localStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
        setCamSrc("local", localStream);
        // Apply current mic state
        localStream.getAudioTracks().forEach(t => (t.enabled = micEnabled));
        localStream.getTracks().forEach(t => pc.addTrack(t, localStream));
        sendStreamMap();
        await negotiate();
        setBtn("btnCam", "🎥", "Stop Cam", "bg-sky-600 hover:bg-sky-500 ring-sky-500/30");
        updateMicButton();
    } catch (e) {
        alert("Could not access camera/mic: " + (e.message ?? e));
    }
}

function toggleMic() {
    if (!localStream) return;
    micEnabled = !micEnabled;
    localStream.getAudioTracks().forEach(t => (t.enabled = micEnabled));
    updateMicButton();
}

function updateMicButton() {
    if (micEnabled || !localStream) {
        setBtn("btnMic", "🎤", "Mic", "bg-slate-700 hover:bg-slate-600 ring-slate-600/30");
    } else {
        setBtn("btnMic", "🔇", "Unmute", "bg-red-700 hover:bg-red-600 ring-red-600/30");
    }
}

// ── Screen Share ──────────────────────────────────────────────
async function toggleScreenShare() {
    if (screenStream) { stopScreenShare(); return; }
    try {
        screenStream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
        screenStream.getTracks().forEach(t => pc.addTrack(t, screenStream));
        // Auto-stop when user ends share from browser UI
        screenStream.getVideoTracks()[0]?.addEventListener("ended", stopScreenShare);
        sendStreamMap();
        await negotiate();
        setBtn("btnShare", "🖥️", "Stop Share", "bg-violet-600 hover:bg-violet-500 ring-violet-500/30");
    } catch (e) {
        if (e.name !== "NotAllowedError") console.error("Screen share:", e);
    }
}

function stopScreenShare() {
    if (!screenStream) return;
    screenStream.getTracks().forEach(t => t.stop());
    pc.getSenders()
        .filter(s => screenStream.getTracks().includes(s.track))
        .forEach(s => pc.removeTrack(s));
    wsSend({ type: "screen-off" });
    screenStream = null;
    setBtn("btnShare", "🖥️", "Screen", "bg-violet-700 hover:bg-violet-600 ring-violet-600/30");
}

// ── Remote screen display ─────────────────────────────────────
function setRemoteScreen(stream) {
    const v = $("remoteScreen");
    v.srcObject = stream;
    v.classList.remove("hidden");
    $("stagePlaceholder").classList.add("hidden");
    $("ytPlayerContainer").classList.add("hidden");
    $("videoPlayer").classList.add("hidden");
    currentVideoType = "screen";
}

function clearRemoteScreen() {
    const v = $("remoteScreen");
    v.srcObject = null;
    v.classList.add("hidden");
    if (currentVideoType === "screen") {
        currentVideoType = null;
        restoreVideoSource();
    }
}

function restoreVideoSource() {
    if (!currentVideoUrl) {
        $("stagePlaceholder").classList.remove("hidden");
        return;
    }
    if (getYouTubeId(currentVideoUrl)) {
        $("ytPlayerContainer").classList.remove("hidden");
        currentVideoType = "youtube";
    } else {
        $("videoPlayer").classList.remove("hidden");
        currentVideoType = "html5";
    }
    $("stagePlaceholder").classList.add("hidden");
}

// ── Video Sync ────────────────────────────────────────────────
function getYouTubeId(url) {
    const m = url.match(
        /(?:youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/embed\/)([A-Za-z0-9_-]{11})/
    );
    return m?.[1] ?? null;
}

// Called when the local user enters a URL and hits Load
function loadVideoUrl(url) {
    url = url.trim();
    if (!url) return;
    currentVideoUrl = url;
    const ytId = getYouTubeId(url);
    if (ytId) loadYouTube(ytId);
    else      loadHtml5Video(url);
    // Broadcast the URL to all peers so they load the same content
    wsSend({ type: "sync", action: "load", url });
}

function loadYouTube(videoId) {
    $("videoPlayer").classList.add("hidden");
    if (!$("remoteScreen").srcObject) $("remoteScreen").classList.add("hidden");
    $("stagePlaceholder").classList.add("hidden");
    $("ytPlayerContainer").classList.remove("hidden");
    currentVideoType = "youtube";

    if (!ytReady) {
        window.__pendingYtVideoId = videoId;
        return;
    }
    if (ytPlayer) {
        ytPlayer.loadVideoById(videoId);
    } else {
        createYTPlayer(videoId);
    }
}

function createYTPlayer(videoId) {
    if (ytPlayer) { ytPlayer.destroy(); ytPlayer = null; }
    $("ytPlayerContainer").innerHTML = '<div id="ytPlayerEl"></div>';
    ytPlayer = new YT.Player("ytPlayerEl", {
        videoId,
        width: "100%",
        height: "100%",
        playerVars: { autoplay: 1, rel: 0, modestbranding: 1 },
        events: { onStateChange: onYtStateChange },
    });
}

function onYtStateChange({ data }) {
    if (isApplyingSync) return;
    const now = Date.now();
    if (now - lastSyncSent < 500) return; // throttle
    lastSyncSent = now;
    const t = ytPlayer?.getCurrentTime?.() ?? 0;
    if (data === YT.PlayerState.PLAYING) wsSend({ type: "sync", action: "play",  time: t });
    else if (data === YT.PlayerState.PAUSED)  wsSend({ type: "sync", action: "pause", time: t });
}

function loadHtml5Video(url) {
    $("ytPlayerContainer").classList.add("hidden");
    if (!$("remoteScreen").srcObject) $("remoteScreen").classList.add("hidden");
    $("stagePlaceholder").classList.add("hidden");
    const v = $("videoPlayer");
    v.src = url;
    v.classList.remove("hidden");
    v.play().catch(() => {});
    currentVideoType = "html5";

    const maybeSend = (action) => {
        if (isApplyingSync) return;
        const now = Date.now();
        if (now - lastSyncSent < 500) return;
        lastSyncSent = now;
        wsSend({ type: "sync", action, time: v.currentTime });
    };

    v.onplay   = () => maybeSend("play");
    v.onpause  = () => maybeSend("pause");
    v.onseeked = () => {
        if (isApplyingSync) return;
        const now = Date.now();
        if (now - lastSyncSent < 1000) return;
        lastSyncSent = now;
        wsSend({ type: "sync", action: "seek", time: v.currentTime });
    };
}

function applyRemoteSync(msg) {
    if (msg.action === "load") {
        // Set the URL input, then load without re-broadcasting
        $("urlInput").value = msg.url;
        isApplyingSync = true;
        currentVideoUrl = msg.url;
        const ytId = getYouTubeId(msg.url);
        if (ytId) loadYouTube(ytId);
        else      loadHtml5Video(msg.url);
        setTimeout(() => { isApplyingSync = false; }, 500);
        return;
    }

    isApplyingSync = true;
    try {
        if (currentVideoType === "youtube" && ytPlayer) {
            const cur = ytPlayer.getCurrentTime?.() ?? 0;
            if (msg.action === "play") {
                if (Math.abs(cur - msg.time) > 2) ytPlayer.seekTo(msg.time, true);
                ytPlayer.playVideo();
            } else if (msg.action === "pause") {
                if (Math.abs(cur - msg.time) > 2) ytPlayer.seekTo(msg.time, true);
                ytPlayer.pauseVideo();
            } else if (msg.action === "seek") {
                ytPlayer.seekTo(msg.time, true);
            }
        } else if (currentVideoType === "html5") {
            const v = $("videoPlayer");
            if (msg.action === "play") {
                if (Math.abs(v.currentTime - msg.time) > 2) v.currentTime = msg.time;
                v.play();
            } else if (msg.action === "pause") {
                if (Math.abs(v.currentTime - msg.time) > 2) v.currentTime = msg.time;
                v.pause();
            } else if (msg.action === "seek") {
                v.currentTime = msg.time;
            }
        }
    } finally {
        setTimeout(() => { isApplyingSync = false; }, 300);
    }
}

// Called when a new peer joins — sends them the current video state
function sendVideoState() {
    if (!currentVideoUrl) return;
    wsSend({ type: "sync", action: "load", url: currentVideoUrl });
    // Send play/pause + time after a brief delay to let the peer load the player
    setTimeout(() => {
        if (currentVideoType === "youtube" && ytPlayer && ytReady) {
            const t      = ytPlayer.getCurrentTime?.() ?? 0;
            const paused = ytPlayer.getPlayerState?.() !== YT.PlayerState.PLAYING;
            wsSend({ type: "sync", action: paused ? "pause" : "play", time: t });
        } else if (currentVideoType === "html5") {
            const v = $("videoPlayer");
            wsSend({ type: "sync", action: v.paused ? "pause" : "play", time: v.currentTime });
        }
    }, 1000);
}

// ── Chat ──────────────────────────────────────────────────────
function sendChat(inputEl) {
    const text = inputEl.value.trim();
    if (!text) return;
    inputEl.value = "";
    const msg = { type: "chat", name: USERNAME, text, ts: Date.now() };
    wsSend(msg);
    appendChatMessage(msg.name, msg.text, msg.ts, true);
}

function appendChatMessage(name, text, ts, isSelf) {
    const item = buildChatItem(name, text, ts, isSelf);
    // Write to both desktop and mobile chat containers
    for (const id of ["chatMessages", "chatMessagesMobile"]) {
        const el = $(id);
        if (!el) continue;
        el.appendChild(item.cloneNode(true));
        el.scrollTop = el.scrollHeight;
    }
    // Show unread badge on mobile when the drawer is closed
    if (!isSelf) {
        const badge  = $("chatBadge");
        const drawer = $("chatDrawer");
        if (badge && drawer?.classList.contains("translate-y-full")) {
            badge.classList.remove("hidden");
        }
    }
}

function buildChatItem(name, text, ts, isSelf) {
    const time = new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    const div  = document.createElement("div");
    div.className = `flex flex-col ${isSelf ? "items-end" : "items-start"} gap-0.5`;
    div.innerHTML =
        `<span class="text-[10px] text-slate-500">${escapeHtml(name)} · ${time}</span>` +
        `<div class="max-w-[90%] px-3 py-1.5 rounded-xl text-sm break-words ` +
        (isSelf ? `bg-violet-700 text-white rounded-br-sm">`
                : `bg-slate-800 text-slate-200 rounded-bl-sm">`) +
        `${escapeHtml(text)}</div>`;
    return div;
}

function escapeHtml(s) {
    return s
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#39;");
}

// ── UI Helpers ────────────────────────────────────────────────
function setBtn(id, icon, label, colorClasses) {
    const btn = $(id);
    if (!btn) return;
    btn.className = `${BTN_BASE} ${colorClasses}`;
    btn.innerHTML = `${icon} <span class="hidden sm:inline">${label}</span>`;
}

function fallbackCopy(text) {
    const ta = Object.assign(document.createElement("textarea"), { value: text });
    ta.style.cssText = "position:fixed;opacity:0";
    document.body.appendChild(ta);
    ta.select();
    try { return document.execCommand("copy"); } finally { document.body.removeChild(ta); }
}

// ── YouTube IFrame API callback ───────────────────────────────
window.onYouTubeIframeAPIReady = function () {
    ytReady = true;
    if (window.__pendingYtVideoId) {
        createYTPlayer(window.__pendingYtVideoId);
        window.__pendingYtVideoId = null;
    }
};

// ── Init ─────────────────────────────────────────────────────
document.addEventListener("DOMContentLoaded", () => {
    initWS();
    initPC();

    // Set displayed name for local cam
    const localLabel = $("localLabel");
    if (localLabel) localLabel.textContent = USERNAME;

    // Initialise placeholders
    setCamSrc("local",  null);
    setCamSrc("remote", null);

    // ── Controls ─────────────────────────────────────────────
    $("btnMic").addEventListener("click",   toggleMic);
    $("btnCam").addEventListener("click",   toggleCamera);
    $("btnShare").addEventListener("click", toggleScreenShare);

    // ── Video URL ─────────────────────────────────────────────
    $("btnLoad").addEventListener("click", () => loadVideoUrl($("urlInput").value));
    $("urlInput").addEventListener("keydown", (e) => {
        if (e.key === "Enter") loadVideoUrl($("urlInput").value);
    });

    // ── Chat (desktop) ────────────────────────────────────────
    $("btnSendChat").addEventListener("click", () => sendChat($("chatInput")));
    $("chatInput").addEventListener("keydown", (e) => {
        if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); sendChat($("chatInput")); }
    });

    // ── Chat (mobile drawer) ──────────────────────────────────
    $("btnSendChatMobile").addEventListener("click", () => sendChat($("chatInputMobile")));
    $("chatInputMobile").addEventListener("keydown", (e) => {
        if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); sendChat($("chatInputMobile")); }
    });

    const chatDrawer = $("chatDrawer");
    $("btnChat").addEventListener("click", () => {
        const isOpen = !chatDrawer.classList.contains("translate-y-full");
        chatDrawer.classList.toggle("translate-y-full", isOpen);
        if (!isOpen) $("chatBadge").classList.add("hidden");
    });
    $("btnCloseChat").addEventListener("click", () => {
        chatDrawer.classList.add("translate-y-full");
    });

    // ── Copy room link ────────────────────────────────────────
    $("btnCopyLink").addEventListener("click", () => {
        const btn   = $("btnCopyLink");
        const reset = () => setTimeout(() => (btn.textContent = "📋"), 1600);
        const url   = location.href;
        if (navigator.clipboard?.writeText) {
            navigator.clipboard.writeText(url)
                .then(() => { btn.textContent = "✅"; reset(); })
                .catch(() => { btn.textContent = fallbackCopy(url) ? "✅" : "❌"; reset(); });
        } else {
            btn.textContent = fallbackCopy(url) ? "✅" : "❌";
            reset();
        }
    });
});

