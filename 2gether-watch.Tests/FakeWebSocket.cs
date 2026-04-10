using System.Net.WebSockets;
using System.Text;
using System.Threading.Channels;

namespace _2gether_watch.Tests;

/// <summary>
/// A completely in-memory WebSocket implementation for testing.
///
/// Usage:
///   var (serverSide, clientSide) = FakeWebSocket.CreatePair();
///   - serverSide: passed to RoomManager
///   - clientSide: used by the test to inject incoming messages and collect outgoing messages
/// </summary>
public sealed class FakeWebSocket : WebSocket
{
    private readonly Channel<ArraySegment<byte>> _recvQueue;   // messages this socket reads
    private FakeWebSocket? _partner;
    private WebSocketState _state = WebSocketState.Open;

    /// <summary>All messages sent BY this socket (i.e., written by the server/manager).</summary>
    public List<string> Sent { get; } = [];

    private FakeWebSocket(Channel<ArraySegment<byte>> recvQueue)
    {
        _recvQueue = recvQueue;
    }

    /// <summary>Creates a bidirectionally connected pair (server-side, client-side).</summary>
    public static (FakeWebSocket server, FakeWebSocket client) CreatePair()
    {
        var sToc = Channel.CreateUnbounded<ArraySegment<byte>>(); // server→client
        var cTos = Channel.CreateUnbounded<ArraySegment<byte>>(); // client→server

        // server reads from cTos (what the client sends), sends to sToc
        var server = new FakeWebSocket(recvQueue: cTos);
        // client reads from sToc (what the server sends), sends to cTos
        var client = new FakeWebSocket(recvQueue: sToc);

        // Wire: when server sends → write to sToc (client's recv queue)
        server._partner = client;
        // Wire: when client sends → write to cTos (server's recv queue)
        client._partner = server;

        return (server, client);
    }

    // ── Test helpers ────────────────────────────────────────────────────────────

    /// <summary>Simulate the client sending a text message to the server.</summary>
    public void SendToServer(string text)
    {
        var bytes = Encoding.UTF8.GetBytes(text);
        // Write into the PARTNER's receive queue (the server's inbox)
        _partner?._recvQueue.Writer.TryWrite(new ArraySegment<byte>(bytes));
    }

    /// <summary>Read a single text message sent by the server to this client (waits).</summary>
    public async Task<string> ReadFromServerAsync(CancellationToken ct = default)
    {
        var seg = await _recvQueue.Reader.ReadAsync(ct);
        return Encoding.UTF8.GetString(seg.Array!, seg.Offset, seg.Count);
    }

    /// <summary>Signal that the client has disconnected (no more messages).</summary>
    public void Disconnect()
    {
        _state = WebSocketState.CloseReceived;
        // Complete the PARTNER's receive queue so the server's ReceiveAsync returns Close
        _partner?._recvQueue.Writer.TryComplete();
        // Also complete own queue
        _recvQueue.Writer.TryComplete();
    }

    // ── WebSocket API ────────────────────────────────────────────────────────────

    public override WebSocketState State => _state;
    public override WebSocketCloseStatus? CloseStatus => null;
    public override string? CloseStatusDescription => null;
    public override string? SubProtocol => null;

    public override Task<WebSocketReceiveResult> ReceiveAsync(ArraySegment<byte> buffer, CancellationToken ct)
    {
        return ReceiveInternalAsync(buffer, ct);
    }

    private async Task<WebSocketReceiveResult> ReceiveInternalAsync(ArraySegment<byte> buffer, CancellationToken ct)
    {
        try
        {
            var seg = await _recvQueue.Reader.ReadAsync(ct);
            seg.CopyTo(buffer);
            return new WebSocketReceiveResult(seg.Count, WebSocketMessageType.Text, endOfMessage: true);
        }
        catch (ChannelClosedException)
        {
            _state = WebSocketState.Closed;
            return new WebSocketReceiveResult(0, WebSocketMessageType.Close, endOfMessage: true);
        }
        catch (OperationCanceledException)
        {
            _state = WebSocketState.Closed;
            return new WebSocketReceiveResult(0, WebSocketMessageType.Close, endOfMessage: true);
        }
    }

    public override Task SendAsync(
        ArraySegment<byte> buffer,
        WebSocketMessageType messageType,
        bool endOfMessage,
        CancellationToken ct)
    {
        var text = Encoding.UTF8.GetString(buffer.Array!, buffer.Offset, buffer.Count);
        Sent.Add(text);

        // Route the data to the partner's receive queue (what the partner's ReceiveAsync will read)
        if (_partner != null)
        {
            var copy = buffer.Array!.Skip(buffer.Offset).Take(buffer.Count).ToArray();
            _partner._recvQueue.Writer.TryWrite(new ArraySegment<byte>(copy));
        }

        return Task.CompletedTask;
    }

    public override Task CloseAsync(WebSocketCloseStatus closeStatus, string? statusDescription, CancellationToken ct)
    {
        _state = WebSocketState.Closed;
        _recvQueue.Writer.TryComplete();
        return Task.CompletedTask;
    }

    public override Task CloseOutputAsync(WebSocketCloseStatus closeStatus, string? statusDescription, CancellationToken ct)
        => CloseAsync(closeStatus, statusDescription, ct);

    public override void Abort() { _state = WebSocketState.Aborted; _recvQueue.Writer.TryComplete(); }
    public override void Dispose() { }

    // Required by abstract base but not needed:
    public override ValueTask<ValueWebSocketReceiveResult> ReceiveAsync(Memory<byte> buffer, CancellationToken ct)
        => throw new NotSupportedException();
}
