import Foundation

/// Structured error response from the backend
struct APIErrorResponse: Decodable {
    let error: String
    let message: String?
}

enum APIError: LocalizedError {
    case invalidResponse
    case serverError(Int, String?)
    case restreamerNotReady(String)
    case decodingError

    var errorDescription: String? {
        switch self {
        case .invalidResponse: return "Ogiltigt svar från servern"
        case .serverError(let code, let message): return message ?? "Serverfel: \(code)"
        case .restreamerNotReady(let message): return message
        case .decodingError: return "Kunde inte tolka svaret"
        }
    }
}

final class APIService {
    static let shared = APIService()

    private let baseURL: String = {
        guard let url = Bundle.main.infoDictionary?["BASE_URL"] as? String, !url.isEmpty else {
            fatalError("BASE_URL not set — check Config.xcconfig")
        }
        return url
    }()
    private let apiKey: String = {
        guard let key = Bundle.main.infoDictionary?["API_KEY"] as? String, !key.isEmpty else {
            fatalError("API_KEY not set — check Config.xcconfig")
        }
        return key
    }()
    /// Public website for this installation. Optional — used only for the
    /// health indicator, so an unset value simply disables that check.
    private let websiteURL: String = {
        (Bundle.main.infoDictionary?["SITE_URL"] as? String) ?? ""
    }()

    private let deviceId: String = {
        let key = "courtside_device_id"
        if let existing = UserDefaults.standard.string(forKey: key) {
            return existing
        }
        let id = UUID().uuidString
        UserDefaults.standard.set(id, forKey: key)
        return id
    }()

    private init() {}

    func createStream(name: String, opponent: String = "", team: String = "") async throws -> StreamInfo {
        let url = URL(string: "\(baseURL)/api/streams")!
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue(apiKey, forHTTPHeaderField: "X-API-Key")
        var body: [String: String] = ["name": name, "deviceId": deviceId]
        if !opponent.isEmpty { body["opponent"] = opponent }
        if !team.isEmpty { body["team"] = team }
        request.httpBody = try JSONEncoder().encode(body)

        let (data, response) = try await URLSession.shared.data(for: request)

        guard let http = response as? HTTPURLResponse else {
            throw APIError.invalidResponse
        }
        guard (200...299).contains(http.statusCode) else {
            // Try to parse structured error from backend
            if let errorResponse = try? JSONDecoder().decode(APIErrorResponse.self, from: data) {
                if errorResponse.error == "restreamer_not_ready" {
                    throw APIError.restreamerNotReady(errorResponse.message ?? "Restreamer är inte redo")
                }
                throw APIError.serverError(http.statusCode, errorResponse.message)
            }
            throw APIError.serverError(http.statusCode, nil)
        }

        guard let stream = try? JSONDecoder().decode(StreamInfo.self, from: data) else {
            throw APIError.decodingError
        }
        return stream
    }

    func deleteStream(id: String) async throws {
        let url = URL(string: "\(baseURL)/api/streams/\(id)")!
        var request = URLRequest(url: url)
        request.httpMethod = "DELETE"
        request.setValue(apiKey, forHTTPHeaderField: "X-API-Key")

        let (data, response) = try await URLSession.shared.data(for: request)

        guard let http = response as? HTTPURLResponse else {
            throw APIError.invalidResponse
        }
        guard (200...299).contains(http.statusCode) else {
            if let errorResponse = try? JSONDecoder().decode(APIErrorResponse.self, from: data) {
                throw APIError.serverError(http.statusCode, errorResponse.message)
            }
            throw APIError.serverError(http.statusCode, nil)
        }
    }

    // MARK: - Pause / Resume

    struct PauseResponse: Decodable {
        let status: String
        let pausedAt: String
    }

    func pauseStream(id: String) async throws -> PauseResponse {
        let url = URL(string: "\(baseURL)/api/streams/\(id)/pause")!
        var request = URLRequest(url: url)
        request.httpMethod = "PATCH"
        request.setValue(apiKey, forHTTPHeaderField: "X-API-Key")

        let (data, response) = try await URLSession.shared.data(for: request)

        guard let http = response as? HTTPURLResponse else {
            throw APIError.invalidResponse
        }
        guard (200...299).contains(http.statusCode) else {
            if let errorResponse = try? JSONDecoder().decode(APIErrorResponse.self, from: data) {
                throw APIError.serverError(http.statusCode, errorResponse.message)
            }
            throw APIError.serverError(http.statusCode, nil)
        }

        guard let result = try? JSONDecoder().decode(PauseResponse.self, from: data) else {
            throw APIError.decodingError
        }
        return result
    }

    struct ResumeResponse: Decodable {
        let status: String
        let rtmpUrl: String
        let partNumber: Int
    }

    func resumeStream(id: String) async throws -> ResumeResponse {
        let url = URL(string: "\(baseURL)/api/streams/\(id)/resume")!
        var request = URLRequest(url: url)
        request.httpMethod = "PATCH"
        request.setValue(apiKey, forHTTPHeaderField: "X-API-Key")

        let (data, response) = try await URLSession.shared.data(for: request)

        guard let http = response as? HTTPURLResponse else {
            throw APIError.invalidResponse
        }
        guard (200...299).contains(http.statusCode) else {
            if let errorResponse = try? JSONDecoder().decode(APIErrorResponse.self, from: data) {
                if errorResponse.error == "restreamer_not_ready" {
                    throw APIError.restreamerNotReady(errorResponse.message ?? "Restreamer är inte redo")
                }
                throw APIError.serverError(http.statusCode, errorResponse.message)
            }
            throw APIError.serverError(http.statusCode, nil)
        }

        guard let result = try? JSONDecoder().decode(ResumeResponse.self, from: data) else {
            throw APIError.decodingError
        }
        return result
    }

    func getStream(id: String) async throws -> StreamStatus {
        let url = URL(string: "\(baseURL)/api/streams/\(id)")!
        var request = URLRequest(url: url)
        request.setValue(apiKey, forHTTPHeaderField: "X-API-Key")
        let (data, response) = try await URLSession.shared.data(for: request)

        guard let http = response as? HTTPURLResponse else {
            throw APIError.invalidResponse
        }
        guard (200...299).contains(http.statusCode) else {
            if let errorResponse = try? JSONDecoder().decode(APIErrorResponse.self, from: data) {
                throw APIError.serverError(http.statusCode, errorResponse.message)
            }
            throw APIError.serverError(http.statusCode, nil)
        }

        guard let status = try? JSONDecoder().decode(StreamStatus.self, from: data) else {
            throw APIError.decodingError
        }
        return status
    }

    func sendViewerHeartbeat(streamId: String) async {
        guard let url = URL(string: "\(baseURL)/api/streams/\(streamId)/view") else { return }
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        _ = try? await URLSession.shared.data(for: request)
    }

    // MARK: - Highlight Clips

    struct ClipResponse: Decodable {
        let id: String
        let streamId: String
        let hlsUrl: String
        let durationSeconds: Double
        let createdAt: String
        let label: String?
    }

    func createClip(streamId: String, timestamp: String, label: String? = nil) async throws -> ClipResponse {
        let url = URL(string: "\(baseURL)/api/streams/\(streamId)/clip")!
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue(apiKey, forHTTPHeaderField: "X-API-Key")
        var body: [String: String] = ["timestamp": timestamp]
        if let label { body["label"] = label }
        request.httpBody = try JSONEncoder().encode(body)

        let (data, response) = try await URLSession.shared.data(for: request)

        guard let http = response as? HTTPURLResponse else {
            throw APIError.invalidResponse
        }
        guard (200...299).contains(http.statusCode) else {
            if let errorResponse = try? JSONDecoder().decode(APIErrorResponse.self, from: data) {
                throw APIError.serverError(http.statusCode, errorResponse.message)
            }
            throw APIError.serverError(http.statusCode, nil)
        }

        guard let result = try? JSONDecoder().decode(ClipResponse.self, from: data) else {
            throw APIError.decodingError
        }
        return result
    }

    // MARK: - Broadcast State

    struct BroadcastStateResponse: Decodable {
        let status: String
        let message: String?
        let updatedAt: String
    }

    func setBroadcastState(status: String, message: String? = nil) async throws -> BroadcastStateResponse {
        let url = URL(string: "\(baseURL)/api/broadcast")!
        var request = URLRequest(url: url)
        request.httpMethod = "PATCH"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue(apiKey, forHTTPHeaderField: "X-API-Key")
        var body: [String: String] = ["status": status]
        if let message { body["message"] = message }
        request.httpBody = try JSONEncoder().encode(body)

        let (data, response) = try await URLSession.shared.data(for: request)

        guard let http = response as? HTTPURLResponse else {
            throw APIError.invalidResponse
        }
        guard (200...299).contains(http.statusCode) else {
            if let errorResponse = try? JSONDecoder().decode(APIErrorResponse.self, from: data) {
                throw APIError.serverError(http.statusCode, errorResponse.message)
            }
            throw APIError.serverError(http.statusCode, nil)
        }

        guard let result = try? JSONDecoder().decode(BroadcastStateResponse.self, from: data) else {
            throw APIError.decodingError
        }
        return result
    }

    // MARK: - System Health Checks

    func checkBackendHealth() async -> Bool {
        guard let url = URL(string: "\(baseURL)/health") else { return false }
        let request = URLRequest(url: url, timeoutInterval: 5)
        guard let (_, response) = try? await URLSession.shared.data(for: request) else { return false }
        guard let http = response as? HTTPURLResponse else { return false }
        return http.statusCode == 200
    }

    struct RestreamerStatus: Decodable {
        let state: String
    }

    func checkRestreamerStatus() async -> String? {
        guard let url = URL(string: "\(baseURL)/api/restreamer/status") else { return nil }
        var request = URLRequest(url: url, timeoutInterval: 5)
        request.setValue(apiKey, forHTTPHeaderField: "X-API-Key")
        guard let (data, response) = try? await URLSession.shared.data(for: request) else { return nil }
        guard let http = response as? HTTPURLResponse, http.statusCode == 200 else { return nil }
        guard let status = try? JSONDecoder().decode(RestreamerStatus.self, from: data) else { return nil }
        return status.state
    }

    struct RestreamerStartResponse: Decodable {
        let state: String
        let message: String?
    }

    /// Triggers Restreamer start on the backend (non-blocking).
    /// Returns the state and a Swedish status message.
    func startRestreamer() async -> RestreamerStartResponse? {
        guard let url = URL(string: "\(baseURL)/api/restreamer/start") else { return nil }
        var request = URLRequest(url: url, timeoutInterval: 10)
        request.httpMethod = "POST"
        request.setValue(apiKey, forHTTPHeaderField: "X-API-Key")
        guard let (data, response) = try? await URLSession.shared.data(for: request),
              let http = response as? HTTPURLResponse, http.statusCode == 200 else { return nil }
        return try? JSONDecoder().decode(RestreamerStartResponse.self, from: data)
    }

    func stopRestreamer() async -> Bool {
        guard let url = URL(string: "\(baseURL)/api/restreamer/stop") else { return false }
        var request = URLRequest(url: url, timeoutInterval: 10)
        request.httpMethod = "DELETE"
        request.setValue(apiKey, forHTTPHeaderField: "X-API-Key")
        guard let (_, response) = try? await URLSession.shared.data(for: request),
              let http = response as? HTTPURLResponse else { return false }
        return (200...299).contains(http.statusCode)
    }

    func checkWebsiteHealth() async -> Bool {
        guard !websiteURL.isEmpty, let url = URL(string: websiteURL) else { return false }
        var request = URLRequest(url: url, timeoutInterval: 5)
        request.httpMethod = "HEAD"
        guard let (_, response) = try? await URLSession.shared.data(for: request) else { return false }
        guard let http = response as? HTTPURLResponse else { return false }
        return (200...399).contains(http.statusCode)
    }
}
