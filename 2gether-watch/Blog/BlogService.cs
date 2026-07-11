using System.Globalization;
using Markdig;

namespace _2gether_watch.Blog;

/// <summary>
/// Loads blog posts from flat Markdown files with front-matter. Posts are read once,
/// on first access, and cached for the process lifetime — no file-watcher, restart to
/// pick up new files.
/// </summary>
public sealed class BlogService
{
    private readonly Lazy<List<BlogPost>> _posts;

    public BlogService(string contentDirectory)
    {
        _posts = new Lazy<List<BlogPost>>(() => LoadAll(contentDirectory));
    }

    /// <summary>Published posts whose date has arrived, newest first. Powers the index page and sitemap.</summary>
    public IReadOnlyList<BlogPost> GetAll()
    {
        var today = DateOnly.FromDateTime(DateTime.UtcNow);
        return _posts.Value.Where(p => p.Published && p.Date <= today).ToList();
    }

    /// <summary>Looks up a post by slug regardless of published/date — lets scheduled posts be reviewed at their direct URL.</summary>
    public BlogPost? GetBySlug(string slug) =>
        _posts.Value.FirstOrDefault(p => string.Equals(p.Slug, slug, StringComparison.OrdinalIgnoreCase));

    private static List<BlogPost> LoadAll(string contentDirectory)
    {
        if (!Directory.Exists(contentDirectory))
            return [];

        return Directory.EnumerateFiles(contentDirectory, "*.md")
            .Select(ParsePost)
            .OrderByDescending(p => p.Date)
            .ToList();
    }

    private static BlogPost ParsePost(string path)
    {
        var slug = Path.GetFileNameWithoutExtension(path);
        var lines = File.ReadAllLines(path);

        if (lines.Length == 0 || lines[0].Trim() != "---")
            throw new InvalidOperationException($"Blog post '{slug}' is missing front-matter.");

        var fields = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        var i = 1;
        for (; i < lines.Length && lines[i].Trim() != "---"; i++)
        {
            var sep = lines[i].IndexOf(':');
            if (sep < 0) continue;
            fields[lines[i][..sep].Trim()] = lines[i][(sep + 1)..].Trim();
        }

        var bodyMarkdown = string.Join('\n', lines.Skip(i + 1)).Trim();

        return new BlogPost(
            Slug: slug,
            Title: fields.GetValueOrDefault("title", slug),
            Description: fields.GetValueOrDefault("description", ""),
            Keyword: fields.GetValueOrDefault("keyword", ""),
            Date: DateOnly.ParseExact(fields.GetValueOrDefault("date", "1970-01-01"), "yyyy-MM-dd", CultureInfo.InvariantCulture),
            Published: bool.Parse(fields.GetValueOrDefault("published", "false")),
            Body: Markdown.ToHtml(bodyMarkdown));
    }
}
