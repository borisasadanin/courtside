import Foundation
import Security
#if canImport(UIKit)
import UIKit
#endif

/// What a camera needs to know to reach its club's installation.
struct PairingCredentials: Equatable {
    let apiUrl: String
    let token: String
    let clubName: String
}

/// What an admin's QR code contains: a `courtside-camera://pair` link, or the
/// JSON that platforms before v0.3.3 show.
struct PairingPayload: Decodable {
    let v: Int
    let apiUrl: String
    let code: String
}

private struct PairResponse: Decodable {
    let deviceId: String
    let name: String
    let token: String
    let club: String
}

enum PairingError: LocalizedError {
    case malformedCode
    case rejected(String)
    case unreachable

    var errorDescription: String? {
        switch self {
        case .malformedCode:
            return "Koden ser inte ut som en parningskod."
        case .rejected(let message):
            return message
        case .unreachable:
            return "Kunde inte nå klubbens server. Kontrollera adressen och nätverket."
        }
    }
}

/// Where the pairing lives.
///
/// Nothing about a club is compiled into the app — that is what lets one build
/// from the App Store serve every club. The token is a credential, so it goes
/// in the Keychain rather than UserDefaults.
///
/// Deliberately not main-actor isolated: network calls read it from background
/// tasks, and a main-actor hop on every request would be noise. A lock
/// serialises access instead.
final class PairingStore: @unchecked Sendable {
    static let shared = PairingStore()

    private let lock = NSLock()
    private var cached: PairingCredentials?

    private let service = "se.courtside.camera"
    private let account = "pairing"
    private let urlKey = "courtside_api_url"
    private let clubKey = "courtside_club_name"

    private init() {
        cached = loadFromDisk()
    }

    var credentials: PairingCredentials? {
        lock.lock()
        defer { lock.unlock() }
        return cached
    }

    func set(_ creds: PairingCredentials) {
        lock.lock()
        defer { lock.unlock() }
        UserDefaults.standard.set(creds.apiUrl, forKey: urlKey)
        UserDefaults.standard.set(creds.clubName, forKey: clubKey)
        writeToken(creds.token)
        cached = creds
    }

    func setClubName(_ name: String) {
        lock.lock()
        defer { lock.unlock() }
        guard let current = cached, current.clubName != name else { return }
        UserDefaults.standard.set(name, forKey: clubKey)
        cached = PairingCredentials(apiUrl: current.apiUrl, token: current.token, clubName: name)
    }

    func clear() {
        lock.lock()
        defer { lock.unlock() }
        deleteToken()
        UserDefaults.standard.removeObject(forKey: urlKey)
        UserDefaults.standard.removeObject(forKey: clubKey)
        cached = nil
    }

    // MARK: - Disk

    private func loadFromDisk() -> PairingCredentials? {
        guard let apiUrl = UserDefaults.standard.string(forKey: urlKey),
              let token = readToken()
        else { return nil }
        let club = UserDefaults.standard.string(forKey: clubKey) ?? "Courtside"
        return PairingCredentials(apiUrl: apiUrl, token: token, clubName: club)
    }

    // MARK: - Keychain

    private func baseQuery() -> [String: Any] {
        [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
        ]
    }

    private func readToken() -> String? {
        var query = baseQuery()
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne

        var item: CFTypeRef?
        guard SecItemCopyMatching(query as CFDictionary, &item) == errSecSuccess,
              let data = item as? Data
        else { return nil }
        return String(data: data, encoding: .utf8)
    }

    private func writeToken(_ token: String) {
        deleteToken()
        var query = baseQuery()
        query[kSecValueData as String] = Data(token.utf8)
        // The camera only broadcasts while someone is holding it, and the token
        // is useless off this device, so unlocked-on-this-device is the right
        // trade between safety and not blocking a parent mid-match.
        query[kSecAttrAccessible as String] = kSecAttrAccessibleWhenUnlockedThisDeviceOnly
        SecItemAdd(query as CFDictionary, nil)
    }

    private func deleteToken() {
        SecItemDelete(baseQuery() as CFDictionary)
    }
}

/// SwiftUI-facing wrapper: drives the pairing screen and performs pairing.
@MainActor
final class Pairing: ObservableObject {
    static let shared = Pairing()

    @Published private(set) var credentials: PairingCredentials?

    /// Why the camera is back at the pairing screen, when it did not choose to be.
    @Published private(set) var lostMessage: String?

    /// A pairing link opened from outside the app — the phone's own camera —
    /// waiting for the pairing screen to redeem it.
    @Published var incoming: PairingPayload?

    /// Why an opened pairing link was not used.
    @Published var linkNotice: String?

    /// Set while a broadcast is running. Losing the pairing then waits until the
    /// broadcast ends: the picture keeps flowing without the club's API, and
    /// cutting a match off is worse than a camera staying paired a little longer.
    private var broadcasting = false
    private var lostWhileBroadcasting = false

    private init() {
        credentials = PairingStore.shared.credentials
    }

    var isPaired: Bool { credentials != nil }

    /// The phone's camera, or another app, opened a pairing link.
    ///
    /// A paired camera does not switch club on a scan: that would cut it off
    /// from its own club by mistake. Disconnecting first is a deliberate step.
    func open(_ url: URL) {
        guard let parsed = Self.parse(payload: url.absoluteString) else {
            linkNotice = PairingError.malformedCode.errorDescription
            return
        }
        if let club = credentials?.clubName {
            linkNotice = "Kameran är redan kopplad till \(club). Koppla bort den under inställningar om den ska byta klubb, och skanna sedan koden igen."
            return
        }
        incoming = parsed
    }

    /// Parse a scanned QR payload, or a pasted one.
    static func parse(payload: String) -> PairingPayload? {
        if let url = URL(string: payload), url.scheme == "courtside-camera" {
            let items = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems ?? []
            guard url.host == "pair",
                  let apiUrl = items.first(where: { $0.name == "url" })?.value, !apiUrl.isEmpty,
                  let code = items.first(where: { $0.name == "code" })?.value, !code.isEmpty
            else { return nil }
            return PairingPayload(v: 1, apiUrl: apiUrl, code: code)
        }
        guard let data = payload.data(using: .utf8),
              let parsed = try? JSONDecoder().decode(PairingPayload.self, from: data),
              parsed.v == 1,
              !parsed.apiUrl.isEmpty, !parsed.code.isEmpty
        else { return nil }
        return parsed
    }

    /// Redeem a code at the given installation and remember the result.
    func pair(apiUrl rawUrl: String, code rawCode: String, deviceName: String) async throws {
        let apiUrl = rawUrl
            .trimmingCharacters(in: .whitespacesAndNewlines)
            .replacingOccurrences(of: "/+$", with: "", options: .regularExpression)
        let code = rawCode.trimmingCharacters(in: .whitespacesAndNewlines).uppercased()

        guard !code.isEmpty, let url = URL(string: "\(apiUrl)/api/devices/pair") else {
            throw PairingError.malformedCode
        }

        var request = URLRequest(url: url, timeoutInterval: 15)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try JSONEncoder().encode([
            "code": code,
            "name": deviceName.isEmpty ? defaultDeviceName() : deviceName,
        ])

        let data: Data
        let response: URLResponse
        do {
            (data, response) = try await URLSession.shared.data(for: request)
        } catch {
            throw PairingError.unreachable
        }

        guard let http = response as? HTTPURLResponse else { throw PairingError.unreachable }

        guard (200...299).contains(http.statusCode) else {
            let message = (try? JSONDecoder().decode(APIErrorResponse.self, from: data))?.message
            throw PairingError.rejected(message ?? "Parningen avvisades.")
        }

        let result = try JSONDecoder().decode(PairResponse.self, from: data)
        Club.shared.forget()
        lostMessage = nil
        let creds = PairingCredentials(apiUrl: apiUrl, token: result.token, clubName: result.club)
        PairingStore.shared.set(creds)
        credentials = creds
    }

    /// Forget this club and return to a freshly installed state. The camera
    /// revokes its own token if the club can be reached; if not, the admin view
    /// can still revoke it.
    func unpair() async {
        await APIService.shared.revokeOwnToken()
        reset()
    }

    /// The club answered that it no longer knows this camera: the admin removed
    /// it, or the platform was rebuilt. Back to the pairing screen, with a word
    /// on why.
    func lost() {
        guard credentials != nil else { return }
        if broadcasting {
            lostWhileBroadcasting = true
            return
        }
        let club = credentials?.clubName ?? "klubben"
        reset()
        lostMessage = "Kameran är inte längre kopplad till \(club). Be klubbens admin om en ny kod."
    }

    func broadcastStarted() {
        broadcasting = true
    }

    func broadcastEnded() {
        broadcasting = false
        if lostWhileBroadcasting {
            lostWhileBroadcasting = false
            lost()
        }
    }

    /// The club renamed itself in the admin view.
    func updateClubName(_ name: String) {
        PairingStore.shared.setClubName(name)
        credentials = PairingStore.shared.credentials
    }

    private func reset() {
        PairingStore.shared.clear()
        Club.shared.forget()
        for key in ["courtside_last_name", "courtside_last_opponent", "courtside_last_team"] {
            UserDefaults.standard.removeObject(forKey: key)
        }
        credentials = nil
    }
}

/// A readable default camera name, so the club's device list means something.
@MainActor
private func defaultDeviceName() -> String {
    #if canImport(UIKit)
    return UIDevice.current.name
    #else
    return "Kamera"
    #endif
}
