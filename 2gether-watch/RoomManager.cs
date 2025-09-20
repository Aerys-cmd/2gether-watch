using System.Net.WebSockets;
using System.Text;

namespace _2gether_watch;

public class RoomManager
{
    private readonly Dictionary<string, List<WebSocket>> _rooms = new();

    public async Task HandleConnectionAsync(WebSocket socket)
    {
        var buffer = new byte[1024 * 100];
        string? roomId = null;

        while (socket.State == WebSocketState.Open)
        {
            var result = await socket.ReceiveAsync(new ArraySegment<byte>(buffer), CancellationToken.None);
            if (result.MessageType == WebSocketMessageType.Close) break;

            var msg = Encoding.UTF8.GetString(buffer, 0, result.Count);

            // join:roomId
            if (msg.StartsWith("join:"))
            {
                roomId = msg.Substring(5);
                if (!_rooms.ContainsKey(roomId))
                    _rooms[roomId] = new List<WebSocket>();
                _rooms[roomId].Add(socket);

                foreach (var peer in _rooms[roomId])
                {
                    if (peer != socket && peer.State == WebSocketState.Open)
                    {
                        await peer.SendAsync(
                            new ArraySegment<byte>(Encoding.UTF8.GetBytes("join:" + roomId)),
                            WebSocketMessageType.Text,
                            true,
                            CancellationToken.None);
                    }
                }


                continue;
            }

            // broadcast signaling messages to other peers in the same room
            if (roomId != null && _rooms.ContainsKey(roomId))
            {
                foreach (var peer in _rooms[roomId])
                {
                    if (peer != socket && peer.State == WebSocketState.Open)
                    {
                        await peer.SendAsync(
                            new ArraySegment<byte>(Encoding.UTF8.GetBytes(msg)),
                            WebSocketMessageType.Text,
                            true,
                            CancellationToken.None);
                    }
                }
            }
        }

        if (roomId is null)
            return;

        _rooms[roomId].Remove(socket);

        foreach (var peer in _rooms[roomId])
        {
            if (peer.State == WebSocketState.Open)
            {
                await peer.SendAsync(
                    new ArraySegment<byte>(Encoding.UTF8.GetBytes("leave:" + roomId)),
                    WebSocketMessageType.Text,
                    true,
                    CancellationToken.None);
            }
        }
    }
}
