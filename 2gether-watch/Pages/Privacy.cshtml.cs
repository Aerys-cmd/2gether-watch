using Microsoft.AspNetCore.Mvc.RazorPages;

namespace _2gether_watch.Pages;

public class PrivacyModel : PageModel
{
    public string BaseUrl { get; private set; } = string.Empty;

    public void OnGet() => BaseUrl = $"{Request.Scheme}://{Request.Host}";
}
