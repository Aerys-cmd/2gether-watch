using System.Net.WebSockets;
using System.Text;

namespace _2gether_watch;

public class RoomManager
{
    private readonly ILogger<RoomManager> _logger;
    private readonly object _lock = new();
    private readonly Dictionary<string, List<WebSocket>> _rooms = new();

    public RoomManager(ILogger<RoomManager> logger)
    {
        _logger = logger;
    }

    public async Task HandleConnectionAsync(WebSocket socket)
    {
        var buffer = new byte[1024 * 100];
        string? roomId = null;

        try
        {
            while (socket.State == WebSocketState.Open)
            {
                WebSocketReceiveResult result;
                try
                {
                    result = await socket.ReceiveAsync(new ArraySegment<byte>(buffer), CancellationToken.None);
                }
                catch (WebSocketException ex)
                {
                    _logger.LogWarning("WebSocket receive error: {Message}", ex.Message);
                    break;
                }

                if (result.MessageType == WebSocketMessageType.Close)
                {
                    if (socket.State == WebSocketState.CloseReceived)
                        await socket.CloseAsync(WebSocketCloseStatus.NormalClosure, "Closing", CancellationToken.None);
                    break;
                }

                var msg = Encoding.UTF8.GetString(buffer, 0, result.Count);

                // join:roomId
                if (msg.StartsWith("join:"))
                {
                    var newRoomId = msg[5..].Trim();
                    if (string.IsNullOrWhiteSpace(newRoomId))
                        continue;

                    roomId = newRoomId;

                    List<WebSocket> snapshot;
                    lock (_lock)
                    {
                        if (!_rooms.TryGetValue(roomId, out var peers))
                        {
                            peers = [];
                            _rooms[roomId] = peers;
                        }
                        peers.Add(socket);
                        snapshot = [.. peers];
                    }

                    _logger.LogInformation("Socket joined room {RoomId}. Room size: {Count}", roomId, snapshot.Count);

                    foreach (var peer in snapshot)
                    {
                        if (peer != socket && peer.State == WebSocketState.Open)
                        {
                            await TrySendAsync(peer, "join:" + roomId);
                        }
                    }

                    continue;
                }

                // broadcast signaling messages to other peers in the same room
                if (roomId != null)
                {
                    List<WebSocket> snapshot;
                    lock (_lock)
                    {
                        if (!_rooms.TryGetValue(roomId, out var peers))
                            continue;
                        snapshot = [.. peers];
                    }

                    var msgBytes = Encoding.UTF8.GetBytes(msg);
                    foreach (var peer in snapshot)
                    {
                        if (peer != socket && peer.State == WebSocketState.Open)
                            await TrySendAsync(peer, msgBytes);
                    }
                }
            }
        }
        finally
        {
            await CleanupConnectionAsync(socket, roomId);
        }
    }

    private async Task CleanupConnectionAsync(WebSocket socket, string? roomId)
    {
        if (roomId is null)
            return;

        List<WebSocket> snapshot;
        lock (_lock)
        {
            if (!_rooms.TryGetValue(roomId, out var peers))
                return;

            peers.Remove(socket);
            _logger.LogInformation("Socket left room {RoomId}. Room size: {Count}", roomId, peers.Count);

            if (peers.Count == 0)
            {
                _rooms.Remove(roomId);
                return;
            }

            snapshot = [.. peers];
        }

        foreach (var peer in snapshot)
        {
            if (peer.State == WebSocketState.Open)
                await TrySendAsync(peer, "leave:" + roomId);
        }
    }

    private async Task TrySendAsync(WebSocket peer, string message)
        => await TrySendAsync(peer, Encoding.UTF8.GetBytes(message));

    private async Task TrySendAsync(WebSocket peer, byte[] bytes)
    {
        try
        {
            await peer.SendAsync(new ArraySegment<byte>(bytes), WebSocketMessageType.Text, true, CancellationToken.None);
        }
        catch (WebSocketException ex)
        {
            _logger.LogWarning("Failed to send to peer: {Message}", ex.Message);
        }
    }
}
