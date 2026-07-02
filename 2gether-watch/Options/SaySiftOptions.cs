public sealed class SaySiftOptions
{
    public const string SectionName = "SaySift";
    public string? PublicKey { get; set; } = string.Empty;
    public bool Enabled => !string.IsNullOrEmpty(PublicKey);
}