using System.Text.RegularExpressions;
using Microsoft.AspNetCore.Mvc;
using Microsoft.AspNetCore.Mvc.RazorPages;

namespace _2gether_watch.Pages;

public class RoomModel : PageModel
{
    // Room IDs may only contain URL-safe, JS-safe characters.
    // Max 64 chars is generous for UUIDs while bounding memory and log output.
    private static readonly Regex RoomIdPattern = new(@"^[A-Za-z0-9_-]{1,64}$", RegexOptions.Compiled);

    public string RoomId { get; set; } = string.Empty;

    public IActionResult OnGet(string? id)
    {
        if (string.IsNullOrWhiteSpace(id) || !RoomIdPattern.IsMatch(id))
            return RedirectToPage("/Index");

        RoomId = id;
        return Page();
    }
}
