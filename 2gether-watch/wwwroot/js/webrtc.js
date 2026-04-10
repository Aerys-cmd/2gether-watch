// ─────────────────────────────────────────────────────────────────────────────
//  2gether Watch — WebRTC mesh signaling + Chat + Video Sync
//  Supports up to 10 participants via a full-mesh RTCPeerConnection topology.
// ─────────────────────────────────────────────────────────────────────────────

// ── User identity ─────────────────────────────────────────────────────────────
const USERNAME = localStorage.getItem("2gw_username") || "Viewer";

// ── Constants ────────────────────────────────────────────────────────────────
const ICE_SERVERS = [
    { urls: "stun:stun.l.google.com:19302" },
    { urls: "stun:stun1.l.google.com:19302" },
];
const SYNC_THROTTLE_MS       = 500;
const SEEK_THROTTLE_MS       = 1000;
const SYNC_TOLERANCE_S       = 2;
// Time to suppress echo events after we apply a remote sync action.
// Must be longer than the browser's own seek/play event debounce (~300 ms).
const APPLY_SYNC_GUARD_MS    = 600;
// Delay before pushing our own video state to a newly joined peer, to give
// their player time to initialise before receiving play/pause commands.
const SYNC_SHARE_DELAY_MS    = 1200;
// Maximum number of unread chat notifications to display in the badge.
const MAX_UNREAD_BADGE_COUNT = 9;

// ── Alpine app state (populated in initWebRTC, read/written throughout) ──────
function getApp() { return window.alpineApp ?? null; }
function setState(patch) {
    const app = getApp();
    if (app) Object.assign(app, patch);
}

// ── WebSocket ────────────────────────────────────────────────────────────────
let ws = null;
let myPeerId = null;  // assigned by server

function wsConnect() {
    const proto = location.protocol === "https:" ? "wss" : "ws";
    ws = new WebSocket(`${proto}://${location.host}/ws`);

    ws.onopen  = () => {
        ws.send("join:" + ROOM_ID);
        setState({ status: "Joining room…", statusColor: "amber" });
    };
    ws.onclose = () => setState({ status: "Disconnected — reload to reconnect.", statusColor: "red" });
    ws.onerror = () => setState({ status: "Connection error — reload.", statusColor: "red" });
    ws.onmessage = onWsMessage;
}

function wsSend(data) {
    if (ws?.readyState === WebSocket.OPEN)
        ws.send(typeof data === "string" ? data : JSON.stringify(data));
}

async function onWsMessage(event) {
    const raw = event.data;

    // ── Control messages ───────────────────────────────────────────────────
    if (raw.startsWith("self:")) {
        myPeerId = raw.slice(5);
        return;
    }

    if (raw.startsWith("peers:")) {
        const idList = raw.slice(6);
        if (idList) {
            // We are the new joiner — offer to every existing peer
            for (const pid of idList.split(",")) {
                if (pid) await initiateConnection(pid);
            }
        }
        setState({ status: idList ? "Connected 🎉" : "Waiting for others…", statusColor: idList ? "green" : "amber" });
        return;
    }

    if (raw.startsWith("peer-joined:")) {
        const pid = raw.slice(12);
        // We are an existing peer — create a PC and wait for the new joiner's offer
        ensurePeerState(pid);
        setState({ status: "Connected 🎉", statusColor: "green", peerCount: peerStates.size });
        return;
    }

    if (raw.startsWith("peer-left:")) {
        const pid = raw.slice(10);
        closePeer(pid);
        setState({ status: peerStates.size > 0 ? "Connected 🎉" : "Waiting for others…",
                   statusColor: peerStates.size > 0 ? "green" : "amber",
                   peerCount: peerStates.size });
        return;
    }

    if (raw.startsWith("error:room-full")) {
        setState({ status: "Room is full (max 10 participants).", statusColor: "red" });
        showError("This room is full. Maximum 10 participants are allowed.");
        return;
    }

    // ── JSON relay messages ────────────────────────────────────────────────
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    if (!msg?.type || !msg?.from) return;

    const fromId = msg.from;
    const state  = ensurePeerState(fromId);

    switch (msg.type) {
        case "offer":
            await handleOffer(fromId, state, msg);
            break;
        case "answer":
            if (state.pc.signalingState === "have-local-offer")
                await state.pc.setRemoteDescription(msg).catch(e => console.warn("setRemoteDescription(answer):", e));
            break;
        case "candidate":
            if (msg.candidate)
                await state.pc.addIceCandidate(msg.candidate).catch(() => {});
            break;
        case "streammap":
            Object.assign(state.streamKindMap, msg.map);
            break;
        case "camera-off":
            removePeerCam(fromId);
            break;
        case "screen-off":
            clearRemoteScreen(fromId);
            break;
        case "username":
            state.username = msg.name;
            updatePeerLabel(fromId, msg.name);
            break;
        case "chat":
            appendChatMessage(msg.name, msg.text, msg.ts, false);
            break;
        case "sync":
            applyRemoteSync(msg);
            break;
    }
}

// ── Per-peer state ────────────────────────────────────────────────────────────
// Map<peerId, { pc, makingOffer, streamKindMap, username, camEl }>
const peerStates = new Map();

function ensurePeerState(peerId) {
    if (!peerStates.has(peerId)) {
        const state = {
            pc: createPC(peerId),
            makingOffer: false,
            streamKindMap: {},
            username: "Viewer",
            camEl: null,
        };
        peerStates.set(peerId, state);
        addPeerCamTile(peerId, state);
        // Share our identity and current video state with the new peer
        wsSend({ to: peerId, type: "username", name: USERNAME });
        sendVideoStateTo(peerId);
        return state;
    }
    return peerStates.get(peerId);
}

// ── RTCPeerConnection factory ─────────────────────────────────────────────────
function createPC(peerId) {
    const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });

    pc.onicecandidate = ({ candidate }) => {
        if (candidate) wsSend({ to: peerId, type: "candidate", candidate });
    };

    pc.ontrack = ({ track, streams }) => {
        const stream = streams?.[0];
        if (!stream) return;
        const state = peerStates.get(peerId);
        if (!state) return;
        const kind = state.streamKindMap[stream.id];
        if (kind === "screen") {
            setRemoteScreen(peerId, stream);
        } else {
            setPeerCamStream(peerId, stream);
        }
    };

    pc.oniceconnectionstatechange = () => {
        const s = pc.iceConnectionState;
        if (s === "failed") {
            // Try ICE restart
            pc.restartIce();
        }
        if (s === "disconnected" || s === "failed") {
            setState({ status: "Connection unstable…", statusColor: "amber" });
        }
    };

    pc.onsignalingstatechange = () => {
        if (pc.signalingState === "stable") {
            const state = peerStates.get(peerId);
            if (state) state.makingOffer = false;
        }
    };

    // Add existing local tracks to the new PC
    if (localCamStream) localCamStream.getTracks().forEach(t => pc.addTrack(t, localCamStream));
    if (localScreenStream) localScreenStream.getTracks().forEach(t => pc.addTrack(t, localScreenStream));

    return pc;
}

// Called by the new joiner to initiate a connection with an existing peer
async function initiateConnection(peerId) {
    const state = ensurePeerState(peerId);
    await sendOffer(peerId, state);
}

async function sendOffer(peerId, state) {
    if (state.makingOffer || state.pc.signalingState !== "stable") return;
    state.makingOffer = true;
    try {
        const offer = await state.pc.createOffer();
        await state.pc.setLocalDescription(offer);
        // Send streammap before the offer so the remote side can classify incoming tracks
        sendStreamMapTo(peerId);
        wsSend(Object.assign({ to: peerId }, state.pc.localDescription.toJSON()));
    } catch (e) {
        console.error("sendOffer:", e);
        state.makingOffer = false;
    }
}

async function handleOffer(fromId, state, offer) {
    if (state.pc.signalingState === "have-local-offer") {
        // Glare – we roll back ours; the peer with the lower ID wins
        if (myPeerId < fromId) {
            // We should be the offerer — roll back theirs by ignoring
            return;
        }
        await state.pc.setLocalDescription({ type: "rollback" }).catch(() => {});
        state.makingOffer = false;
    }
    try {
        await state.pc.setRemoteDescription({ type: "offer", sdp: offer.sdp });
        const answer = await state.pc.createAnswer();
        await state.pc.setLocalDescription(answer);
        wsSend(Object.assign({ to: fromId }, state.pc.localDescription.toJSON()));
    } catch (e) {
        console.error("handleOffer:", e);
    }
}

function closePeer(peerId) {
    const state = peerStates.get(peerId);
    if (!state) return;
    state.pc.onicecandidate = null;
    state.pc.ontrack = null;
    state.pc.oniceconnectionstatechange = null;
    state.pc.onsignalingstatechange = null;
    state.pc.close();
    removePeerCam(peerId);
    clearRemoteScreen(peerId);
    peerStates.delete(peerId);
}

function sendStreamMapTo(peerId) {
    const map = {};
    if (localCamStream)    map[localCamStream.id]    = "camera";
    if (localScreenStream) map[localScreenStream.id] = "screen";
    wsSend({ to: peerId, type: "streammap", map });
}

function broadcastStreamMap() {
    const map = {};
    if (localCamStream)    map[localCamStream.id]    = "camera";
    if (localScreenStream) map[localScreenStream.id] = "screen";
    wsSend({ type: "streammap", map });
}

// ── Local media ───────────────────────────────────────────────────────────────
let localCamStream    = null;
let localScreenStream = null;
let micEnabled        = true;

async function toggleCamera() {
    if (localCamStream) {
        // Stop camera
        localCamStream.getTracks().forEach(t => t.stop());
        removeLocalTracksFromPeers(localCamStream);
        wsSend({ type: "camera-off" });
        setLocalCamEl(null);
        localCamStream = null;
        micEnabled = true;
        setState({ camActive: false, micActive: true });
        return;
    }
    try {
        localCamStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
        localCamStream.getAudioTracks().forEach(t => (t.enabled = micEnabled));
        setLocalCamEl(localCamStream);
        addLocalTracksToPeers(localCamStream);
        broadcastStreamMap();
        setState({ camActive: true });
    } catch (e) {
        showError("Could not access camera/mic. Check browser permissions.");
        console.error("Camera error:", e);
    }
}

function toggleMic() {
    if (!localCamStream) return;
    micEnabled = !micEnabled;
    localCamStream.getAudioTracks().forEach(t => (t.enabled = micEnabled));
    setState({ micActive: micEnabled });
}

async function toggleScreenShare() {
    if (localScreenStream) { stopScreenShare(); return; }
    try {
        localScreenStream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
        localScreenStream.getVideoTracks()[0]?.addEventListener("ended", stopScreenShare);
        addLocalTracksToPeers(localScreenStream);
        broadcastStreamMap();
        setState({ screenActive: true });
    } catch (e) {
        if (e.name !== "NotAllowedError") console.error("Screen share:", e);
    }
}

function stopScreenShare() {
    if (!localScreenStream) return;
    localScreenStream.getTracks().forEach(t => t.stop());
    removeLocalTracksFromPeers(localScreenStream);
    wsSend({ type: "screen-off" });
    localScreenStream = null;
    setState({ screenActive: false });
}

function addLocalTracksToPeers(stream) {
    for (const [peerId, state] of peerStates) {
        stream.getTracks().forEach(t => {
            // Avoid adding duplicate senders
            if (!state.pc.getSenders().some(s => s.track === t))
                state.pc.addTrack(t, stream);
        });
    }
    // Trigger renegotiation by re-offering to all peers
    renegotiateAll();
}

function removeLocalTracksFromPeers(stream) {
    const trackSet = new Set(stream.getTracks());
    peerStates.forEach(({ pc }) => {
        pc.getSenders()
          .filter(s => s.track && trackSet.has(s.track))
          .forEach(s => pc.removeTrack(s));
    });
    renegotiateAll();
}

async function renegotiateAll() {
    for (const [peerId, state] of peerStates) {
        await sendOffer(peerId, state);
    }
}

// ── Remote camera tiles ───────────────────────────────────────────────────────
function addPeerCamTile(peerId, state) {
    const grid = document.getElementById("camGrid");
    if (!grid) return;

    const tile = document.createElement("div");
    tile.id = `cam-tile-${peerId}`;
    tile.className = "relative flex-none bg-slate-800 overflow-hidden cam-tile";

    const vid = document.createElement("video");
    vid.autoplay = true;
    vid.playsInline = true;
    vid.className = "absolute inset-0 w-full h-full object-cover";
    vid.setAttribute("data-peer", peerId);

    const ph = document.createElement("div");
    ph.id = `cam-ph-${peerId}`;
    ph.className = "cam-ph absolute inset-0";
    ph.setAttribute("aria-label", "Remote camera inactive");
    ph.textContent = "👤";

    const label = document.createElement("span");
    label.className = "vid-label";
    label.id = `cam-label-${peerId}`;
    label.textContent = state.username;

    tile.appendChild(vid);
    tile.appendChild(ph);
    tile.appendChild(label);

    // Insert before the local cam tile
    const localTile = document.getElementById("localCamTile");
    if (localTile) grid.insertBefore(tile, localTile);
    else grid.appendChild(tile);

    state.camEl = vid;
}

function removePeerCam(peerId) {
    const state = peerStates.get(peerId);
    if (state?.camEl) {
        state.camEl.srcObject = null;
        state.camEl = null;
    }
    document.getElementById(`cam-tile-${peerId}`)?.remove();
    const ph = document.getElementById(`cam-ph-${peerId}`);
    if (ph) ph.classList.remove("hidden");
}

function setPeerCamStream(peerId, stream) {
    const state = peerStates.get(peerId);
    if (!state) return;
    if (!state.camEl) addPeerCamTile(peerId, state);
    state.camEl.srcObject = stream;
    document.getElementById(`cam-ph-${peerId}`)?.classList.add("hidden");
}

function updatePeerLabel(peerId, name) {
    const el = document.getElementById(`cam-label-${peerId}`);
    if (el) el.textContent = name;
}

function setLocalCamEl(stream) {
    const vid = document.getElementById("localCam");
    const ph  = document.getElementById("localCamPh");
    if (vid) vid.srcObject = stream;
    if (ph) ph.classList.toggle("hidden", !!stream);
}

// ── Remote screen share ───────────────────────────────────────────────────────
// Track which peer is currently sharing their screen (only one at a time shown)
let activeScreenPeer = null;

function setRemoteScreen(peerId, stream) {
    activeScreenPeer = peerId;
    const v = document.getElementById("remoteScreen");
    if (!v) return;
    v.srcObject = stream;
    v.classList.remove("hidden");
    hideVideoOverlays(["stagePlaceholder", "ytPlayerContainer", "videoPlayer"]);
    setState({ videoType: "screen" });
}

function clearRemoteScreen(peerId) {
    if (activeScreenPeer !== peerId) return;
    activeScreenPeer = null;
    const v = document.getElementById("remoteScreen");
    if (v) { v.srcObject = null; v.classList.add("hidden"); }
    restoreLocalVideo();
}

function hideVideoOverlays(ids) {
    ids.forEach(id => document.getElementById(id)?.classList.add("hidden"));
}

function restoreLocalVideo() {
    if (currentVideoUrl) {
        const ytId = getYouTubeId(currentVideoUrl);
        if (ytId) {
            document.getElementById("ytPlayerContainer")?.classList.remove("hidden");
            document.getElementById("stagePlaceholder")?.classList.add("hidden");
            setState({ videoType: "youtube" });
        } else {
            document.getElementById("videoPlayer")?.classList.remove("hidden");
            document.getElementById("stagePlaceholder")?.classList.add("hidden");
            setState({ videoType: "html5" });
        }
    } else {
        document.getElementById("stagePlaceholder")?.classList.remove("hidden");
        setState({ videoType: null });
    }
}

// ── Video sync ────────────────────────────────────────────────────────────────
let ytPlayer         = null;
let ytReady          = false;
let currentVideoType = null;
let currentVideoUrl  = "";
let isApplyingSync   = false;
let lastSyncSent     = 0;

function getYouTubeId(url) {
    const m = url.match(
        /(?:youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/embed\/)([A-Za-z0-9_-]{11})/
    );
    return m?.[1] ?? null;
}

function isSafeMediaUrl(url) {
    try {
        const p = new URL(url);
        return p.protocol === "http:" || p.protocol === "https:";
    } catch { return false; }
}

function loadVideoUrl(url) {
    url = url.trim();
    if (!url) return;
    currentVideoUrl = url;
    const ytId = getYouTubeId(url);
    if (ytId) loadYouTube(ytId);
    else      loadHtml5Video(url);
    wsSend({ type: "sync", action: "load", url });
}

function loadYouTube(videoId) {
    // If a remote screen is active, don't hide it — load in background
    if (activeScreenPeer === null) {
        document.getElementById("videoPlayer")?.classList.add("hidden");
        document.getElementById("remoteScreen")?.classList.add("hidden");
        document.getElementById("stagePlaceholder")?.classList.add("hidden");
        document.getElementById("ytPlayerContainer")?.classList.remove("hidden");
    }
    currentVideoType = "youtube";
    setState({ videoType: "youtube" });

    if (!ytReady) {
        window.__pendingYtVideoId = videoId;
        const c = document.getElementById("ytPlayerContainer");
        if (c) c.innerHTML =
            '<div class="absolute inset-0 flex items-center justify-center text-slate-600 text-sm">Loading player…</div>';
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
    const c = document.getElementById("ytPlayerContainer");
    if (!c) return;
    c.innerHTML = '<div id="ytPlayerEl"></div>';
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
    if (now - lastSyncSent < SYNC_THROTTLE_MS) return;
    lastSyncSent = now;
    const t = ytPlayer?.getCurrentTime?.() ?? 0;
    if      (data === YT.PlayerState.PLAYING) wsSend({ type: "sync", action: "play",  time: t });
    else if (data === YT.PlayerState.PAUSED)  wsSend({ type: "sync", action: "pause", time: t });
}

function loadHtml5Video(url) {
    // Parse and validate – re-serialise via URL so we assign a trusted string, not raw input.
    let safeUrl;
    try {
        const p = new URL(url);
        if (p.protocol !== "http:" && p.protocol !== "https:") throw new Error("unsafe-protocol");
        safeUrl = p.href;
    } catch {
        showError("Only http:// and https:// video URLs are supported.");
        return;
    }
    if (activeScreenPeer === null) {
        document.getElementById("ytPlayerContainer")?.classList.add("hidden");
        document.getElementById("remoteScreen")?.classList.add("hidden");
        document.getElementById("stagePlaceholder")?.classList.add("hidden");
    }
    currentVideoType = "html5";
    setState({ videoType: "html5" });

    const v = document.getElementById("videoPlayer");
    if (!v) return;
    v.src = safeUrl;
    if (activeScreenPeer === null) v.classList.remove("hidden");
    v.play().catch(() => {});

    const maybeSend = (action) => {
        if (isApplyingSync) return;
        const now = Date.now();
        if (now - lastSyncSent < SYNC_THROTTLE_MS) return;
        lastSyncSent = now;
        wsSend({ type: "sync", action, time: v.currentTime });
    };
    v.onplay   = () => maybeSend("play");
    v.onpause  = () => maybeSend("pause");
    v.onseeked = () => {
        if (isApplyingSync) return;
        const now = Date.now();
        if (now - lastSyncSent < SEEK_THROTTLE_MS) return;
        lastSyncSent = now;
        wsSend({ type: "sync", action: "seek", time: v.currentTime });
    };
}

function applyRemoteSync(msg) {
    if (msg.action === "load") {
        const url = typeof msg.url === "string" ? msg.url.trim() : "";
        if (!url) return;
        const ytId = getYouTubeId(url);
        if (!ytId && !isSafeMediaUrl(url)) return;
        document.getElementById("urlInput").value = url;
        isApplyingSync = true;
        currentVideoUrl = url;
        try {
            if (ytId) loadYouTube(ytId);
            else      loadHtml5Video(url);
        } finally {
            setTimeout(() => { isApplyingSync = false; }, SYNC_THROTTLE_MS);
        }
        return;
    }

    isApplyingSync = true;
    try {
        if (currentVideoType === "youtube" && ytPlayer) {
            const cur = ytPlayer.getCurrentTime?.() ?? 0;
            if (msg.action === "play") {
                if (Math.abs(cur - msg.time) > SYNC_TOLERANCE_S) ytPlayer.seekTo(msg.time, true);
                ytPlayer.playVideo();
            } else if (msg.action === "pause") {
                if (Math.abs(cur - msg.time) > SYNC_TOLERANCE_S) ytPlayer.seekTo(msg.time, true);
                ytPlayer.pauseVideo();
            } else if (msg.action === "seek") {
                ytPlayer.seekTo(msg.time, true);
            }
        } else if (currentVideoType === "html5") {
            const v = document.getElementById("videoPlayer");
            if (!v) return;
            if (msg.action === "play") {
                if (Math.abs(v.currentTime - msg.time) > SYNC_TOLERANCE_S) v.currentTime = msg.time;
                v.play().catch(() => {});
            } else if (msg.action === "pause") {
                if (Math.abs(v.currentTime - msg.time) > SYNC_TOLERANCE_S) v.currentTime = msg.time;
                v.pause();
            } else if (msg.action === "seek") {
                v.currentTime = msg.time;
            }
        }
    } finally {
        // Keep guard active long enough that browser events fired by our own seek/play don't echo
        setTimeout(() => { isApplyingSync = false; }, APPLY_SYNC_GUARD_MS);
    }
}

function sendVideoStateTo(peerId) {
    if (!currentVideoUrl) return;
    wsSend({ to: peerId, type: "sync", action: "load", url: currentVideoUrl });
    setTimeout(() => {
        if (currentVideoType === "youtube" && ytPlayer && ytReady) {
            const t = ytPlayer.getCurrentTime?.() ?? 0;
            const paused = ytPlayer.getPlayerState?.() !== YT.PlayerState.PLAYING;
            wsSend({ to: peerId, type: "sync", action: paused ? "pause" : "play", time: t });
        } else if (currentVideoType === "html5") {
            const v = document.getElementById("videoPlayer");
            if (v) wsSend({ to: peerId, type: "sync", action: v.paused ? "pause" : "play", time: v.currentTime });
        }
    }, SYNC_SHARE_DELAY_MS);
}

// ── Chat ──────────────────────────────────────────────────────────────────────
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
    for (const id of ["chatMessages", "chatMessagesMobile"]) {
        const el = document.getElementById(id);
        if (!el) continue;
        el.appendChild(item.cloneNode(true));
        el.scrollTop = el.scrollHeight;
    }
    if (!isSelf) {
        const app = getApp();
        if (app) {
            const badge = document.getElementById("chatBadge");
            const drawer = document.getElementById("chatDrawer");
            const isDrawerClosed = !drawer || drawer.classList.contains("translate-y-full");
            if (badge && isDrawerClosed)
                badge.classList.remove("hidden");
            if (isDrawerClosed)
                app.unreadCount = (app.unreadCount ?? 0) + 1;
        }
    }
}

function buildChatItem(name, text, ts, isSelf) {
    const time = new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

    const div  = document.createElement("div");
    div.className = `flex flex-col ${isSelf ? "items-end" : "items-start"} gap-0.5`;

    const meta = document.createElement("span");
    meta.className = "text-[10px] text-slate-500";
    meta.textContent = `${name} · ${time}`;

    const bubble = document.createElement("div");
    bubble.className =
        "max-w-[90%] px-3 py-1.5 rounded-xl text-sm break-words " +
        (isSelf ? "bg-violet-700 text-white rounded-br-sm"
                : "bg-slate-800 text-slate-200 rounded-bl-sm");
    bubble.textContent = text;

    div.appendChild(meta);
    div.appendChild(bubble);
    return div;
}

// ── UI helpers ────────────────────────────────────────────────────────────────
function showError(message) {
    const toast = document.createElement("div");
    toast.className =
        "fixed top-4 left-1/2 -translate-x-1/2 z-50 px-4 py-2.5 bg-red-700 text-white text-sm " +
        "rounded-xl shadow-lg max-w-sm text-center pointer-events-none";
    toast.textContent = message;
    document.body.appendChild(toast);
    setTimeout(() => toast.remove(), 5000);
}

function fallbackCopy(text) {
    const ta = Object.assign(document.createElement("textarea"), { value: text });
    ta.style.cssText = "position:fixed;opacity:0";
    document.body.appendChild(ta);
    ta.select();
    try { return document.execCommand("copy"); } finally { document.body.removeChild(ta); }
}

// ── YouTube IFrame API callback ───────────────────────────────────────────────
window.onYouTubeIframeAPIReady = function () {
    ytReady = true;
    if (window.__pendingYtVideoId) {
        createYTPlayer(window.__pendingYtVideoId);
        window.__pendingYtVideoId = null;
    }
};

// ── Bootstrap ─────────────────────────────────────────────────────────────────
function initWebRTC() {
    wsConnect();

    const localLabel = document.getElementById("localLabel");
    if (localLabel) localLabel.textContent = USERNAME;

    // URL bar
    document.getElementById("btnLoad")?.addEventListener("click", () =>
        loadVideoUrl(document.getElementById("urlInput")?.value ?? ""));
    document.getElementById("urlInput")?.addEventListener("keydown", e => {
        if (e.key === "Enter") loadVideoUrl(e.target.value);
    });

    // Chat (desktop)
    document.getElementById("btnSendChat")?.addEventListener("click", () =>
        sendChat(document.getElementById("chatInput")));
    document.getElementById("chatInput")?.addEventListener("keydown", e => {
        if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); sendChat(e.target); }
    });

    // Chat (mobile)
    document.getElementById("btnSendChatMobile")?.addEventListener("click", () =>
        sendChat(document.getElementById("chatInputMobile")));
    document.getElementById("chatInputMobile")?.addEventListener("keydown", e => {
        if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); sendChat(e.target); }
    });

    // Mobile chat drawer
    document.getElementById("btnChat")?.addEventListener("click", () => {
        const drawer = document.getElementById("chatDrawer");
        const isOpen = !drawer.classList.contains("translate-y-full");
        drawer.classList.toggle("translate-y-full", isOpen);
        if (!isOpen) {
            document.getElementById("chatBadge")?.classList.add("hidden");
            const app = getApp();
            if (app) app.unreadCount = 0;
        }
    });
    document.getElementById("btnCloseChat")?.addEventListener("click", () => {
        document.getElementById("chatDrawer")?.classList.add("translate-y-full");
    });

    // Copy room link
    document.getElementById("btnCopyLink")?.addEventListener("click", () => {
        const btn = document.getElementById("btnCopyLink");
        const reset = () => setTimeout(() => (btn.textContent = "📋"), 1600);
        const url = location.href;
        if (navigator.clipboard?.writeText) {
            navigator.clipboard.writeText(url)
                .then(() => { btn.textContent = "✅"; reset(); })
                .catch(() => { btn.textContent = fallbackCopy(url) ? "✅" : "❌"; reset(); });
        } else {
            btn.textContent = fallbackCopy(url) ? "✅" : "❌";
            reset();
        }
    });

    // Expose actions to Alpine
    window.rtcActions = { toggleMic, toggleCamera, toggleScreenShare };
}

document.addEventListener("DOMContentLoaded", initWebRTC);

