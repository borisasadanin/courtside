import Foundation

struct StreamInfo: Decodable {
    let id: String
    let name: String
    let rtmpUrl: String
    let hlsUrl: String
    let createdAt: String
    /// The teams as the recording's card shows them. Missing before platform v0.5.0.
    let homeTeam: String?
    let awayTeam: String?
    /// The scheduled match this recording belongs to. Missing before ABL-048.
    let matchId: String?
}

struct StreamStatus: Decodable {
    let id: String
    let name: String
    let hlsUrl: String
    let createdAt: String
    let status: String
    let viewers: Int
}
