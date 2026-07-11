public sealed class FeedbackHubOptions
{
    public const string SectionName = "FeedbackHub";
    public string? PublicKey { get; set; } = string.Empty;
    public bool Enabled => !string.IsNullOrEmpty(PublicKey);
}