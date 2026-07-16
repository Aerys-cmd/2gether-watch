using _2gether_watch.Blog;
using _2gether_watch.Rooms;
using Microsoft.AspNetCore.Hosting.StaticWebAssets;
using Microsoft.AspNetCore.HttpOverrides;


var builder = WebApplication.CreateBuilder(args);

// When the app runs from source (for example via dotnet run or test harnesses),
// explicitly enable static web assets so JS/CSS from wwwroot are resolved.
StaticWebAssetsLoader.UseStaticWebAssets(builder.Environment, builder.Configuration);


// Add services to the container.
builder.Services.AddRazorPages();

builder.Services.AddSingleton<RoomManager>();

builder.Services.AddSingleton(_ =>
    new BlogService(Path.Combine(builder.Environment.ContentRootPath, "Content", "blog")));

builder.Services.AddOptions<SaySiftOptions>()
    .Bind(builder.Configuration.GetSection(SaySiftOptions.SectionName));

builder.Services.AddOptions<AnalyticsOptions>()
    .Bind(builder.Configuration.GetSection(AnalyticsOptions.SectionName));

var app = builder.Build();

// Traefik terminates TLS and forwards over the "web" docker network, so the proxy IP
// is dynamic — clear KnownNetworks/KnownProxies to trust its X-Forwarded-* headers.
// Without this, Request.Scheme always reads "http" (Traefik->container hop), which
// leaked http:// into sitemap.xml, canonical, and OG/Twitter meta tags.
var forwardedHeadersOptions = new ForwardedHeadersOptions
{
    ForwardedHeaders = ForwardedHeaders.XForwardedFor | ForwardedHeaders.XForwardedProto,
};
forwardedHeadersOptions.KnownIPNetworks.Clear();
forwardedHeadersOptions.KnownProxies.Clear();
app.UseForwardedHeaders(forwardedHeadersOptions);

// Configure the HTTP request pipeline.
if (!app.Environment.IsDevelopment())
{
    app.UseExceptionHandler("/Error");
    // The default HSTS value is 30 days. You may want to change this for production scenarios, see https://aka.ms/aspnetcore-hsts.
    app.UseHsts();
}

app.UseHttpsRedirection();

app.UseWebSockets();

app.UseRouting();

app.UseAuthorization();

app.MapStaticAssets();

app.MapRazorPages()
    .WithStaticAssets();


app.MapGet("/sitemap.xml", (HttpContext context, BlogService blog) =>
{
    var baseUrl = $"{context.Request.Scheme}://{context.Request.Host}";
    var entries = new List<(string Loc, string? LastMod)> { ($"{baseUrl}/", null), ($"{baseUrl}/blog", null) };
    entries.AddRange(blog.GetAll().Select(p => ($"{baseUrl}/blog/{p.Slug}", (string?)p.Date.ToString("yyyy-MM-dd"))));

    var xml = "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n" +
              "<urlset xmlns=\"http://www.sitemaps.org/schemas/sitemap/0.9\">\n" +
              string.Concat(entries.Select(e => e.LastMod is null
                  ? $"  <url><loc>{e.Loc}</loc></url>\n"
                  : $"  <url><loc>{e.Loc}</loc><lastmod>{e.LastMod}</lastmod></url>\n")) +
              "</urlset>";
    return Results.Text(xml, "application/xml");
});

app.MapGet("/robots.txt", (HttpContext context) =>
{
    var baseUrl = $"{context.Request.Scheme}://{context.Request.Host}";
    return Results.Text($"User-agent: *\nAllow: /\n\nSitemap: {baseUrl}/sitemap.xml\n", "text/plain");
});

app.Map("/ws", async context =>
{
    if (context.WebSockets.IsWebSocketRequest)
    {
        var roomManager = context.RequestServices.GetRequiredService<RoomManager>();
        using var webSocket = await context.WebSockets.AcceptWebSocketAsync();
        await roomManager.HandleConnectionAsync(webSocket);
    }
    else
    {
        context.Response.StatusCode = 400;
    }
});

app.Run();
