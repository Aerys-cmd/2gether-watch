using System.Collections.Concurrent;
using System.Net.WebSockets;
using System.Text;
using System.Text.Json;

namespace _2gether_watch;

/// <summary>
/// Manages WebSocket signaling rooms for 2gether Watch.
///
/// Protocol (client → server):
///   "join:{roomId}"            – first message after connect; assigns a peer ID.
///
/// Protocol (server → client):
///   "error:room-full"          – room is at capacity; connection will be closed.
///   "self:{peerId}"            – your assigned peer ID.
///   "peers:{id1},{id2},…"      – comma-separated list of peer IDs already in room
///                                (empty string after colon means you are the first).
///   "peer-joined:{peerId}"     – a new peer entered the room.
///   "peer-left:{peerId}"       – a peer left the room.
///   JSON { "from":"{id}", … }  – message relayed from another peer (broadcast or targeted).
///
/// Protocol (client → server, after join):
///   JSON { "to": "{peerId}", … } – targeted relay to one peer.
///   JSON { … }                   – broadcast relay to every other peer in the room.
/// </summary>
public class RoomManager
{
    public const int MaxRoomSize = 10;
    // 12 hex chars (48-bit) gives ~281 trillion possible IDs: negligible collision probability
    // for rooms of at most 10 peers with short-lived sessions.
    private const int PeerIdLength = 12;
    private const int MaxMessageBytes = 64 * 1024; // 64 KB

    // roomId → (peerId → WebSocket)
    private readonly ConcurrentDictionary<string, Dictionary<string, WebSocket>> _rooms = new();
    private readonly Lock _lock = new();
    private readonly ILogger<RoomManager> _logger;

    public RoomManager(ILogger<RoomManager> logger)
    {
        _logger = logger;
    }

    // Exposed for testing
    public int GetRoomSize(string roomId)
    {
        lock (_lock)
        {
            return _rooms.TryGetValue(roomId, out var r) ? r.Count : 0;
        }
    }

    public IReadOnlyList<string> GetPeerIds(string roomId)
    {
        lock (_lock)
        {
            if (!_rooms.TryGetValue(roomId, out var r)) return [];
            return [.. r.Keys];
        }
    }

    public async Task HandleConnectionAsync(WebSocket socket)
    {
        var buffer = new byte[1024 * 16];
        string? roomId = null;
        string? peerId = null;

        try
        {
            // ── Step 1: wait for the "join:{roomId}" handshake ────────────
            var handshake = await ReceiveFullMessageAsync(socket, buffer);
            if (handshake is null || !handshake.StartsWith("join:")) return;

            roomId = handshake[5..];
            if (string.IsNullOrWhiteSpace(roomId) || !RoomValidation.RoomIdPattern().IsMatch(roomId)) return;

            // ── Step 2: admit or reject ────────────────────────────────────
            string[] existingIds;
            bool roomFull;
            lock (_lock)
            {
                var room = _rooms.GetOrAdd(roomId, _ => new Dictionary<string, WebSocket>());
                roomFull = room.Count >= MaxRoomSize;
                if (!roomFull)
                {
                    peerId = GeneratePeerId();
                    existingIds = [.. room.Keys];
                    room[peerId] = socket;
                }
                else
                {
                    existingIds = [];
                }
            }

            if (roomFull)
            {
                // Send the rejection message and close before returning so the caller
                // (which may be inside a using-scoped socket) receives it deterministically.
                await RejectFullRoomAsync(socket);
                return;
            }

            _logger.LogInformation("Peer {PeerId} joined room {RoomId} ({Count} existing)", peerId, roomId, existingIds.Length);

            // ── Step 3: send welcome messages to the new peer ──────────────
            await SendToAsync(socket, $"self:{peerId}");
            await SendToAsync(socket, $"peers:{string.Join(',', existingIds)}");

            // ── Step 4: notify existing peers ─────────────────────────────
            await BroadcastRawAsync(roomId, peerId!, $"peer-joined:{peerId}");

            // ── Step 5: relay loop ─────────────────────────────────────────
            while (socket.State == WebSocketState.Open)
            {
                var msg = await ReceiveFullMessageAsync(socket, buffer);
                if (msg is null) break;

                await RelayMessageAsync(roomId, peerId!, msg);
            }
        }
        catch (WebSocketException ex)
        {
            _logger.LogWarning(ex, "WebSocket error for peer {PeerId} in room {RoomId}", peerId, roomId);
        }
        finally
        {
            if (roomId != null && peerId != null)
            {
                RemovePeer(roomId, peerId);
                _logger.LogInformation("Peer {PeerId} left room {RoomId}", peerId, roomId);
                await BroadcastRawAsync(roomId, peerId, $"peer-left:{peerId}");
            }
        }
    }

    // ── Message routing ───────────────────────────────────────────────────

    private async Task RelayMessageAsync(string roomId, string fromPeerId, string message)
    {
        if (!message.StartsWith('{'))
        {
            // After join, clients may only send JSON relay payloads.
            // Drop raw text so peers cannot spoof server control frames such as
            // "peer-left:" or "peer-joined:".
            _logger.LogDebug("Dropped non-JSON message from {PeerId}", fromPeerId);
            return;
        }

        try
        {
            using var doc = JsonDocument.Parse(message);
            var root = doc.RootElement;

            // Build augmented message with "from" field (prevents spoofing)
            var augmented = BuildAugmented(root, fromPeerId);

            if (root.TryGetProperty("to", out var toProp) && toProp.GetString() is string targetId)
            {
                // Targeted relay
                WebSocket? target;
                lock (_lock)
                {
                    target = _rooms.TryGetValue(roomId, out var room) &&
                             room.TryGetValue(targetId, out var ws) ? ws : null;
                }
                if (target != null)
                    await SendToAsync(target, augmented);
            }
            else
            {
                // Broadcast relay
                await BroadcastRawAsync(roomId, fromPeerId, augmented);
            }
        }
        catch (JsonException)
        {
            // Malformed JSON – drop silently
            _logger.LogDebug("Dropped malformed JSON from {PeerId}", fromPeerId);
        }
    }

    /// <summary>Serialises the peer's JSON object with an injected "from" property.</summary>
    private static string BuildAugmented(JsonElement root, string fromPeerId)
    {
        using var ms = new MemoryStream();
        using (var w = new Utf8JsonWriter(ms))
        {
            w.WriteStartObject();
            w.WriteString("from", fromPeerId);
            foreach (var prop in root.EnumerateObject())
            {
                // Never let a client spoof the "from" or "to" fields in the output
                if (prop.Name is "from" or "to") continue;
                prop.WriteTo(w);
            }
            w.WriteEndObject();
        }
        return Encoding.UTF8.GetString(ms.ToArray());
    }

    // ── Helpers ───────────────────────────────────────────────────────────

    private static string GeneratePeerId() => Guid.NewGuid().ToString("N")[..PeerIdLength];

    private static async Task RejectFullRoomAsync(WebSocket socket)
    {
        await SendToAsync(socket, "error:room-full");
        await socket.CloseAsync(
            WebSocketCloseStatus.PolicyViolation,
            "Room is full.",
            CancellationToken.None);
    }

    private void RemovePeer(string roomId, string peerId)
    {
        lock (_lock)
        {
            if (_rooms.TryGetValue(roomId, out var room))
            {
                room.Remove(peerId);
                if (room.Count == 0)
                {
                    _rooms.TryRemove(roomId, out _);
                    _logger.LogInformation("Room {RoomId} closed (empty)", roomId);
                }
            }
        }
    }

    private static async Task SendToAsync(WebSocket socket, string message)
    {
        if (socket.State != WebSocketState.Open) return;
        var bytes = Encoding.UTF8.GetBytes(message);
        try
        {
            await socket.SendAsync(
                new ArraySegment<byte>(bytes),
                WebSocketMessageType.Text,
                endOfMessage: true,
                CancellationToken.None);
        }
        catch (WebSocketException)
        {
            // Peer already gone – ignore
        }
    }

    /// <summary>Sends a raw string to every peer in the room except the sender.</summary>
    private async Task BroadcastRawAsync(string roomId, string senderPeerId, string message)
    {
        List<WebSocket> targets;
        lock (_lock)
        {
            if (!_rooms.TryGetValue(roomId, out var room)) return;
            targets = room
                .Where(kv => kv.Key != senderPeerId && kv.Value.State == WebSocketState.Open)
                .Select(kv => kv.Value)
                .ToList();
        }

        var bytes = Encoding.UTF8.GetBytes(message);
        var segment = new ArraySegment<byte>(bytes);

        foreach (var peer in targets)
        {
            try
            {
                await peer.SendAsync(segment, WebSocketMessageType.Text, true, CancellationToken.None);
            }
            catch (WebSocketException ex)
            {
                _logger.LogWarning(ex, "Failed to broadcast to a peer in room {RoomId}", roomId);
            }
        }
    }

    private static async Task<string?> ReceiveFullMessageAsync(WebSocket socket, byte[] buffer)
    {
        using var ms = new MemoryStream();
        WebSocketReceiveResult result;
        do
        {
            result = await socket.ReceiveAsync(new ArraySegment<byte>(buffer), CancellationToken.None);
            if (result.MessageType == WebSocketMessageType.Close) return null;

            if (ms.Length + result.Count > MaxMessageBytes)
            {
                await socket.CloseAsync(
                    WebSocketCloseStatus.MessageTooBig,
                    "Message exceeds maximum allowed size.",
                    CancellationToken.None);
                return null;
            }

            ms.Write(buffer, 0, result.Count);
        } while (!result.EndOfMessage);

        return Encoding.UTF8.GetString(ms.ToArray());
    }
}
