let pc = new RTCPeerConnection({
    iceServers: [{ urls: "stun:stun.l.google.com:19302" }]
});

let localStream = null;
let screenStream = null;
let micMuted = false;

// Maps streamId -> "camera" | "screen" so tracks can be classified on arrival
const streamKindMap = {};

const wsUrl = location.protocol === "https:"
    ? `wss://${location.host}/ws`
    : `ws://${location.host}/ws`;

let ws = new WebSocket(wsUrl);

// --- WebSocket Handling ---
ws.onopen = () => {
    ws.send("join:" + ROOM_ID);
};

ws.onmessage = async (event) => {
    const raw = event.data;

    if (raw.startsWith("join:")) {
        document.getElementById("roomVacantText").textContent = "Someone joined the room";
        // Renegotiate with the new peer using already-active streams (no toggle needed)
        await renegotiate();
        return;
    }

    if (raw.startsWith("leave:")) {
        document.getElementById("remoteCam").srcObject = null;
        document.getElementById("remoteScreen").srcObject = null;
        document.getElementById("roomVacantText").textContent = "The other user left the room";
        return;
    }

    let msg;
    try {
        msg = JSON.parse(raw);
    } catch (e) {
        console.error("Failed to parse WebSocket message:", e);
        return;
    }

    if (msg.type === "offer") {
        await pc.setRemoteDescription(new RTCSessionDescription(msg));
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        ws.send(JSON.stringify(answer));
    } else if (msg.type === "answer") {
        await pc.setRemoteDescription(new RTCSessionDescription(msg));
    } else if (msg.type === "candidate") {
        try {
            await pc.addIceCandidate(new RTCIceCandidate(msg.candidate));
        } catch (e) {
            console.error("Error adding ICE candidate:", e);
        }
    } else if (msg.type === "metadata") {
        streamKindMap[msg.streamId] = msg.kind;
    } else if (msg.type === "camera-off") {
        document.getElementById("remoteCam").srcObject = null;
    } else if (msg.type === "screen-off") {
        document.getElementById("remoteScreen").srcObject = null;
    }
};

// --- ICE candidates ---
pc.onicecandidate = (event) => {
    if (event.candidate) {
        ws.send(JSON.stringify({ type: "candidate", candidate: event.candidate }));
    }
};

// --- Remote Tracks ---
pc.ontrack = (event) => {
    const stream = event.streams[0];
    const kind = streamKindMap[stream.id];

    if (kind === "screen") {
        document.getElementById("remoteScreen").srcObject = stream;
        document.getElementById("remoteScreen").muted = false;
    } else {
        // "camera" or unknown — default to cam panel
        document.getElementById("remoteCam").srcObject = stream;
    }
};

// --- Renegotiate: re-send metadata + new offer using existing tracks ---
async function renegotiate() {
    if (!localStream && !screenStream) return;

    if (localStream) {
        ws.send(JSON.stringify({ type: "metadata", kind: "camera", streamId: localStream.id }));
    }
    if (screenStream) {
        ws.send(JSON.stringify({ type: "metadata", kind: "screen", streamId: screenStream.id }));
    }

    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    ws.send(JSON.stringify(offer));
}

// --- Start/Stop Camera + Mic ---
async function startCamera() {
    if (localStream) {
        localStream.getTracks().forEach(t => t.stop());
        pc.getSenders()
            .filter(s => s.track && localStream.getTracks().includes(s.track))
            .forEach(s => pc.removeTrack(s));

        ws.send(JSON.stringify({ type: "camera-off" }));
        document.getElementById("localCam").srcObject = null;
        document.getElementById("btnCam").textContent = "🎥";
        localStream = null;
        return;
    }

    try {
        localStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
    } catch (e) {
        console.error("Camera/mic access denied:", e);
        return;
    }

    document.getElementById("localCam").srcObject = localStream;
    localStream.getTracks().forEach(t => pc.addTrack(t, localStream));

    ws.send(JSON.stringify({ type: "metadata", kind: "camera", streamId: localStream.id }));

    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    ws.send(JSON.stringify(offer));

    document.getElementById("btnCam").textContent = "🎥❌";

    // Sync mute button state with any existing mute
    if (micMuted) localStream.getAudioTracks().forEach(t => { t.enabled = false; });
}

// --- Toggle Mic ---
function toggleMic() {
    if (!localStream) return;
    micMuted = !micMuted;
    localStream.getAudioTracks().forEach(t => { t.enabled = !micMuted; });
    document.getElementById("btnMic").textContent = micMuted ? "🔇" : "🎙️";
}

// --- Start/Stop Screen Share ---
async function startScreenShare() {
    if (screenStream) {
        await stopScreenShare();
        return;
    }

    try {
        screenStream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
    } catch (e) {
        console.error("Screen share denied:", e);
        return;
    }

    screenStream.getTracks().forEach(t => pc.addTrack(t, screenStream));

    ws.send(JSON.stringify({ type: "metadata", kind: "screen", streamId: screenStream.id }));

    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    ws.send(JSON.stringify(offer));

    document.getElementById("btnShare").textContent = "🖥️❌";

    // Handle user stopping via the browser's native stop button
    screenStream.getVideoTracks()[0].onended = stopScreenShare;
}

async function stopScreenShare() {
    if (!screenStream) return;

    screenStream.getTracks().forEach(t => t.stop());
    pc.getSenders()
        .filter(s => s.track && screenStream.getTracks().includes(s.track))
        .forEach(s => pc.removeTrack(s));

    ws.send(JSON.stringify({ type: "screen-off" }));
    document.getElementById("btnShare").textContent = "🖥️";
    screenStream = null;
}

// --- Copy room link ---
function copyRoomLink() {
    navigator.clipboard.writeText(location.href).then(() => {
        const btn = document.getElementById("btnCopy");
        const prev = btn.textContent;
        btn.textContent = "✅ Copied!";
        setTimeout(() => { btn.textContent = prev; }, 2000);
    });
}

// --- Controls ---
document.getElementById("btnCam").onclick = startCamera;
document.getElementById("btnMic").onclick = toggleMic;
document.getElementById("btnShare").onclick = startScreenShare;
document.getElementById("btnCopy").onclick = copyRoomLink;

