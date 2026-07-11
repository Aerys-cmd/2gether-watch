using System.Text.Json;
using _2gether_watch.Blog;
using Microsoft.AspNetCore.Mvc;
using Microsoft.AspNetCore.Mvc.RazorPages;

namespace _2gether_watch.Pages.Blog;

public class PostModel(BlogService blogService) : PageModel
{
    public BlogPost Post { get; private set; } = null!;
    public string BaseUrl { get; set; } = string.Empty;
    public string JsonLd { get; private set; } = string.Empty;

    public IActionResult OnGet(string slug)
    {
        var post = blogService.GetBySlug(slug);
        if (post is null)
            return NotFound();

        Post = post;
        BaseUrl = $"{Request.Scheme}://{Request.Host}";
        JsonLd = JsonSerializer.Serialize(new Dictionary<string, object>
        {
            ["@context"] = "https://schema.org",
            ["@type"] = "BlogPosting",
            ["headline"] = post.Title,
            ["description"] = post.Description,
            ["datePublished"] = post.Date.ToString("yyyy-MM-dd"),
            ["author"] = new Dictionary<string, object>
            {
                ["@type"] = "Organization",
                ["name"] = "2gether Watch",
            },
        });
        return Page();
    }
}
