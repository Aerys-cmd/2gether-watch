using _2gether_watch.Blog;
using Xunit;

namespace _2gether_watch.Tests;

public class BlogServiceTests : IDisposable
{
    private readonly string _dir = Directory.CreateTempSubdirectory().FullName;

    private void WritePost(string slug, string title, string description, string keyword,
        string date, bool published, string body)
    {
        File.WriteAllText(Path.Combine(_dir, $"{slug}.md"),
            $"""
             ---
             title: {title}
             description: {description}
             keyword: {keyword}
             date: {date}
             published: {published.ToString().ToLowerInvariant()}
             ---

             {body}
             """);
    }

    private BlogService CreateService() => new(_dir);

    [Fact]
    public void ParsesFrontMatterAndRendersMarkdown()
    {
        WritePost("hello-world", "Hello World", "A test post", "test keyword",
            "2020-01-01", published: true,
            body: "# Heading\n\nSome **bold** text.\n\n| A | B |\n|---|---|\n| 1 | 2 |");

        var post = CreateService().GetBySlug("hello-world");

        Assert.NotNull(post);
        Assert.Equal("hello-world", post!.Slug);
        Assert.Equal("Hello World", post.Title);
        Assert.Equal("A test post", post.Description);
        Assert.Equal("test keyword", post.Keyword);
        Assert.Equal(new DateOnly(2020, 1, 1), post.Date);
        Assert.Contains(">Heading</h1>", post.Body);
        Assert.Contains("<strong>bold</strong>", post.Body);
        Assert.Contains("<table>", post.Body);
    }

    [Fact]
    public void GetBySlug_UnknownSlug_ReturnsNull()
    {
        Assert.Null(CreateService().GetBySlug("does-not-exist"));
    }

    [Fact]
    public void GetAll_ExcludesUnpublished_ButGetBySlugStillResolvesIt()
    {
        WritePost("draft-post", "Draft", "Not ready yet", "kw",
            "2020-01-01", published: false, body: "Draft body.");

        var service = CreateService();

        Assert.DoesNotContain(service.GetAll(), p => p.Slug == "draft-post");
        Assert.NotNull(service.GetBySlug("draft-post"));
    }

    [Fact]
    public void GetAll_ExcludesFutureDatedPost_ButGetBySlugStillResolvesIt()
    {
        var futureDate = DateOnly.FromDateTime(DateTime.UtcNow.AddDays(30)).ToString("yyyy-MM-dd");
        WritePost("future-post", "Future", "Scheduled", "kw",
            futureDate, published: true, body: "Scheduled body.");

        var service = CreateService();

        Assert.DoesNotContain(service.GetAll(), p => p.Slug == "future-post");
        Assert.NotNull(service.GetBySlug("future-post"));
    }

    public void Dispose() => Directory.Delete(_dir, recursive: true);
}
