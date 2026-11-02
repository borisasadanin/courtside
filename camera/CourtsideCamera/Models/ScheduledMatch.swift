import Foundation

/// A match the club's admin has put in the schedule, from `GET /api/matches`.
///
/// Decoded leniently: only what the start screen shows is required, and a
/// newer platform may send fields this build does not know about.
struct ScheduledMatch: Decodable, Identifiable, Equatable {
    struct Team: Decodable, Equatable {
        let name: String
        let shortName: String?
    }

    let id: String
    /// "YYYY-MM-DD", the club's local date.
    let date: String
    /// "HH:MM". A match without a time goes on all day.
    let time: String?
    let venue: String?
    let ownTeam: Team
    let opponent: Team
    /// "planned", "live" or "ended". Missing counts as planned.
    let status: String?

    var isLive: Bool { status == "live" }
    var hasEnded: Bool { status == "ended" }

    /// Today's date in the form the schedule uses.
    static func day(_ date: Date = Date()) -> String {
        let formatter = DateFormatter()
        formatter.calendar = Calendar(identifier: .gregorian)
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.timeZone = .current
        formatter.dateFormat = "yyyy-MM-dd"
        return formatter.string(from: date)
    }
}

/// One element of a list that is skipped, rather than failing the whole list,
/// when it cannot be decoded.
struct Lossy<Wrapped: Decodable>: Decodable {
    let value: Wrapped?

    init(from decoder: Decoder) throws {
        value = try? Wrapped(from: decoder)
    }
}
