using _2gether_watch.Blog;
using Microsoft.AspNetCore.Mvc.RazorPages;

namespace _2gether_watch.Pages.Blog;

public class IndexModel(BlogService blogService) : PageModel
{
    public IReadOnlyList<BlogPost> Posts { get; private set; } = [];
    public string BaseUrl { get; private set; } = string.Empty;

    public void OnGet()
    {
        Posts = blogService.GetAll();
        BaseUrl = $"{Request.Scheme}://{Request.Host}";
    }
}
