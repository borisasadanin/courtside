import SwiftUI

enum ComponentStatus: Equatable {
    case checking
    case healthy
    case starting
    /// Deliberately not running, like a sändningsmotor nobody has started yet.
    case off
    case unhealthy(String)
}

struct StartView: View {
    @Binding var streamInfo: StreamInfo?
    @State private var name = UserDefaults.standard.string(forKey: "courtside_last_name") ?? ""
    @State private var opponent = UserDefaults.standard.string(forKey: "courtside_last_opponent") ?? ""
    @State private var team = UserDefaults.standard.string(forKey: "courtside_last_team")
        ?? Club.shared.homeTeam
    @State private var selectedQuality: StreamQuality = StreamQuality.saved
    @State private var supports1080p = StreamQuality.deviceSupports1080p
    @State private var isLoading = false
    @State private var errorMessage: String?

    @State private var backendStatus: ComponentStatus = .checking
    @State private var restreamerStatus: ComponentStatus = .checking
    @State private var websiteStatus: ComponentStatus = .checking
    @State private var healthCheckTasks: [Task<Void, Never>] = []
    @State private var pollTask: Task<Void, Never>?
    @State private var isStoppingRestreamer = false
    @State private var isStartingRestreamer = false
    @State private var restreamerStartRequestedAt: Date?
    @State private var restreamerShutdownIn: Int?
    @State private var isNotifying = false
    @State private var hasNotified = false
    @State private var showNotifyConfirmation = false
    @State private var showUnpairConfirmation = false
    @State private var isUnpairing = false
    @State private var platformVersion: String?

    @StateObject private var club = Club.shared

    @Environment(\.verticalSizeClass) private var verticalSizeClass

    private var isCompact: Bool { verticalSizeClass == .compact }
    private var logoSize: CGFloat { isCompact ? 50 : 100 }
    private var sectionSpacing: CGFloat { isCompact ? 16 : 32 }
    private var horizontalPad: CGFloat { isCompact ? 20 : 32 }

    /// How often the sändningsmotor is checked while this screen is up; server
    /// and viewers' page, which are always on, every `slowPollEvery` rounds.
    private static let pollInterval: Duration = .seconds(5)
    private static let slowPollEvery = 6

    private var allHealthy: Bool {
        backendStatus == .healthy && restreamerStatus == .healthy && websiteStatus == .healthy
    }

    /// Telling viewers a match is coming only reaches the server, so it does
    /// not have to wait for the sändningsmotor.
    private var canNotify: Bool {
        backendStatus == .healthy
    }

    /// Minutes left before the backend shuts the idle sändningsmotor down.
    private var restreamerShutdownMinutes: Int? {
        restreamerShutdownIn.map { max(1, Int((Double($0) / 60).rounded(.up))) }
    }

    private var restreamerReadyLabel: String {
        restreamerShutdownMinutes.map { "Redo · stängs av om \($0) min" } ?? "Redo"
    }

    private var canStartRestreamer: Bool {
        switch restreamerStatus {
        case .off, .unhealthy: return true
        default: return false
        }
    }

    private var canStart: Bool {
        allHealthy && !name.trimmingCharacters(in: .whitespaces).isEmpty && !isLoading
    }

    var body: some View {
        ZStack(alignment: .topTrailing) {
            Color.black.ignoresSafeArea()

            ScrollView {
            VStack(spacing: sectionSpacing) {
                Spacer(minLength: isCompact ? 8 : 20)

                // Logo + Title
                VStack(spacing: isCompact ? 2 : 4) {
                    ZStack(alignment: .bottom) {
                        ClubLogo(url: club.logoURL)
                            .frame(width: logoSize, height: logoSize)

                        Text("LIVE")
                            .font(.system(size: isCompact ? 8 : 12, weight: .black))
                            .tracking(2)
                            .foregroundColor(.white)
                            .padding(.horizontal, 6)
                            .padding(.vertical, 2)
                            .background(Color.red)
                            .cornerRadius(3)
                            .offset(y: isCompact ? 4 : 6)
                    }

                    Text(club.name.uppercased())
                        .font(isCompact ? .subheadline.bold() : .title2.bold())
                        .foregroundColor(club.accent)
                }

                // System status
                VStack(spacing: 8) {
                    HStack {
                        Text("Systemstatus")
                            .font(.caption.bold())
                            .foregroundColor(.white.opacity(0.6))
                        Spacer()
                        Button {
                            runHealthChecks()
                        } label: {
                            Image(systemName: "arrow.clockwise")
                                .font(.caption)
                                .foregroundColor(club.accent)
                        }
                    }

                    StatusRow(label: "Server", status: backendStatus)
                    StatusRow(label: "Sändningsmotor", status: restreamerStatus, healthyLabel: restreamerReadyLabel)
                    StatusRow(label: "Tittarsida", status: websiteStatus)

                    if let hint = statusHint {
                        Text(hint)
                            .font(.caption2)
                            .foregroundColor(.white.opacity(0.6))
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .padding(.top, 4)
                    }
                }
                .padding(14)
                .background(Color(white: 0.08))
                .cornerRadius(8)
                .padding(.horizontal, horizontalPad)

                // Start/Stop Restreamer button. Starting it is always the
                // user's call: it costs money for as long as it runs.
                if canStartRestreamer {
                    Button {
                        Task { await startRestreamer() }
                    } label: {
                        HStack(spacing: 6) {
                            if isStartingRestreamer {
                                ProgressView()
                                    .scaleEffect(0.7)
                                    .tint(club.onAccent)
                            } else {
                                Image(systemName: "bolt.fill")
                            }
                            Text(isStartingRestreamer ? "Startar..." : "Starta sändningsmotor")
                                .font(.caption)
                        }
                        .frame(maxWidth: .infinity)
                        .padding(10)
                        .background(club.accent.opacity(0.9))
                        .foregroundColor(club.onAccent)
                        .cornerRadius(6)
                    }
                    .disabled(isStartingRestreamer)
                    .padding(.horizontal, horizontalPad)
                } else if restreamerStatus == .healthy {
                    Button {
                        Task { await stopRestreamer() }
                    } label: {
                        HStack(spacing: 6) {
                            if isStoppingRestreamer {
                                ProgressView()
                                    .scaleEffect(0.7)
                                    .tint(.white)
                            } else {
                                Image(systemName: "power")
                            }
                            Text(isStoppingRestreamer ? "Stänger av..." : "Stäng av sändningsmotor")
                                .font(.caption)
                        }
                        .frame(maxWidth: .infinity)
                        .padding(10)
                        .background(Color(white: 0.12))
                        .foregroundColor(.red.opacity(0.8))
                        .cornerRadius(6)
                    }
                    .disabled(isStoppingRestreamer)
                    .padding(.horizontal, horizontalPad)
                }

                // Name + match fields
                VStack(spacing: 12) {
                    // Shown to every viewer as the camera's name, so it asks
                    // for a place rather than a person.
                    TextField("Kameranamn, t.ex. Läktaren", text: $name)
                        .textFieldStyle(.plain)
                        .padding(14)
                        .background(Color(white: 0.12))
                        .cornerRadius(8)
                        .foregroundColor(.white)
                        .autocorrectionDisabled()
                        .textInputAutocapitalization(.sentences)

                    TextField("Hemmalag", text: $team)
                        .textFieldStyle(.plain)
                        .padding(14)
                        .background(Color(white: 0.12))
                        .cornerRadius(8)
                        .foregroundColor(.white)
                        .autocorrectionDisabled()
                        .textInputAutocapitalization(.words)

                    TextField("Motståndarlag", text: $opponent)
                        .textFieldStyle(.plain)
                        .padding(14)
                        .background(Color(white: 0.12))
                        .cornerRadius(8)
                        .foregroundColor(.white)
                        .autocorrectionDisabled()
                        .textInputAutocapitalization(.words)

                    Text("Syns för alla tittare. Skriv inte ditt eget eller spelares fullständiga namn.")
                        .font(.caption)
                        .foregroundColor(.gray)
                        .frame(maxWidth: .infinity, alignment: .leading)

                    if let errorMessage {
                        Text(errorMessage)
                            .font(.caption)
                            .foregroundColor(.red)
                    }
                }
                .padding(.horizontal, horizontalPad)

                // Quality picker
                VStack(spacing: 8) {
                    HStack {
                        Text("Sändningskvalitet")
                            .font(.caption.bold())
                            .foregroundColor(.white.opacity(0.6))
                        Spacer()
                    }

                    HStack(spacing: 8) {
                        ForEach(StreamQuality.allCases) { quality in
                            let isDisabled = quality.requires1080p && !supports1080p
                            Button {
                                selectedQuality = quality
                                quality.save()
                            } label: {
                                VStack(spacing: 4) {
                                    Text(quality.shortLabel)
                                        .font(.caption.bold())
                                    Text(quality.bitrateLabel)
                                        .font(.caption2)
                                        .foregroundColor(
                                            selectedQuality == quality
                                                ? club.onAccent.opacity(0.7)
                                                : .white.opacity(0.4)
                                        )
                                }
                                .frame(maxWidth: .infinity)
                                .padding(.vertical, 10)
                                .background(
                                    selectedQuality == quality
                                        ? club.accent
                                        : Color(white: 0.12)
                                )
                                .foregroundColor(
                                    selectedQuality == quality ? club.onAccent : .white
                                )
                                .cornerRadius(6)
                                .opacity(isDisabled ? 0.4 : 1.0)
                            }
                            .disabled(isDisabled)
                        }
                    }

                    if !supports1080p {
                        Text("1080p ej tillgängligt på denna enhet")
                            .font(.caption2)
                            .foregroundColor(.white.opacity(0.4))
                    }
                }
                .padding(.horizontal, horizontalPad)

                // Notify viewers button
                if canNotify {
                    Button {
                        Task { await notifyViewers() }
                    } label: {
                        HStack(spacing: 8) {
                            if isNotifying {
                                ProgressView()
                                    .scaleEffect(0.7)
                                    .tint(.white)
                            } else if showNotifyConfirmation {
                                Image(systemName: "checkmark.circle.fill")
                            } else {
                                Image(systemName: hasNotified ? "arrow.triangle.2.circlepath" : "bell.fill")
                            }
                            Text(showNotifyConfirmation ? "Tittare meddelade!" : (hasNotified ? "Uppdatera tittare" : "Meddela tittare"))
                                .font(.subheadline)
                        }
                        .frame(maxWidth: .infinity)
                        .padding(12)
                        .background(showNotifyConfirmation ? Color.green.opacity(0.3) : Color(white: 0.15))
                        .foregroundColor(showNotifyConfirmation ? .green : club.accent)
                        .cornerRadius(8)
                        .overlay(
                            RoundedRectangle(cornerRadius: 8)
                                .stroke(showNotifyConfirmation ? Color.green.opacity(0.3) : club.accent.opacity(0.3), lineWidth: 1)
                        )
                    }
                    .disabled(isNotifying || showNotifyConfirmation)
                    .padding(.horizontal, horizontalPad)
                }

                // Start button
                Button(action: startStream) {
                    HStack(spacing: 8) {
                        if isLoading {
                            ProgressView()
                                .tint(club.onAccent)
                        }
                        Text(isLoading ? "Ansluter..." : "Starta sändning")
                            .fontWeight(.semibold)
                    }
                    .frame(maxWidth: .infinity)
                    .padding(14)
                    .background(canStart ? club.accent : club.accent.opacity(0.4))
                    .foregroundColor(club.onAccent)
                    .cornerRadius(8)
                }
                .disabled(!canStart)
                .padding(.horizontal, horizontalPad)

                if !allHealthy && backendStatus != .checking {
                    Text("Alla system måste vara online för att starta")
                        .font(.caption2)
                        .foregroundColor(.white.opacity(0.5))
                }

                Spacer(minLength: isCompact ? 8 : 20)
                if !isCompact { Spacer(minLength: 20) }
            }
            .frame(minHeight: UIScreen.main.bounds.height)
            }

            Menu {
                Button(role: .destructive) {
                    showUnpairConfirmation = true
                } label: {
                    Label("Koppla bort från \(club.name)",
                          systemImage: "link.badge.minus")
                }
            } label: {
                Image(systemName: "gearshape")
                    .font(.title3)
                    .foregroundColor(.white.opacity(0.6))
                    .padding(16)
            }
            .disabled(isUnpairing)
            .accessibilityLabel("Inställningar")
        }
        .confirmationDialog(
            "Koppla bort från \(club.name)?",
            isPresented: $showUnpairConfirmation,
            titleVisibility: .visible
        ) {
            Button("Koppla bort", role: .destructive) {
                isUnpairing = true
                Task { await Pairing.shared.unpair() }
            }
        } message: {
            Text("Appen nollställs och du behöver skanna en ny kod för att sända igen.")
        }
        .onAppear {
            OrientationManager.shared.lockPortrait()
            runHealthChecks()
            startPolling()
        }
        .onDisappear {
            healthCheckTasks.forEach { $0.cancel() }
            pollTask?.cancel()
            pollTask = nil
        }
    }

    /// Checks every component once, from scratch. Only reads status: the
    /// sändningsmotor is never started from here.
    private func runHealthChecks() {
        healthCheckTasks.forEach { $0.cancel() }
        errorMessage = nil
        backendStatus = .checking
        restreamerStatus = .checking
        websiteStatus = .checking

        healthCheckTasks = [
            Task { await checkBackend() },
            Task { await checkRestreamer() },
            Task {
                // The manifest says where the viewers' page is, so it comes first.
                await club.refresh()
                adoptHomeTeam()
                await checkWebsite()
            }
        ]
    }

    /// Keeps the status list current while this screen is up: the
    /// sändningsmotor starts, finishes starting and shuts itself down after a
    /// match without anyone here pressing anything. Rows keep their last known
    /// status between checks instead of flashing back to "Kontrollerar...".
    private func startPolling() {
        pollTask?.cancel()
        pollTask = Task {
            var round = 0
            while !Task.isCancelled {
                try? await Task.sleep(for: Self.pollInterval)
                guard !Task.isCancelled else { return }
                round += 1
                await checkRestreamer()
                if round % Self.slowPollEvery == 0 {
                    await checkBackend()
                    await checkWebsite()
                }
            }
        }
    }

    @MainActor
    private func checkBackend() async {
        let health = await APIService.shared.checkBackendHealth()
        guard !Task.isCancelled else { return }
        platformVersion = health?.version
        if health == nil {
            backendStatus = .unhealthy("Ej nåbar")
        } else if !Club.supports(platformVersion: health?.version) {
            backendStatus = .unhealthy("Behöver uppdateras")
        } else {
            backendStatus = .healthy
        }
    }

    @MainActor
    private func checkWebsite() async {
        let ok = await APIService.shared.checkWebsiteHealth(url: club.siteURL)
        guard !Task.isCancelled else { return }
        websiteStatus = ok ? .healthy : .unhealthy("Ej nåbar")
    }

    /// What to do about a red status row, when the row alone does not say.
    private var statusHint: String? {
        switch backendStatus {
        case .unhealthy("Behöver uppdateras"):
            let running = platformVersion.map { "v\($0)" } ?? "en äldre version"
            return "Plattformen kör \(running) och appen behöver minst v\(Club.minimumPlatformVersion). Klubbens ägare uppdaterar den på courtside.apps.osaas.io."
        case .unhealthy:
            return "Når inte \(club.name). Har plattformen tagits bort kan du koppla bort appen under kugghjulet."
        default:
            break
        }
        switch restreamerStatus {
        case .off:
            return "Starta sändningsmotorn när det är dags att sända — det tar 1–3 minuter. Tittarna kan du meddela redan nu."
        case .starting:
            return "Sändningsmotorn startar, det tar 1–3 minuter."
        case .healthy:
            guard let minutes = restreamerShutdownMinutes else { return nil }
            return "Ingen sänder. Sändningsmotorn stängs av automatiskt om \(minutes) min om ingen börjar sända."
        default:
            return nil
        }
    }

    /// Fill in the club's default home team, unless the user has one of their own.
    private func adoptHomeTeam() {
        guard UserDefaults.standard.string(forKey: "courtside_last_team") == nil else { return }
        team = club.homeTeam
    }

    /// Reads the sändningsmotor's state from the backend. Never starts it.
    @MainActor
    private func checkRestreamer() async {
        guard let status = await APIService.shared.checkRestreamerStatus() else {
            guard !Task.isCancelled else { return }
            restreamerStatus = .unhealthy("Ej nåbar")
            restreamerShutdownIn = nil
            return
        }
        guard !Task.isCancelled else { return }

        let state = status.state
        restreamerShutdownIn = status.shutdownInSeconds
        switch state {
        case "running", "stopping":
            // "stopping" is the grace period: nobody is streaming and the
            // backend shuts it down when it runs out, but until then it is up,
            // and a new stream cancels the shutdown.
            restreamerStatus = .healthy
            restreamerStartRequestedAt = nil
        case "starting":
            restreamerStatus = .starting
        case "stopped":
            // A check sent just before the start request can still answer
            // "stopped"; later than that, the start has failed.
            if let requested = restreamerStartRequestedAt {
                guard Date().timeIntervalSince(requested) > 10 else { return }
                restreamerStartRequestedAt = nil
                errorMessage = "Sändningsmotorn kunde inte starta. Försök igen."
            }
            restreamerStatus = .off
        default:
            restreamerStatus = .unhealthy(state)
        }
    }

    /// Asks the backend to start the sändningsmotor. It takes a few minutes;
    /// the regular status checks show when it is ready.
    @MainActor
    private func startRestreamer() async {
        isStartingRestreamer = true
        errorMessage = nil
        let response = await APIService.shared.startRestreamer()
        isStartingRestreamer = false
        guard let response else {
            errorMessage = "Kunde inte starta sändningsmotorn"
            return
        }
        if response.state == "running" {
            restreamerStatus = .healthy
        } else {
            restreamerStartRequestedAt = Date()
            restreamerStatus = .starting
        }
    }

    @MainActor
    private func stopRestreamer() async {
        isStoppingRestreamer = true
        let success = await APIService.shared.stopRestreamer()
        isStoppingRestreamer = false
        if success {
            restreamerStartRequestedAt = nil
            restreamerShutdownIn = nil
            restreamerStatus = .off
        } else {
            errorMessage = "Kunde inte stänga av sändningsmotorn"
        }
    }

    @MainActor
    private func notifyViewers() async {
        isNotifying = true
        let teamName = team.trimmingCharacters(in: .whitespaces)
        let opponentName = opponent.trimmingCharacters(in: .whitespaces)
        let matchMessage = [teamName, opponentName]
            .filter { !$0.isEmpty }
            .joined(separator: " vs ")
        do {
            _ = try await APIService.shared.setBroadcastState(
                status: "upcoming",
                message: matchMessage.isEmpty ? nil : matchMessage
            )
            hasNotified = true
            isNotifying = false
            showNotifyConfirmation = true
            try? await Task.sleep(nanoseconds: 2_000_000_000)
            showNotifyConfirmation = false
        } catch {
            errorMessage = "Kunde inte meddela tittare: \(error.localizedDescription)"
            isNotifying = false
        }
    }

    private func startStream() {
        let trimmed = name.trimmingCharacters(in: .whitespaces)
        guard !trimmed.isEmpty else { return }

        isLoading = true
        errorMessage = nil

        Task {
            do {
                let info = try await APIService.shared.createStream(
                    name: trimmed,
                    opponent: opponent.trimmingCharacters(in: .whitespaces),
                    team: team.trimmingCharacters(in: .whitespaces)
                )
                UserDefaults.standard.set(trimmed, forKey: "courtside_last_name")
                UserDefaults.standard.set(opponent.trimmingCharacters(in: .whitespaces), forKey: "courtside_last_opponent")
                UserDefaults.standard.set(team.trimmingCharacters(in: .whitespaces), forKey: "courtside_last_team")
                streamInfo = info
            } catch let apiError as APIError {
                switch apiError {
                case .restreamerNotReady(let message):
                    // Show as warning (not critical error) — user just needs to wait
                    errorMessage = message
                    // Re-trigger Restreamer status check to show "starting" status
                    restreamerStatus = .starting
                default:
                    errorMessage = apiError.localizedDescription
                }
            } catch {
                errorMessage = error.localizedDescription
            }
            isLoading = false
        }
    }
}

private struct StatusRow: View {
    let label: String
    let status: ComponentStatus
    var healthyLabel = "Online"

    var body: some View {
        HStack(spacing: 8) {
            Circle()
                .fill(statusColor)
                .frame(width: 8, height: 8)

            Text(label)
                .font(.caption)
                .foregroundColor(.white.opacity(0.8))

            Spacer()

            if status == .checking || status == .starting {
                ProgressView()
                    .scaleEffect(0.6)
                    .tint(.white.opacity(0.5))
            }

            Text(statusLabel)
                .font(.caption)
                .foregroundColor(statusColor)
        }
    }

    private var statusColor: Color {
        switch status {
        case .checking: return .yellow
        case .healthy: return .green
        case .starting: return .orange
        case .off: return .gray
        case .unhealthy: return .red
        }
    }

    private var statusLabel: String {
        switch status {
        case .checking: return "Kontrollerar..."
        case .healthy: return healthyLabel
        case .starting: return "Startar..."
        case .off: return "Avstängd"
        case .unhealthy(let msg): return msg
        }
    }
}

/// The club's own logo, or Courtside's until it has one.
private struct ClubLogo: View {
    let url: URL?

    var body: some View {
        if let url {
            AsyncImage(url: url) { phase in
                if let image = phase.image {
                    image.resizable().scaledToFit()
                } else {
                    placeholder
                }
            }
        } else {
            placeholder
        }
    }

    private var placeholder: some View {
        Image("logo")
            .resizable()
            .scaledToFit()
    }
}
