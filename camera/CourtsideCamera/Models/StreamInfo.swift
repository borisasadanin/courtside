import Foundation

struct StreamInfo: Decodable {
    let id: String
    let name: String
    let rtmpUrl: String
    let hlsUrl: String
    let createdAt: String
}

struct StreamStatus: Decodable {
    let id: String
    let name: String
    let hlsUrl: String
    let createdAt: String
    let status: String
    let viewers: Int
}
