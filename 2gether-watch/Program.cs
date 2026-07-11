using _2gether_watch.Blog;
using _2gether_watch.Rooms;
using Microsoft.AspNetCore.Hosting.StaticWebAssets;


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
    var urls = new List<string> { $"{baseUrl}/", $"{baseUrl}/blog" };
    urls.AddRange(blog.GetAll().Select(p => $"{baseUrl}/blog/{p.Slug}"));

    var xml = "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n" +
              "<urlset xmlns=\"http://www.sitemaps.org/schemas/sitemap/0.9\">\n" +
              string.Concat(urls.Select(u => $"  <url><loc>{u}</loc></url>\n")) +
              "</urlset>";
    return Results.Text(xml, "application/xml");
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
