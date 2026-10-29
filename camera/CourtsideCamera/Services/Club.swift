import SwiftUI

/// Sport terminology from the club's manifest.
struct SportProfile: Codable, Equatable {
    var periodBreakLabel: String
    var timeoutLabel: String
    var clipDurationSeconds: Double?

    static let fallback = SportProfile(periodBreakLabel: "Periodpaus", timeoutLabel: "Timeout")
}

/// The public part of a club's installation, from `GET /api/club`.
///
/// Every field is optional on the wire: one App Store build talks to clubs on
/// different releases, and an older one may lack a field a newer one has.
struct ClubManifest: Codable, Equatable {
    var name: String?
    var shortName: String?
    var venue: String?
    var accentColor: String?
    var logoUrl: String?
    var siteUrl: String?
    var sport: SportProfile?
}

/// What the camera knows about the club it is paired with.
///
/// Fetched after pairing and on every visit to the start screen, so a new name,
/// colour or logo set in the admin view shows up without pairing again. The
/// last copy is kept, so the screen looks right before the network answers.
@MainActor
final class Club: ObservableObject {
    static let shared = Club()

    /// Oldest platform release this build works with. Before v0.3.0 a paired
    /// camera could not start the broadcast engine.
    static let minimumPlatformVersion = "0.3.0"

    @Published private(set) var manifest: ClubManifest?

    private let cacheKey = "courtside_club_manifest"

    private init() {
        if let data = UserDefaults.standard.data(forKey: cacheKey) {
            manifest = try? JSONDecoder().decode(ClubManifest.self, from: data)
        }
    }

    var name: String {
        nonEmpty(manifest?.name) ?? Pairing.shared.credentials?.clubName ?? "Courtside"
    }

    var accent: Color {
        Color(hex: manifest?.accentColor ?? "") ?? Color(red: 200/255, green: 164/255, blue: 63/255)
    }

    /// Text colour that stays readable on the accent, whichever colour the club chose.
    var onAccent: Color { accent.prefersDarkText ? .black : .white }

    var sport: SportProfile { manifest?.sport ?? .fallback }

    /// Default home team for a new recording.
    var homeTeam: String { nonEmpty(manifest?.shortName) ?? name }

    /// The club's logo, resolved against its installation. Nil when it has none.
    var logoURL: URL? {
        guard let raw = nonEmpty(manifest?.logoUrl) else { return nil }
        if raw.hasPrefix("http") { return URL(string: raw) }
        guard let base = Pairing.shared.credentials?.apiUrl else { return nil }
        return URL(string: base + (raw.hasPrefix("/") ? raw : "/" + raw))
    }

    /// The viewers' page. It is served by the installation itself unless the
    /// club hosts it somewhere else.
    var siteURL: URL? {
        URL(string: nonEmpty(manifest?.siteUrl) ?? Pairing.shared.credentials?.apiUrl ?? "")
    }

    func refresh() async {
        guard let fresh = await APIService.shared.fetchClub() else { return }
        manifest = fresh
        if let data = try? JSONEncoder().encode(fresh) {
            UserDefaults.standard.set(data, forKey: cacheKey)
        }
        if let name = nonEmpty(fresh.name) {
            Pairing.shared.updateClubName(name)
        }
    }

    func forget() {
        manifest = nil
        UserDefaults.standard.removeObject(forKey: cacheKey)
    }

    /// Whether a platform reporting `version` is new enough. Releases before
    /// v0.2.0 did not report one. A version that is not a number (a local
    /// build reports "unknown") gets the benefit of the doubt.
    static func supports(platformVersion version: String?) -> Bool {
        guard let version else { return false }
        guard version.trimmingCharacters(in: CharacterSet(charactersIn: "v")).first?.isNumber == true else {
            return true
        }
        return compare(version, minimumPlatformVersion) != .orderedAscending
    }

    private static func compare(_ a: String, _ b: String) -> ComparisonResult {
        let parts = { (s: String) in
            s.trimmingCharacters(in: CharacterSet(charactersIn: "v"))
                .split(separator: ".").map { Int($0) ?? 0 }
        }
        let (x, y) = (parts(a), parts(b))
        for i in 0..<max(x.count, y.count) {
            let (l, r) = (i < x.count ? x[i] : 0, i < y.count ? y[i] : 0)
            if l != r { return l < r ? .orderedAscending : .orderedDescending }
        }
        return .orderedSame
    }

    private func nonEmpty(_ s: String?) -> String? {
        guard let s = s?.trimmingCharacters(in: .whitespaces), !s.isEmpty else { return nil }
        return s
    }
}

extension Color {
    /// A CSS hex colour: "#RGB" or "#RRGGBB", with or without the "#".
    init?(hex: String) {
        var s = hex.trimmingCharacters(in: .whitespaces)
        if s.hasPrefix("#") { s.removeFirst() }
        if s.count == 3 { s = s.map { "\($0)\($0)" }.joined() }
        guard s.count == 6, let value = UInt32(s, radix: 16) else { return nil }
        self.init(
            red: Double((value >> 16) & 0xFF) / 255,
            green: Double((value >> 8) & 0xFF) / 255,
            blue: Double(value & 0xFF) / 255
        )
    }

    /// True when black text reads better than white on this colour.
    var prefersDarkText: Bool {
        var r: CGFloat = 0, g: CGFloat = 0, b: CGFloat = 0, a: CGFloat = 0
        guard UIColor(self).getRed(&r, green: &g, blue: &b, alpha: &a) else { return true }
        let linear = { (c: CGFloat) -> CGFloat in
            c <= 0.03928 ? c / 12.92 : pow((c + 0.055) / 1.055, 2.4)
        }
        let luminance = 0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b)
        // Contrast against black beats contrast against white above ~0.18.
        return luminance > 0.179
    }
}
