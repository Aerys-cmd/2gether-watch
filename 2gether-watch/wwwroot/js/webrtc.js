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
    { urls: "stun:stun2.l.google.com:19302" },
    { urls: "stun:stun3.l.google.com:19302" },
];
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
// Screen-share RTP encoding parameters.
const SCREEN_MAX_BITRATE_BPS   = 20_000_000; // 20 Mbps — crisp 1080p@60fps with headroom for detail
const SCREEN_START_BITRATE_BPS = 10_000_000; // 10 Mbps — high initial bitrate to avoid blurry ramp-up
const SCREEN_MAX_FRAMERATE     = 60;         // allow up to 60 fps for fluid motion
const SCREEN_ENCODING_PRIORITY = "high";

// ── Alpine app state (populated in initWebRTC, read/written throughout) ──────
function getApp() { return window.alpineApp ?? null; }
function setState(patch) {
    const app = getApp();
    if (app) Object.assign(app, patch);
}

// ── Autoplay recovery (mobile/browser policy) ───────────────────────────────
const pendingAutoplayEls = new Set();
let autoplayUnlockBound = false;

function requestMediaPlayback(el) {
    if (!el) return;
    const p = el.play();
    if (p?.catch) {
        p.catch(() => {
            pendingAutoplayEls.add(el);
            bindAutoplayUnlock();
            document.getElementById("autoplayNudge")?.classList.remove("hidden");
        });
    }
}

function bindAutoplayUnlock() {
    if (autoplayUnlockBound) return;
    autoplayUnlockBound = true;

    const unlock = () => {
        for (const el of [...pendingAutoplayEls]) {
            const p = el.play();
            if (p?.then) {
                p.then(() => pendingAutoplayEls.delete(el)).catch(() => {});
            } else {
                pendingAutoplayEls.delete(el);
            }
        }
        document.getElementById("autoplayNudge")?.classList.add("hidden");
    };

    // Use broad interaction hooks so one tap/click unblocks pending remote media.
    ["pointerdown", "touchstart", "keydown", "click"].forEach(type => {
        document.addEventListener(type, unlock, { passive: true });
    });
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
            // New joiner creates peer states; existing peers will initiate offers.
            for (const pid of idList.split(",")) {
                if (pid) ensurePeerState(pid);
            }
        }
        setState({ status: idList ? "Connected" : "Waiting for others…", statusColor: idList ? "green" : "amber" });
        return;
    }

    if (raw.startsWith("peer-joined:")) {
        const pid = raw.slice(12);
        // Existing peers are the designated offerers for newcomers.
        await initiateConnection(pid);
        appendSystemMessage("Someone joined");
        setState({ status: "Connected", statusColor: "green", peerCount: peerStates.size });
        return;
    }

    if (raw.startsWith("peer-left:")) {
        const pid = raw.slice(10);
        const leavingName = peerStates.get(pid)?.username ?? "Someone";
        closePeer(pid);
        appendSystemMessage(leavingName + " left");
        setState({ status: peerStates.size > 0 ? "Connected" : "Waiting for others…",
                   statusColor: peerStates.size > 0 ? "green" : "amber",
                   peerCount: peerStates.size });
        return;
    }

    if (raw.startsWith("error:room-full")) {
        setState({ status: "Room is full (max 10 participants).", statusColor: "red" });
        showError("This room is full — redirecting you home…");
        setTimeout(() => { window.location.href = "/?roomFull=1"; }, 3000);
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
            if (state.pc.signalingState === "have-local-offer") {
                await state.pc.setRemoteDescription(msg).catch(e => console.warn("setRemoteDescription(answer):", e));
                await flushPendingCandidates(state);
            }
            break;
        case "candidate":
            if (msg.candidate)
                await addOrQueueCandidate(state, msg.candidate);
            break;
        case "streammap":
            Object.assign(state.streamKindMap, msg.map);
            routeKnownRemoteVideoStreams(fromId, state);
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
// Map<peerId, { pc, makingOffer, needsNegotiation, streamKindMap, remoteVideoStreams, pendingCandidates, username, camEl, audioEl }>
const peerStates = new Map();

function ensurePeerState(peerId) {
    if (!peerStates.has(peerId)) {
        const state = {
            pc: createPC(peerId),
            makingOffer: false,
            needsNegotiation: false,
            streamKindMap: {},
            remoteVideoStreams: {},
            pendingCandidates: [],
            username: peerId.slice(0, 6),
            camEl: null,
            audioEl: null,
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
    const pc = new RTCPeerConnection({
        iceServers: ICE_SERVERS,
        iceCandidatePoolSize: 4,        // pre-gather candidates for faster connectivity
        bundlePolicy: "max-bundle",     // multiplex all media over one transport
    });

    // Always advertise receive capability so a newly joined peer can receive
    // existing camera/screen streams even if they have not opened local media yet.
    // This prevents one-way "no video until I open my camera" sessions.
    pc.addTransceiver("audio", { direction: "recvonly" });
    pc.addTransceiver("video", { direction: "recvonly" }); // camera lane
    pc.addTransceiver("video", { direction: "recvonly" }); // screen-share lane

    pc.onicecandidate = ({ candidate }) => {
        if (candidate) wsSend({ to: peerId, type: "candidate", candidate });
    };

    pc.ontrack = ({ track, streams }) => {
        const stream = streams?.[0];
        if (!stream) return;

        if (track.kind === "audio") {
            setPeerAudioStream(peerId, stream);
            return;
        }
        if (track.kind !== "video") return;

        const state = peerStates.get(peerId);
        if (!state) return;
        // ontrack can fire before streammap arrives; cache and route when known.
        state.remoteVideoStreams[stream.id] = stream;
        routeRemoteVideoStream(peerId, state, stream.id);
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
            if (!state) return;
            state.makingOffer = false;
            // If we attempted renegotiation while non-stable, retry now.
            if (state.needsNegotiation) {
                void trySendPendingOffer(peerId, state);
            }
        }
    };

    // Add existing local tracks to the new PC
    if (localCamStream) localCamStream.getTracks().forEach(t => pc.addTrack(t, localCamStream));
    if (localScreenStream) {
        localScreenStream.getTracks().forEach(t => pc.addTrack(t, localScreenStream));
        // Apply quality encodings for the screen track on this new connection.
        const screenTrack = localScreenStream.getVideoTracks()[0];
        if (screenTrack) {
            const sender = pc.getSenders().find(s => s.track === screenTrack);
            if (sender) applyScreenEncodingToSender(sender);
        }
    }

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
        // Boost the initial bandwidth allocation in the SDP so the encoder starts
        // at a generous bitrate instead of slowly ramping up from near-zero.
        offer.sdp = boostSdpBandwidth(offer.sdp);
        await state.pc.setLocalDescription(offer);
        // Send streammap before the offer so the remote side can classify incoming tracks
        sendStreamMapTo(peerId);
        wsSend(Object.assign({ to: peerId }, state.pc.localDescription.toJSON()));
    } catch (e) {
        console.error("sendOffer:", e);
        state.makingOffer = false;
        state.needsNegotiation = true;
    }
}

function requestRenegotiation(peerId, state) {
    state.needsNegotiation = true;
    void trySendPendingOffer(peerId, state);
}

async function trySendPendingOffer(peerId, state) {
    if (!state.needsNegotiation) return;
    if (state.makingOffer || state.pc.signalingState !== "stable") return;
    state.needsNegotiation = false;
    await sendOffer(peerId, state);
}

// Raise the session-level bandwidth line (b=AS:…) in the SDP so the WebRTC
// congestion controller starts at a generous rate instead of slowly probing up
// from a conservative default.  This dramatically reduces the initial "blurry
// ramp-up" period for screen shares.
function boostSdpBandwidth(sdp) {
    if (!sdp) return sdp;
    // Remove any existing session/media-level bandwidth lines so ours takes effect
    sdp = sdp.replace(/b=AS:[^\r\n]*/g, "");
    sdp = sdp.replace(/b=TIAS:[^\r\n]*/g, "");
    // Insert a generous application-specific bandwidth (in kbps) after each
    // m=video line so every video m-section gets the boost.
    const bwKbps = Math.round(SCREEN_MAX_BITRATE_BPS / 1000);
    const bwBps  = SCREEN_MAX_BITRATE_BPS;
    sdp = sdp.replace(/(m=video [^\r\n]*\r?\n)/g,
        `$1b=AS:${bwKbps}\r\nb=TIAS:${bwBps}\r\n`);
    return sdp;
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
        await flushPendingCandidates(state);
        const answer = await state.pc.createAnswer();
        answer.sdp = boostSdpBandwidth(answer.sdp);
        await state.pc.setLocalDescription(answer);
        // Offerer sends streammap before offer; answerer must also send its map
        // so the new joiner can classify incoming streams deterministically.
        sendStreamMapTo(fromId);
        wsSend(Object.assign({ to: fromId }, state.pc.localDescription.toJSON()));
    } catch (e) {
        console.error("handleOffer:", e);
    }
}

async function addOrQueueCandidate(state, candidate) {
    // Candidate messages may arrive before SDP is applied; queue to avoid drops.
    if (!state.pc.remoteDescription) {
        state.pendingCandidates.push(candidate);
        return;
    }
    await state.pc.addIceCandidate(candidate).catch(() => {});
}

async function flushPendingCandidates(state) {
    if (!state.pc.remoteDescription || state.pendingCandidates.length === 0) return;
    const queued = state.pendingCandidates.splice(0, state.pendingCandidates.length);
    for (const candidate of queued)
        await state.pc.addIceCandidate(candidate).catch(() => {});
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
        localScreenStream = await navigator.mediaDevices.getDisplayMedia({
            video: {
                width:     { ideal: 1920 },
                height:    { ideal: 1080 },
                frameRate: { ideal: 60, max: 60 },
                cursor:    "always",
            },
            audio: true,
            // Prefer high frame-rate capture so the remote side sees fluid motion.
            preferCurrentTab: false,
            selfBrowserSurface: "exclude",
        });
        const videoTrack = localScreenStream.getVideoTracks()[0];
        if (videoTrack) {
            // "detail" tells the encoder to preserve spatial sharpness (text,
            // UI elements, fine detail) instead of blurring frames to save bits.
            // The generous bitrate budget keeps motion smooth at the same time.
            videoTrack.contentHint = "detail";
            videoTrack.addEventListener("ended", stopScreenShare);
        }
        addLocalTracksToPeers(localScreenStream);
        applyScreenEncodings();
        broadcastStreamMap();
        setRemoteScreen("local", localScreenStream);
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
    clearRemoteScreen("local");
    wsSend({ type: "screen-off" });
    setState({ screenActive: false });
}

function addLocalTracksToPeers(stream) {
    for (const [peerId, state] of peerStates) {
        stream.getTracks().forEach(t => {
            // Avoid adding duplicate senders
            if (!state.pc.getSenders().some(s => s.track === t))
                state.pc.addTrack(t, stream);
        });
        requestRenegotiation(peerId, state);
    }
}

function removeLocalTracksFromPeers(stream) {
    const trackSet = new Set(stream.getTracks());
    peerStates.forEach((state, peerId) => {
        const { pc } = state;
        pc.getSenders()
          .filter(s => s.track && trackSet.has(s.track))
          .forEach(s => pc.removeTrack(s));
        requestRenegotiation(peerId, state);
    });
}

// Apply high-quality encoding parameters to a single RTCRtpSender carrying the
// screen-share video track.  Balances sharpness and smoothness for a near-original
// viewing experience.
function applyScreenEncodingToSender(sender) {
    const params = sender.getParameters();
    if (!params.encodings?.length) params.encodings = [{}];
    params.encodings.forEach(enc => {
        enc.maxBitrate           = SCREEN_MAX_BITRATE_BPS;
        enc.maxFramerate         = SCREEN_MAX_FRAMERATE;
        enc.priority             = SCREEN_ENCODING_PRIORITY;
        enc.networkPriority      = SCREEN_ENCODING_PRIORITY;
        enc.scaleResolutionDownBy = 1;          // send at full captured resolution
    });
    // "balanced" lets the encoder trade a small amount of frame rate for
    // resolution when bandwidth is tight, keeping the image crisp without
    // dropping to a slideshow.
    params.degradationPreference = "balanced";
    sender.setParameters(params).catch(err => console.warn("Screen share: failed to set encoding params:", err));
}

// Apply high-quality encoding parameters to every sender carrying the screen-share
// video track. Called after tracks are added to peers and again when a new peer joins
// while a screen share is already active.
function applyScreenEncodings() {
    if (!localScreenStream) return;
    const screenTrack = localScreenStream.getVideoTracks()[0];
    if (!screenTrack) return;
    for (const [, state] of peerStates) {
        const sender = state.pc.getSenders().find(s => s.track === screenTrack);
        if (!sender) continue;
        applyScreenEncodingToSender(sender);
    }
}

// ── Remote camera tiles ───────────────────────────────────────────────────────
function addPeerCamTile(peerId, state) {
    const grid = document.getElementById("camGrid");
    if (!grid) return;

    const tile = document.createElement("div");
    tile.id = `cam-tile-${peerId}`;
    tile.className = "relative flex-none bg-slate-800 overflow-hidden cam-tile w-28 lg:w-full shrink-0";

    const vid = document.createElement("video");
    vid.autoplay = true;
    vid.playsInline = true;
    vid.className = "absolute inset-0 w-full h-full object-cover";
    vid.setAttribute("data-peer", peerId);

    const ph = document.createElement("div");
    ph.id = `cam-ph-${peerId}`;
    ph.className = "cam-ph absolute inset-0";
    ph.setAttribute("aria-label", "Remote camera inactive");
    ph.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>';

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
        pendingAutoplayEls.delete(state.camEl);
        state.camEl.srcObject = null;
        state.camEl = null;
    }
    if (state?.audioEl) {
        pendingAutoplayEls.delete(state.audioEl);
        state.audioEl.srcObject = null;
        state.audioEl.remove();
        state.audioEl = null;
    }
    document.getElementById(`cam-tile-${peerId}`)?.remove();
    const ph = document.getElementById(`cam-ph-${peerId}`);
    if (ph) ph.classList.remove("hidden");
}

function routeRemoteVideoStream(peerId, state, streamId) {
    const stream = state.remoteVideoStreams[streamId];
    if (!stream) return;

    const kind = state.streamKindMap[streamId];
    if (!kind) return;

    if (kind === "screen") {
        setRemoteScreen(peerId, stream);
        return;
    }

    setPeerCamStream(peerId, stream);
}

function routeKnownRemoteVideoStreams(peerId, state) {
    Object.keys(state.remoteVideoStreams).forEach(streamId => {
        routeRemoteVideoStream(peerId, state, streamId);
    });
}

function setPeerCamStream(peerId, stream) {
    const state = peerStates.get(peerId);
    if (!state) return;
    if (!state.camEl) addPeerCamTile(peerId, state);

    const videoEl = state.camEl;
    const ph = document.getElementById(`cam-ph-${peerId}`);

    // Keep remote camera video muted so browser autoplay policy does not block
    // rendering when the stream also carries an audio track.
    videoEl.muted = true;

    // Keep placeholder visible until the first real frame is available to avoid
    // showing a gray/blank tile during track start-up.
    ph?.classList.remove("hidden");
    videoEl.srcObject = stream;

    const revealVideo = () => ph?.classList.add("hidden");
    videoEl.onloadeddata = revealVideo;
    videoEl.onplaying = revealVideo;

    const track = stream.getVideoTracks()[0];
    if (track) {
        track.onunmute = revealVideo;
        track.onmute = () => ph?.classList.remove("hidden");
        if (!track.muted && track.readyState === "live") revealVideo();
    }

    requestMediaPlayback(videoEl);
}

function setPeerAudioStream(peerId, stream) {
    const state = peerStates.get(peerId);
    if (!state) return;

    const audioTracks = typeof stream.getAudioTracks === "function"
        ? stream.getAudioTracks()
        : [];
    if (audioTracks.length === 0) return;

    if (!state.audioEl) {
        const audioEl = document.createElement("audio");
        audioEl.autoplay = true;
        audioEl.playsInline = true;
        audioEl.setAttribute("data-peer-audio", peerId);
        audioEl.style.display = "none";
        document.body.appendChild(audioEl);
        state.audioEl = audioEl;
    }

    state.audioEl.srcObject = new MediaStream(audioTracks);
    requestMediaPlayback(state.audioEl);
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
    // Keep screen playback muted so autoplay policy doesn't block rendering.
    v.muted = true;
    v.srcObject = stream;

    // Minimise decode/render latency on the receiving side.
    // `playsInline` + `autoplay` are already set in HTML; reinforce here for safety.
    v.playsInline = true;
    v.autoplay = true;
    // Disable any user-agent buffering that adds delay (non-standard but respected
    // by some browsers).
    if ("latencyHint" in v)    v.latencyHint = 0;
    if ("disableRemotePlayback" in v) v.disableRemotePlayback = true;

    requestMediaPlayback(v);
    v.classList.remove("hidden");
    hideVideoOverlays(["stagePlaceholder", "ytPlayerContainer", "videoPlayer"]);
    setState({ videoType: "screen" });
}

function clearRemoteScreen(peerId) {
    if (activeScreenPeer !== peerId) return;
    activeScreenPeer = null;
    const v = document.getElementById("remoteScreen");
    if (v) { v.srcObject = null; v.classList.add("hidden"); }
    if (localScreenStream) {
        setRemoteScreen("local", localScreenStream);
    } else {
        restoreLocalVideo();
    }
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
let ytPlayer            = null;
let ytReady             = false;
// True once the YT player's onReady callback has fired (player APIs are safe to call).
let ytPlayerReady       = false;
// True while a YT player is loading as a result of applyRemoteSync("load"), so that
// the player's own auto-play onStateChange event is suppressed and not echoed back.
let ytLoadingFromRemote = false;
// Queued play/pause/seek command to apply once the YT player becomes ready.
let pendingYtSync       = null;
let currentVideoType    = null;
let currentVideoUrl     = "";
let isApplyingSync      = false;
let lastSyncSent        = 0;

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
    ytPlayerReady = false;
    const c = document.getElementById("ytPlayerContainer");
    if (!c) return;
    c.innerHTML = '<div id="ytPlayerEl"></div>';
    ytPlayer = new YT.Player("ytPlayerEl", {
        videoId,
        width: "100%",
        height: "100%",
        playerVars: { autoplay: 1, rel: 0, modestbranding: 1 },
        events: { onReady: onYtPlayerReady, onStateChange: onYtStateChange },
    });
}

function onYtPlayerReady() {
    ytPlayerReady = true;
    // Keep ytLoadingFromRemote true for APPLY_SYNC_GUARD_MS so that the initial
    // onStateChange(PLAYING) the IFrame API fires immediately after onReady
    // (due to autoplay:1) is suppressed and does not echo a spurious "play" sync.
    setTimeout(() => { ytLoadingFromRemote = false; }, APPLY_SYNC_GUARD_MS);
    if (pendingYtSync) {
        const sync = pendingYtSync;
        pendingYtSync = null;
        applyRemoteSync(sync);
    }
}

function onYtStateChange({ data }) {
    // Suppress echoes while we are applying a remote command or while the player
    // is auto-starting as a result of a remote "load" command.
    if (isApplyingSync || ytLoadingFromRemote) return;
    const t = ytPlayer?.getCurrentTime?.() ?? 0;
    // Play and pause are discrete state changes that must always be relayed —
    // do not throttle them (only continuous events like seek are throttled).
    if (data === YT.PlayerState.PLAYING) {
        lastSyncSent = Date.now();
        wsSend({ type: "sync", action: "play",  time: t });
    } else if (data === YT.PlayerState.PAUSED) {
        lastSyncSent = Date.now();
        wsSend({ type: "sync", action: "pause", time: t });
    }
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
    requestMediaPlayback(v);

    // Play and pause are discrete events — send them immediately without throttle so
    // that a pause/play is never silently dropped due to a recent seek or load event.
    v.onplay   = () => {
        if (isApplyingSync) return;
        lastSyncSent = Date.now();
        wsSend({ type: "sync", action: "play",  time: v.currentTime });
    };
    v.onpause  = () => {
        if (isApplyingSync) return;
        lastSyncSent = Date.now();
        wsSend({ type: "sync", action: "pause", time: v.currentTime });
    };
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
        currentVideoUrl = url;
        if (ytId) {
            // Track whether the player is already functional so we know if onReady
            // will fire (new player) or not (loadVideoById on existing player).
            const playerAlreadyReady = ytPlayerReady;
            ytLoadingFromRemote = true;
            loadYouTube(ytId);
            if (playerAlreadyReady) {
                // Existing player used loadVideoById — onReady will NOT fire again.
                // Clear the guard after a brief window to cover the player's own events.
                setTimeout(() => { ytLoadingFromRemote = false; }, APPLY_SYNC_GUARD_MS);
            }
            // else: onYtPlayerReady() will clear ytLoadingFromRemote and apply pendingYtSync.
        } else {
            isApplyingSync = true;
            loadHtml5Video(url);
            setTimeout(() => { isApplyingSync = false; }, APPLY_SYNC_GUARD_MS);
        }
        return;
    }

    // ── play / pause / seek ────────────────────────────────────────────────
    if (currentVideoType === "youtube") {
        if (!ytPlayerReady) {
            // Player is still initialising — store the latest state; onYtPlayerReady
            // will apply it once the player is functional.
            pendingYtSync = msg;
            return;
        }
        isApplyingSync = true;
        try {
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
        } finally {
            setTimeout(() => { isApplyingSync = false; }, APPLY_SYNC_GUARD_MS);
        }
    } else if (currentVideoType === "html5") {
        const v = document.getElementById("videoPlayer");
        if (!v) return;
        isApplyingSync = true;
        try {
            if (msg.action === "play") {
                if (Math.abs(v.currentTime - msg.time) > SYNC_TOLERANCE_S) v.currentTime = msg.time;
                requestMediaPlayback(v);
            } else if (msg.action === "pause") {
                if (Math.abs(v.currentTime - msg.time) > SYNC_TOLERANCE_S) v.currentTime = msg.time;
                v.pause();
            } else if (msg.action === "seek") {
                v.currentTime = msg.time;
            }
        } finally {
            // Keep guard active long enough that browser events fired by our own seek/play don't echo
            setTimeout(() => { isApplyingSync = false; }, APPLY_SYNC_GUARD_MS);
        }
    }
}

function sendVideoStateTo(peerId) {
    if (!currentVideoUrl) return;
    wsSend({ to: peerId, type: "sync", action: "load", url: currentVideoUrl });
    setTimeout(() => {
        if (currentVideoType === "youtube" && ytPlayer && ytReady && ytPlayerReady) {
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
            const isDrawerClosed = !drawer || drawer.classList.contains("chat-drawer-closed");
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
    meta.className = "text-[10px] text-zinc-500";
    meta.textContent = `${name} · ${time}`;

    const bubble = document.createElement("div");
    bubble.className =
        "max-w-[90%] px-2.5 py-1 text-xs break-words border " +
        (isSelf ? "bg-indigo-900 border-indigo-800 text-indigo-100"
                : "bg-slate-800 border-slate-700 text-slate-200");
    bubble.textContent = text;

    div.appendChild(meta);
    div.appendChild(bubble);
    return div;
}

function appendSystemMessage(text) {
    const item = document.createElement("div");
    item.className = "text-center text-[10px] text-slate-600 italic py-0.5";
    item.textContent = text;
    for (const id of ["chatMessages", "chatMessagesMobile"]) {
        const el = document.getElementById(id);
        if (!el) continue;
        el.appendChild(item.cloneNode(true));
        el.scrollTop = el.scrollHeight;
    }
}

// ── UI helpers ────────────────────────────────────────────────────────────────
function showError(message) {
    const toast = document.createElement("div");
    toast.className =
        "fixed top-4 left-1/2 -translate-x-1/2 z-50 px-4 py-2 bg-red-950 border border-red-800 text-red-300 text-xs " +
        "max-w-sm text-center pointer-events-none";
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
        const isOpen = !drawer.classList.contains("chat-drawer-closed");
        drawer.classList.toggle("chat-drawer-closed", isOpen);
        if (!isOpen) {
            document.getElementById("chatBadge")?.classList.add("hidden");
            const app = getApp();
            if (app) app.unreadCount = 0;
        }
    });
    document.getElementById("btnCloseChat")?.addEventListener("click", () => {
        document.getElementById("chatDrawer")?.classList.add("chat-drawer-closed");
    });

    // Landscape header chat button — same behaviour as the portrait footer button
    document.getElementById("btnChatLandscape")?.addEventListener("click", () => {
        const drawer = document.getElementById("chatDrawer");
        const isOpen = !drawer.classList.contains("chat-drawer-closed");
        drawer.classList.toggle("chat-drawer-closed", isOpen);
        if (!isOpen) {
            const app = getApp();
            if (app) app.unreadCount = 0;
        }
    });

    // Copy room link
    document.getElementById("btnCopyLink")?.addEventListener("click", () => {
        const btn = document.getElementById("btnCopyLink");
        const onCopied = (ok) => {
            if (!ok) return;
            btn.classList.add("text-green-400");
            btn.title = "Copied!";
            setTimeout(() => {
                btn.classList.remove("text-green-400");
                btn.title = "Copy invite link";
            }, 1600);
        };
        const url = location.href;
        if (navigator.clipboard?.writeText) {
            navigator.clipboard.writeText(url).then(() => onCopied(true)).catch(() => onCopied(fallbackCopy(url)));
        } else {
            onCopied(fallbackCopy(url));
        }
    });

    // Expose actions to Alpine
    window.rtcActions = { toggleMic, toggleCamera, toggleScreenShare, loadVideoUrl };
}

document.addEventListener("DOMContentLoaded", initWebRTC);

