let pc = new RTCPeerConnection({
    iceServers: [{ urls: "stun:stun.l.google.com:19302" }]
});

let localStream = null;
let screenStream = null;

const wsUrl = location.protocol === "https:"
    ? `wss://${location.host}/ws`
    : `ws://${location.host}/ws`;

let ws = new WebSocket(wsUrl);

let nextIncomingStreamKind = null; // classifies the next incoming remote track

function updateStatus(text) {
    const el = document.getElementById("statusText");
    if (el) el.textContent = text;
}

// --- WebSocket Handling ---
ws.onopen = () => {
    ws.send("join:" + ROOM_ID);
};

ws.onclose = () => {
    updateStatus("Disconnected from server.");
};

ws.onerror = (err) => {
    console.error("WebSocket error:", err);
    updateStatus("Connection error. Please reload.");
};

ws.onmessage = async (event) => {
    const raw = event.data;

    if (raw.startsWith("join:")) {
        updateStatus("The other person joined!");

        // Renegotiate so the new peer receives any active streams
        if (localStream || screenStream) {
            await renegotiate();
        }
        return;
    }

    if (raw.startsWith("leave:")) {
        document.getElementById("remoteCam").srcObject = null;
        document.getElementById("remoteScreen").srcObject = null;
        updateStatus("The other person left the room.");
        return;
    }

    let msg;
    try {
        msg = JSON.parse(raw);
    } catch (e) {
        console.error("Failed to parse WebSocket message:", e);
        return;
    }

    if (!msg || !msg.type) return;

    if (msg.type === "offer") {
        await pc.setRemoteDescription(new RTCSessionDescription(msg));
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        wsSend(JSON.stringify(answer));
    } else if (msg.type === "answer") {
        await pc.setRemoteDescription(new RTCSessionDescription(msg));
    } else if (msg.type === "candidate") {
        try {
            await pc.addIceCandidate(new RTCIceCandidate(msg.candidate));
        } catch (e) {
            console.error("Error adding ICE candidate:", e);
        }
    } else if (msg.type === "metadata") {
        nextIncomingStreamKind = msg.kind;
    } else if (msg.type === "camera-off") {
        document.getElementById("remoteCam").srcObject = null;
    } else if (msg.type === "screen-off") {
        document.getElementById("remoteScreen").srcObject = null;
    }
};

// --- ICE candidates ---
pc.onicecandidate = (event) => {
    if (event.candidate) {
        wsSend(JSON.stringify({ type: "candidate", candidate: event.candidate }));
    }
};

// --- Remote Tracks ---
pc.ontrack = (event) => {
    const stream = event.streams[0];

    if (nextIncomingStreamKind === "screen") {
        document.getElementById("remoteScreen").srcObject = stream;
        document.getElementById("remoteScreen").muted = false;
    } else {
        // "camera" or unknown — treat as camera
        document.getElementById("remoteCam").srcObject = stream;
    }

    nextIncomingStreamKind = null;
};

function wsSend(data) {
    if (ws.readyState === WebSocket.OPEN) {
        ws.send(data);
    }
}

// --- Renegotiate (send new offer with current tracks) ---
async function renegotiate() {
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    wsSend(JSON.stringify(offer));
}

// --- Toggle Camera + Mic ---
async function startCamera() {
    if (localStream) {
        localStream.getTracks().forEach(track => track.stop());
        pc.getSenders()
            .filter(s => s.track && localStream.getTracks().includes(s.track))
            .forEach(s => pc.removeTrack(s));

        wsSend(JSON.stringify({ type: "camera-off" }));
        document.getElementById("localCam").srcObject = null;
        document.getElementById("btnCam").textContent = "🎥 Camera";
        localStream = null;
        return;
    }

    localStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
    document.getElementById("localCam").srcObject = localStream;

    localStream.getTracks().forEach(track => pc.addTrack(track, localStream));

    wsSend(JSON.stringify({ type: "metadata", kind: "camera" }));
    await renegotiate();

    document.getElementById("btnCam").textContent = "🎥 Stop Camera";
}

// --- Toggle Screen Share ---
async function startScreenShare() {
    if (screenStream) {
        stopScreenShare();
        return;
    }

    screenStream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
    screenStream.getTracks().forEach(track => pc.addTrack(track, screenStream));

    wsSend(JSON.stringify({ type: "metadata", kind: "screen" }));
    await renegotiate();

    document.getElementById("btnShare").textContent = "🖥️ Stop Share";

    // Clean up when the user stops sharing via the browser's native UI
    const videoTrack = screenStream.getVideoTracks()[0];
    if (videoTrack) {
        videoTrack.addEventListener("ended", () => stopScreenShare());
    }
}

function stopScreenShare() {
    if (!screenStream) return;

    screenStream.getTracks().forEach(track => track.stop());
    pc.getSenders()
        .filter(s => s.track && screenStream.getTracks().includes(s.track))
        .forEach(s => pc.removeTrack(s));

    wsSend(JSON.stringify({ type: "screen-off" }));
    screenStream = null;
    document.getElementById("btnShare").textContent = "🖥️ Share";
}

// --- Controls ---
document.getElementById("btnCam").addEventListener("click", () => startCamera());
document.getElementById("btnShare").addEventListener("click", () => startScreenShare());

