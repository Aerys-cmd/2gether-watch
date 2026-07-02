using _2gether_watch.Rooms;
using Microsoft.AspNetCore.Hosting.StaticWebAssets;


var builder = WebApplication.CreateBuilder(args);

// When the app runs from source (for example via dotnet run or test harnesses),
// explicitly enable static web assets so JS/CSS from wwwroot are resolved.
StaticWebAssetsLoader.UseStaticWebAssets(builder.Environment, builder.Configuration);


// Add services to the container.
builder.Services.AddRazorPages();

builder.Services.AddSingleton<RoomManager>();

builder.Services.AddOptions<SaySiftOptions>()
    .Bind(builder.Configuration.GetSection(SaySiftOptions.SectionName));

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
