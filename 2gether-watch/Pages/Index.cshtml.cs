using Microsoft.AspNetCore.Mvc;
using Microsoft.AspNetCore.Mvc.RazorPages;

namespace _2gether_watch.Pages;

public class IndexModel : PageModel
{
    private readonly ILogger<IndexModel> _logger;

    public string RoomId { get; set; } = string.Empty;

    public IndexModel(ILogger<IndexModel> logger)
    {
        _logger = logger;
    }

    public IActionResult OnGet(string id)
    {
        if (string.IsNullOrWhiteSpace(id))
            return RedirectToPage("/Landing");

        RoomId = id;
        return Page();
    }
}