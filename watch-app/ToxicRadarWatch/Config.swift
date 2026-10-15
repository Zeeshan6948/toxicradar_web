import Foundation

/// Change `serverURL` to your deployed ToxicRadar address (must be https).
enum Config {
    static let serverURL = "https://YOUR-APP.onrender.com"
    /// How often a reading is uploaded while monitoring.
    static let uploadIntervalSeconds: UInt64 = 5
    /// How often HRV / resting heart rate are refreshed from HealthKit.
    static let slowMetricsRefreshSeconds: TimeInterval = 60
}
