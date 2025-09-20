let pc = new RTCPeerConnection({
    iceServers: [{ urls: "stun:stun.l.google.com:19302" }]
});

let localStream;
let screenStream;

let ws = location.protocol === "https:" ? new WebSocket(`wss://${location.host}/ws`) : new WebSocket(`ws://${location.host}/ws`);

let nextIncomingStreamKind = null; // helper for classifying remote streams

// --- WebSocket Handling ---
ws.onopen = () => {
    ws.send("join:" + ROOM_ID);
};

ws.onmessage = async (event) => {

    let msg = event.data;

    if (msg.startsWith("join:")) {
        document.getElementById("roomVacantText").textContent = "Odaya birisi katıldı";

        if (localStream) {
            await startCamera();
            await startCamera();
        }
        console.log("join:", msg);
        if (screenStream) {
            await startScreenShare();
            await startScreenShare();
        }
        return;
    }

    if (msg.startsWith("leave:")) {
        document.getElementById("remoteCam").srcObject = null;
        document.getElementById("remoteScreen").srcObject = null;
        document.getElementById("roomVacantText").textContent = "Diğer kullanıcı odadan ayrıldı";
        return;
    }

    msg = null;
    try {
        msg = JSON.parse(event.data);
    }
    catch (error) {
        console.error(error);
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
            console.error("Error adding candidate:", e);
        }
    } else if (msg.type === "metadata") {
        // 👈 mark next incoming stream
        nextIncomingStreamKind = msg.kind;
    }
    else if (msg.type === "camera-off") {
        document.getElementById("remoteCam").srcObject = null;
    }
    else if (msg.type === "screen-off") {
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
    console.log(stream)

    console.log(nextIncomingStreamKind, 'nextIncomingStreamKind')

    if (nextIncomingStreamKind === "screen") {
        document.getElementById("remoteScreen").srcObject = stream;
        document.getElementById("remoteScreen").muted = false;
    } else if (nextIncomingStreamKind === "camera") {
        document.getElementById("remoteCam").srcObject = stream;
    } else {
        // fallback: assume camera
        document.getElementById("remoteCam").srcObject = stream;
    }

    console.log(document.getElementById("remoteCam").srcObject)
};

// --- Start Camera + Mic ---
async function startCamera() {

    if (localStream) {
        localStream.getTracks().forEach(track => {
            track.stop();
        });

        pc.getSenders().forEach(sender => {
            if (sender.track && localStream.getTracks().includes(sender.track)) {
                pc.removeTrack(sender); // detach from peer
            }
        });

        ws.send(JSON.stringify({ type: "camera-off" }));

        document.getElementById("localCam").srcObject = null;
        document.getElementById("btnCam").textContent = "🎥";
        localStream = null;
        return;
    }

    localStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
    document.getElementById("localCam").srcObject = localStream;

    localStream.getTracks().forEach(track => {
        pc.addTrack(track, localStream);
    });

    // tell remote this is a camera stream
    ws.send(JSON.stringify({ type: "metadata", kind: "camera" }));

    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    ws.send(JSON.stringify(offer));
    document.getElementById("btnCam").textContent = "🎥❌";
}

async function startScreenShare() {

    if (screenStream) {
        screenStream.getTracks().forEach(track => {
            track.stop();
        });

        pc.getSenders().forEach(sender => {
            if (sender.track && screenStream.getTracks().includes(sender.track)) {
                pc.removeTrack(sender); // detach from peer
            }
        });

        document.getElementById("remoteScreen").srcObject = null;
        document.getElementById("btnShare").textContent = "🖥️";

        ws.send(JSON.stringify({ type: "screen-off" }));
        screenStream = null;

        return;
    }


    screenStream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });

    screenStream.getTracks().forEach(track => {
        pc.addTrack(track, screenStream);
    });

    document.getElementById("remoteScreen").srcObject = screenStream;
    document.getElementById("remoteScreen").muted = true;

    // tell remote this is a screen stream
    ws.send(JSON.stringify({ type: "metadata", kind: "screen" }));

    // renegotiate
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    ws.send(JSON.stringify(offer));

    document.getElementById("btnShare").textContent = "🖥️❌";
}

// --- Controls ---
document.getElementById("btnCam").onclick = () => startCamera();
document.getElementById("btnShare").onclick = () => startScreenShare();
