using _2gether_watch;
using Microsoft.AspNetCore.Mvc;
using Microsoft.AspNetCore.Mvc.RazorPages;

namespace _2gether_watch.Pages;

public class RoomModel : PageModel
{
    public string RoomId { get; set; } = string.Empty;

    public IActionResult OnGet(string? id)
    {
        if (string.IsNullOrWhiteSpace(id) || !RoomValidation.RoomIdPattern().IsMatch(id))
            return RedirectToPage("/Index");

        RoomId = id;
        return Page();
    }
}
