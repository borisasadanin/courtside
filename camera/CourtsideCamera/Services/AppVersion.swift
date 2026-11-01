import Foundation

/// The app's release, as set in project.yml for each release (camera/CHANGELOG.md).
///
/// The version says which features a camera has, so the app shows it under the
/// gear and sends it to the club with every request. The club's admin then sees
/// which version each camera runs.
enum AppVersion {
    /// "1.1.0" — what the changelog and the club talk about.
    static let release = Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "okänd"

    /// Counts every build sent to TestFlight or a phone, whatever its release.
    static let build = Bundle.main.object(forInfoDictionaryKey: "CFBundleVersion") as? String ?? "?"

    static var display: String { "\(release) (\(build))" }

    static let header = "X-Courtside-App-Version"
}
