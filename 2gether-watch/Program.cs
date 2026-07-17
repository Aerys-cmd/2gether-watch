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

// Traffic flows Cloudflare -> Traefik -> app (two+ proxy hops). KnownNetworks/KnownProxies
// are already cleared below (trust the whole chain), so cap ForwardLimit at a fixed hop
// count buys no extra security and just re-breaks if a hop is ever added — leave it
// unlimited. This fixes canonical/og/sitemap URL scheme; it does not force any redirect,
// so if X-Forwarded-Proto ever arrives in an unexpected shape the worst case is URLs
// stay http, same as before this change — never a redirect loop.
var forwardedHeadersOptions = new ForwardedHeadersOptions
{
    ForwardedHeaders = ForwardedHeaders.XForwardedFor | ForwardedHeaders.XForwardedProto,
    ForwardLimit = null,
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

// HTTP->HTTPS redirect is handled at the Cloudflare edge ("Always Use HTTPS"), not here.
// Kestrel only binds http://+:8080 (TLS terminates upstream), so an app-layer
// UseHttpsRedirection() has no real https port to target — and if Request.Scheme ever
// fails to resolve to "https" for a genuinely-https request, redirecting here would
// 307-loop every page load and the /ws WebSocket upgrade. The edge redirect keys off the
// client's actual connection scheme, so it can't loop.

app.Use(async (context, next) =>
{
    var headers = context.Response.Headers;
    headers.XContentTypeOptions = "nosniff";
    headers.XFrameOptions = "DENY";
    headers["Referrer-Policy"] = "strict-origin-when-cross-origin";
    // Rooms use camera/mic/screen-share themselves (same-origin) but must not grant it to embedders.
    headers["Permissions-Policy"] = "camera=(self), microphone=(self), display-capture=(self)";
    await next();
});

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

app.MapGet("/llms.txt", (HttpContext context, BlogService blog) =>
{
    var baseUrl = $"{context.Request.Scheme}://{context.Request.Host}";
    var text = $"""
        # 2gether Watch

        > Free browser-based watch party app. Sync YouTube or direct video URLs across
        > up to 10 peers with no sign-up, plus optional audio/video calls, live chat, and
        > screen sharing, powered by WebRTC.

        - [Home]({baseUrl}/): Create or join a room
        - [Blog]({baseUrl}/blog): Guides and comparisons
        {string.Join('\n', blog.GetAll().Select(p => $"- [{p.Title}]({baseUrl}/blog/{p.Slug}): {p.Description}"))}
        - [Privacy]({baseUrl}/Privacy): Privacy policy
        """;
    return Results.Text(text, "text/plain");
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
