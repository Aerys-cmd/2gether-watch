using System.Net.WebSockets;
using System.Text.Json;
using _2gether_watch.Rooms;
using Microsoft.Extensions.Logging.Abstractions;
using Xunit;

namespace _2gether_watch.Tests;

public class RoomManagerTests
{
    private static RoomManager CreateManager() =>
        new(NullLogger<RoomManager>.Instance);

    // ── Helper ───────────────────────────────────────────────────────────────────

    /// <summary>
    /// Runs HandleConnectionAsync for a socket in the background and returns both
    /// the server-side socket and a task representing the connection lifecycle.
    /// The caller must call client.Disconnect() to stop the background task.
    /// </summary>
    private static (FakeWebSocket server, FakeWebSocket client, Task task) Connect(
        RoomManager mgr)
    {
        var (server, client) = FakeWebSocket.CreatePair();
        var task = mgr.HandleConnectionAsync(server);
        return (server, client, task);
    }

    /// <summary>
    /// Join a room and wait until BOTH the "self:" and "peers:" messages arrive.
    /// This guarantees the server has fully processed the join (including broadcasting
    /// "peer-joined" to existing peers) before we return.
    /// </summary>
    private static async Task<(string peerId, string peersMsg)> JoinRoomFull(
        FakeWebSocket client, string roomId, CancellationToken ct = default)
    {
        client.SendToServer($"join:{roomId}");
        var selfMsg  = await client.ReadFromServerAsync(ct);
        Assert.StartsWith("self:", selfMsg);
        var peersMsg = await client.ReadFromServerAsync(ct);
        Assert.StartsWith("peers:", peersMsg);
        return (selfMsg[5..], peersMsg);
    }

    /// <summary>Join a room and wait until both welcome messages arrive.</summary>
    private static async Task<string> JoinRoom(FakeWebSocket client, string roomId,
        CancellationToken ct = default)
    {
        var (peerId, _) = await JoinRoomFull(client, roomId, ct);
        return peerId;
    }

    // ── Room capacity ─────────────────────────────────────────────────────────────

    [Fact]
    public async Task JoinRoom_UpToMaxSize_Succeeds()
    {
        var mgr      = CreateManager();
        const string room = "test-room";
        var cts      = new CancellationTokenSource(TimeSpan.FromSeconds(5));

        var connections = new List<(FakeWebSocket server, FakeWebSocket client, Task task)>();

        for (int i = 0; i < RoomManager.MaxRoomSize; i++)
        {
            var conn = Connect(mgr);
            connections.Add(conn);
            await JoinRoom(conn.client, room, cts.Token);
        }

        Assert.Equal(RoomManager.MaxRoomSize, mgr.GetRoomSize(room));

        // Clean up
        foreach (var (_, client, _) in connections)
            client.Disconnect();

        await Task.WhenAll(connections.Select(c => c.task));
    }

    [Fact]
    public async Task JoinRoom_EleventhPeer_ReceivesRoomFullError()
    {
        var mgr      = CreateManager();
        const string room = "full-room";
        var cts      = new CancellationTokenSource(TimeSpan.FromSeconds(5));

        var fullConnections = new List<(FakeWebSocket server, FakeWebSocket client, Task task)>();

        // Fill the room to max
        for (int i = 0; i < RoomManager.MaxRoomSize; i++)
        {
            var conn = Connect(mgr);
            fullConnections.Add(conn);
            await JoinRoom(conn.client, room, cts.Token);
        }

        // 11th peer tries to join
        var (eleventhServer, eleventhClient, eleventhTask) = Connect(mgr);
        eleventhClient.SendToServer($"join:{room}");

        var errorMsg = await eleventhClient.ReadFromServerAsync(cts.Token);
        Assert.Equal("error:room-full", errorMsg);

        // Room size should still be MaxRoomSize
        Assert.Equal(RoomManager.MaxRoomSize, mgr.GetRoomSize(room));

        // Clean up
        foreach (var (_, client, _) in fullConnections)
            client.Disconnect();

        await Task.WhenAll(fullConnections.Select(c => c.task).Append(eleventhTask));
    }

    // ── Peer lifecycle messages ───────────────────────────────────────────────────

    [Fact]
    public async Task FirstPeer_ReceivesEmptyPeersList()
    {
        var mgr  = CreateManager();
        var cts  = new CancellationTokenSource(TimeSpan.FromSeconds(5));
        var (server, client, task) = Connect(mgr);

        var (peerId, peersMsg) = await JoinRoomFull(client, "room-a", cts.Token);

        Assert.NotEmpty(peerId);
        Assert.Equal("peers:", peersMsg);

        client.Disconnect();
        await task;
    }

    [Fact]
    public async Task SecondPeer_ReceivesPeersList_WithFirstPeerId()
    {
        var mgr  = CreateManager();
        var cts  = new CancellationTokenSource(TimeSpan.FromSeconds(5));

        // Peer A joins (consumes "self:A" + "peers:")
        var (serverA, clientA, taskA) = Connect(mgr);
        var peerAId = await JoinRoom(clientA, "room-b", cts.Token);

        // Peer B joins (consumes "self:B" + "peers:[A]")
        var (serverB, clientB, taskB) = Connect(mgr);
        var (peerBId, peersB) = await JoinRoomFull(clientB, "room-b", cts.Token);
        // Also consume "peer-joined:B" notification for A
        _ = await clientA.ReadFromServerAsync(cts.Token);

        Assert.NotEmpty(peerBId);
        Assert.StartsWith("peers:", peersB);
        Assert.Contains(peerAId, peersB); // B's peers list includes A's ID

        clientA.Disconnect();
        clientB.Disconnect();
        await Task.WhenAll(taskA, taskB);
    }

    [Fact]
    public async Task ExistingPeer_ReceivesPeerJoinedNotification()
    {
        var mgr  = CreateManager();
        var cts  = new CancellationTokenSource(TimeSpan.FromSeconds(5));

        // Peer A joins first (consumes "self:A" + "peers:")
        var (serverA, clientA, taskA) = Connect(mgr);
        await JoinRoom(clientA, "room-c", cts.Token);

        // Peer B joins (consumes "self:B" + "peers:[A]")
        var (serverB, clientB, taskB) = Connect(mgr);
        var peerBId = await JoinRoom(clientB, "room-c", cts.Token);

        // A should have received "peer-joined:{B's ID}"
        var joinNotification = await clientA.ReadFromServerAsync(cts.Token);
        Assert.Equal($"peer-joined:{peerBId}", joinNotification);

        clientA.Disconnect();
        clientB.Disconnect();
        await Task.WhenAll(taskA, taskB);
    }

    [Fact]
    public async Task WhenPeerLeaves_OtherPeersReceivePeerLeftNotification()
    {
        var mgr  = CreateManager();
        var cts  = new CancellationTokenSource(TimeSpan.FromSeconds(5));

        // A joins (consumes "self:A" + "peers:")
        var (serverA, clientA, taskA) = Connect(mgr);
        await JoinRoom(clientA, "room-d", cts.Token);

        // B joins (consumes "self:B" + "peers:[A]")
        var (serverB, clientB, taskB) = Connect(mgr);
        var peerBId = await JoinRoom(clientB, "room-d", cts.Token);
        // Consume "peer-joined:B" from A
        _ = await clientA.ReadFromServerAsync(cts.Token);

        // B disconnects
        clientB.Disconnect();
        await taskB;

        // A should receive "peer-left:{B's ID}"
        var leftMsg = await clientA.ReadFromServerAsync(cts.Token);
        Assert.Equal($"peer-left:{peerBId}", leftMsg);

        clientA.Disconnect();
        await taskA;
    }

    // ── Message routing ───────────────────────────────────────────────────────────

    [Fact]
    public async Task BroadcastMessage_ReachesAllPeers()
    {
        var mgr  = CreateManager();
        var cts  = new CancellationTokenSource(TimeSpan.FromSeconds(5));

        // Setup: 3 peers (A, B, C) in the same room
        // JoinRoom reads "self" + "peers"; we also need to drain "peer-joined" notifications for existing peers.
        var (serverA, clientA, taskA) = Connect(mgr);
        await JoinRoom(clientA, "room-e", cts.Token);  // A joins; A's queue: empty

        var (serverB, clientB, taskB) = Connect(mgr);
        await JoinRoom(clientB, "room-e", cts.Token);  // B joins; B's queue: empty; A gets "peer-joined:B"
        _ = await clientA.ReadFromServerAsync(cts.Token);  // drain "peer-joined:B" from A

        var (serverC, clientC, taskC) = Connect(mgr);
        await JoinRoom(clientC, "room-e", cts.Token);  // C joins; C's queue: empty; A, B get "peer-joined:C"
        _ = await clientA.ReadFromServerAsync(cts.Token);  // drain "peer-joined:C" from A
        _ = await clientB.ReadFromServerAsync(cts.Token);  // drain "peer-joined:C" from B

        // A sends a broadcast JSON message
        clientA.SendToServer("""{"type":"chat","text":"hello"}""");

        // Both B and C should receive it (with "from" added)
        var msgForB = await clientB.ReadFromServerAsync(cts.Token);
        var msgForC = await clientC.ReadFromServerAsync(cts.Token);

        using var docB = JsonDocument.Parse(msgForB);
        using var docC = JsonDocument.Parse(msgForC);

        Assert.Equal("chat", docB.RootElement.GetProperty("type").GetString());
        Assert.Equal("chat", docC.RootElement.GetProperty("type").GetString());

        // "from" field must be present and must NOT be spoofable by the sender
        Assert.True(docB.RootElement.TryGetProperty("from", out _));
        Assert.True(docC.RootElement.TryGetProperty("from", out _));

        clientA.Disconnect(); clientB.Disconnect(); clientC.Disconnect();
        await Task.WhenAll(taskA, taskB, taskC);
    }

    [Fact]
    public async Task TargetedMessage_OnlyReachesTargetPeer()
    {
        var mgr  = CreateManager();
        var cts  = new CancellationTokenSource(TimeSpan.FromSeconds(5));

        // A joins (consumes "self:A" + "peers:")
        var (serverA, clientA, taskA) = Connect(mgr);
        var peerAId = await JoinRoom(clientA, "room-f", cts.Token);

        // B joins (consumes "self:B" + "peers:[A]"); A gets "peer-joined:B"
        var (serverB, clientB, taskB) = Connect(mgr);
        var peerBId = await JoinRoom(clientB, "room-f", cts.Token);
        _ = await clientA.ReadFromServerAsync(cts.Token);  // drain "peer-joined:B" from A

        // C joins (consumes "self:C" + "peers:[A,B]"); A and B get "peer-joined:C"
        var (serverC, clientC, taskC) = Connect(mgr);
        var peerCId = await JoinRoom(clientC, "room-f", cts.Token);
        _ = await clientA.ReadFromServerAsync(cts.Token);  // drain "peer-joined:C" from A
        _ = await clientB.ReadFromServerAsync(cts.Token);  // drain "peer-joined:C" from B

        // A sends targeted message to B only
        clientA.SendToServer($$"""{"type":"offer","to":"{{peerBId}}","sdp":"test"}""");

        // B should receive it
        var msgForB = await clientB.ReadFromServerAsync(cts.Token);
        using var docB = JsonDocument.Parse(msgForB);
        Assert.Equal("offer", docB.RootElement.GetProperty("type").GetString());
        // The "to" field should be stripped from the relayed message (only "from" is injected)
        Assert.False(docB.RootElement.TryGetProperty("to", out _));

        // C should NOT receive anything within a short timeout
        using var noMsgCts = new CancellationTokenSource(TimeSpan.FromMilliseconds(200));
        await Assert.ThrowsAnyAsync<OperationCanceledException>(() =>
            clientC.ReadFromServerAsync(noMsgCts.Token));

        clientA.Disconnect(); clientB.Disconnect(); clientC.Disconnect();
        await Task.WhenAll(taskA, taskB, taskC);
    }

    [Fact]
    public async Task SenderDoesNotReceiveOwnBroadcast()
    {
        var mgr  = CreateManager();
        var cts  = new CancellationTokenSource(TimeSpan.FromSeconds(5));

        // A joins (consumes "self:A" + "peers:")
        var (serverA, clientA, taskA) = Connect(mgr);
        await JoinRoom(clientA, "room-g", cts.Token);

        // B joins (consumes "self:B" + "peers:[A]"); A gets "peer-joined:B"
        var (serverB, clientB, taskB) = Connect(mgr);
        await JoinRoom(clientB, "room-g", cts.Token);
        _ = await clientA.ReadFromServerAsync(cts.Token);  // drain "peer-joined:B" from A

        // A broadcasts
        clientA.SendToServer("""{"type":"sync","action":"play","time":0}""");

        // B gets it
        var msgForB = await clientB.ReadFromServerAsync(cts.Token);
        Assert.Contains("sync", msgForB);

        // A should NOT get its own message
        using var selfCts = new CancellationTokenSource(TimeSpan.FromMilliseconds(200));
        await Assert.ThrowsAnyAsync<OperationCanceledException>(() =>
            clientA.ReadFromServerAsync(selfCts.Token));

        clientA.Disconnect(); clientB.Disconnect();
        await Task.WhenAll(taskA, taskB);
    }

    // ── "from" spoofing prevention ────────────────────────────────────────────────

    [Fact]
    public async Task Client_CannotSpoofFromField()
    {
        var mgr  = CreateManager();
        var cts  = new CancellationTokenSource(TimeSpan.FromSeconds(5));

        // A joins (consumes "self:A" + "peers:")
        var (serverA, clientA, taskA) = Connect(mgr);
        await JoinRoom(clientA, "room-h", cts.Token);

        // B joins (consumes "self:B" + "peers:[A]"); A gets "peer-joined:B"
        var (serverB, clientB, taskB) = Connect(mgr);
        var peerBId = await JoinRoom(clientB, "room-h", cts.Token);
        _ = await clientA.ReadFromServerAsync(cts.Token);  // drain "peer-joined:B" from A

        // A tries to spoof "from" as B's ID
        clientA.SendToServer($$"""{"type":"chat","from":"{{peerBId}}","text":"spoofed"}""");

        var msg = await clientB.ReadFromServerAsync(cts.Token);
        using var doc = JsonDocument.Parse(msg);
        // "from" must be A's actual ID, not the spoofed B ID
        var fromId = doc.RootElement.GetProperty("from").GetString();
        Assert.NotEqual(peerBId, fromId);

        clientA.Disconnect(); clientB.Disconnect();
        await Task.WhenAll(taskA, taskB);
    }

    // ── Room cleanup ──────────────────────────────────────────────────────────────

    [Fact]
    public async Task EmptyRoom_IsRemovedFromMemory()
    {
        var mgr  = CreateManager();
        var cts  = new CancellationTokenSource(TimeSpan.FromSeconds(5));

        var (server, client, task) = Connect(mgr);
        await JoinRoom(client, "room-i", cts.Token);  // reads "self:" + "peers:"

        Assert.Equal(1, mgr.GetRoomSize("room-i"));

        client.Disconnect();
        await task;

        Assert.Equal(0, mgr.GetRoomSize("room-i"));
    }
}
