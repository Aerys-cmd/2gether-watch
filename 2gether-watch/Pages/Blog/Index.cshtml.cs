using _2gether_watch.Blog;
using Microsoft.AspNetCore.Mvc.RazorPages;

namespace _2gether_watch.Pages.Blog;

public class IndexModel(BlogService blogService) : PageModel
{
    public IReadOnlyList<BlogPost> Posts { get; private set; } = [];

    public void OnGet()
    {
        Posts = blogService.GetAll();
    }
}
