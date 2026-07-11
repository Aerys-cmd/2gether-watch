namespace _2gether_watch.Blog;

/// <summary>
/// A blog post loaded from a Markdown file with front-matter. <see cref="Keyword"/>
/// is the primary SEO keyword this post targets — used for content-planning notes,
/// never rendered.
/// </summary>
public sealed record BlogPost(
    string Slug,
    string Title,
    string Description,
    string Keyword,
    DateOnly Date,
    bool Published,
    string Body);
