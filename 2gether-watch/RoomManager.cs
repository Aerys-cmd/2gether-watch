using System.Collections.Concurrent;
using System.Net.WebSockets;
using System.Text;

namespace _2gether_watch;

public class RoomManager
{
    private readonly ConcurrentDictionary<string, HashSet<WebSocket>> _rooms = new();
    private readonly Lock _lock = new();
    private readonly ILogger<RoomManager> _logger;

    public RoomManager(ILogger<RoomManager> logger)
    {
        _logger = logger;
    }

    public async Task HandleConnectionAsync(WebSocket socket)
    {
        var buffer = new byte[1024 * 16];
        string? roomId = null;

        try
        {
            while (socket.State == WebSocketState.Open)
            {
                var msg = await ReceiveFullMessageAsync(socket, buffer);
                if (msg is null) break; // connection closed

                if (msg.StartsWith("join:"))
                {
                    roomId = msg[5..];

                    int existingPeerCount;
                    lock (_lock)
                    {
                        var room = _rooms.GetOrAdd(roomId, _ => new HashSet<WebSocket>());
                        existingPeerCount = room.Count;
                        room.Add(socket);
                    }

                    _logger.LogInformation("Socket joined room {RoomId} ({Count} existing peer(s))", roomId, existingPeerCount);

                    // If there were already peers in the room, tell the new joiner so their
                    // UI reflects that someone is already present.
                    if (existingPeerCount > 0)
                    {
                        await SendToAsync(socket, "join:" + roomId);
                    }

                    // Notify existing peers that someone new joined
                    await BroadcastAsync(roomId, socket, "join:" + roomId);
                    continue;
                }

                // Broadcast signaling messages to other peers in the same room
                if (roomId != null)
                {
                    await BroadcastAsync(roomId, socket, msg);
                }
            }
        }
        catch (WebSocketException ex)
        {
            _logger.LogWarning(ex, "WebSocket error for room {RoomId}", roomId);
        }
        finally
        {
            if (roomId != null)
            {
                RemoveFromRoom(roomId, socket);
                _logger.LogInformation("Socket left room {RoomId}", roomId);
                await BroadcastAsync(roomId, socket, "leave:" + roomId);
            }
        }
    }

    private const int MaxMessageBytes = 64 * 1024; // 64 KB

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

    private void RemoveFromRoom(string roomId, WebSocket socket)
    {
        lock (_lock)
        {
            if (_rooms.TryGetValue(roomId, out var room))
            {
                room.Remove(socket);
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
        await socket.SendAsync(new ArraySegment<byte>(bytes), WebSocketMessageType.Text, true, CancellationToken.None);
    }

    private async Task BroadcastAsync(string roomId, WebSocket sender, string message)
    {
        List<WebSocket> peers;
        lock (_lock)
        {
            if (!_rooms.TryGetValue(roomId, out var room)) return;
            peers = room.Where(p => p != sender && p.State == WebSocketState.Open).ToList();
        }

        var bytes = Encoding.UTF8.GetBytes(message);
        var segment = new ArraySegment<byte>(bytes);

        foreach (var peer in peers)
        {
            try
            {
                await peer.SendAsync(segment, WebSocketMessageType.Text, true, CancellationToken.None);
            }
            catch (WebSocketException ex)
            {
                _logger.LogWarning(ex, "Failed to send to a peer in room {RoomId}", roomId);
            }
        }
    }
}
