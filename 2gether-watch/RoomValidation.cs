using System.Text.RegularExpressions;

namespace _2gether_watch;

/// <summary>
/// Shared validation rules used by both the HTTP layer (Room.cshtml.cs) and the
/// WebSocket layer (RoomManager.cs) to enforce a consistent room-ID format.
/// </summary>
public static partial class RoomValidation
{
    /// <summary>
    /// Allowed room-ID pattern: URL-safe and JS-safe characters, max 64 chars.
    /// Must match the client-side <c>ROOM_ID_PATTERN</c> in Index.cshtml.
    /// </summary>
    [GeneratedRegex(@"^[A-Za-z0-9_-]{1,64}$")]
    public static partial Regex RoomIdPattern();
}
