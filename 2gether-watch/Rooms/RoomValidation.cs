using System.Text.RegularExpressions;

namespace _2gether_watch.Rooms;

/// <summary>
/// Shared validation rules used by both the HTTP layer (Room.cshtml.cs) and the
/// WebSocket layer (Rooms/RoomManager.cs) to enforce a consistent room-ID format.
/// </summary>
public static partial class RoomValidation
{
    /// <summary>
    /// Allowed room-ID pattern: URL-safe and JS-safe characters, max 64 chars.
    /// Matches the client-side <c>ROOM_ID_PATTERN</c> in Index.cshtml and the
    /// <c>maxlength</c> attribute on the room-ID input.
    /// </summary>
    [GeneratedRegex(@"^[A-Za-z0-9_-]{1,64}$")]
    public static partial Regex RoomIdPattern();
}
