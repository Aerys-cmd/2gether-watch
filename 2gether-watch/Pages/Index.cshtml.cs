using Microsoft.AspNetCore.Mvc.RazorPages;

namespace _2gether_watch.Pages;

public class IndexModel : PageModel
{
    public string BaseUrl { get; set; } = string.Empty;

    public void OnGet()
    {
        // Generate base URL from current request for canonical and social meta tags
        var request = HttpContext.Request;
        BaseUrl = $"{request.Scheme}://{request.Host}";
    }
}