public sealed class AnalyticsOptions
{
    public const string SectionName = "GoogleAnalytics";
    public string? MeasurementId { get; set; } = string.Empty;
    public bool Enabled => !string.IsNullOrEmpty(MeasurementId);
}
