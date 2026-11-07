import SwiftUI
import HaishinKit

struct CameraPreview: UIViewRepresentable {
    let service: StreamService

    func makeCoordinator() -> Coordinator {
        Coordinator(service: service)
    }

    func makeUIView(context: Context) -> MTHKView {
        let view = MTHKView(frame: .zero)
        view.videoGravity = .resizeAspectFill
        view.isUserInteractionEnabled = true
        context.coordinator.view = view

        let pinch = UIPinchGestureRecognizer(target: context.coordinator, action: #selector(Coordinator.handlePinch(_:)))
        view.addGestureRecognizer(pinch)

        service.connectPreview(view)
        return view
    }

    func updateUIView(_ uiView: MTHKView, context: Context) {}

    static func dismantleUIView(_ uiView: MTHKView, coordinator: Coordinator) {
        coordinator.view = nil
    }

    @MainActor
    class Coordinator {
        var view: MTHKView?
        let service: StreamService
        private var zoomAtStart: CGFloat = 1.0

        init(service: StreamService) {
            self.service = service
        }

        @objc func handlePinch(_ gesture: UIPinchGestureRecognizer) {
            switch gesture.state {
            case .began:
                zoomAtStart = service.currentZoom
            case .changed:
                let newZoom = zoomAtStart * gesture.scale
                service.setZoom(newZoom)
            default:
                break
            }
        }
    }
}

struct StreamView: View {
    let streamInfo: StreamInfo
    /// Called once the broadcast has ended, with the match when its result should be asked for.
    let onStop: (FinishedMatch?) -> Void

    @StateObject private var service = StreamService()
    @State private var isStopping = false
    /// The pause being requested, while the request is in flight.
    @State private var pausing: PauseType?
    @State private var isResuming = false
    @State private var showStopConfirmation = false
    @State private var isClipping = false
    /// What the confirmation toast says while it shows.
    @State private var clipConfirmation: String?
    /// A star press waiting for the team to be chosen (#53).
    @State private var pendingClip: PendingClip?
    @State private var clipCooldown = false
    @State private var elapsedTime: TimeInterval = 0
    @State private var timerTask: Task<Void, Never>?
    @State private var timerStartedOnce = false
    @Environment(\.verticalSizeClass) private var verticalSizeClass
    @Environment(\.scenePhase) private var scenePhase
    @StateObject private var club = Club.shared

    private var isCompact: Bool { verticalSizeClass == .compact }

    var body: some View {
        ZStack {
            Color.black.ignoresSafeArea()

            // Camera preview
            CameraPreview(service: service)
                .ignoresSafeArea()

            // Overlay controls
            VStack {
                // Top bar: LIVE badge + viewers + camera switch
                HStack {
                    // LIVE badge
                    Text(service.isPaused ? (service.pauseType?.label(in: club.sport).uppercased() ?? "PAUS") : "LIVE")
                        .font(.caption.bold())
                        .tracking(1)
                        .padding(.horizontal, 10)
                        .padding(.vertical, 5)
                        .background(service.isPaused ? pauseColor(service.pauseType ?? .period) : (service.isConnected ? Color.red : Color.gray))
                        .foregroundColor(service.isPaused ? pauseTextColor(service.pauseType ?? .period) : .white)
                        .cornerRadius(4)
                        .opacity(service.isConnected || service.isPaused ? 1 : 0.6)

                    // Broadcast timer
                    if service.isConnected || service.isPaused {
                        Text(formatElapsed(elapsedTime))
                            .font(.caption.monospacedDigit())
                            .foregroundColor(.white.opacity(0.8))
                    }

                    // Quality badge
                    if service.isConnected {
                        HStack(spacing: 3) {
                            Image(systemName: service.isBitrateReduced
                                ? "exclamationmark.triangle.fill"
                                : "antenna.radiowaves.left.and.right")
                                .font(.caption2)
                            Text(service.selectedQuality.shortLabel)
                                .font(.caption2.bold())
                        }
                        .padding(.horizontal, 8)
                        .padding(.vertical, 5)
                        .background {
                            if service.isBitrateReduced {
                                Color.orange.opacity(0.8)
                            } else {
                                Rectangle().fill(.ultraThinMaterial)
                            }
                        }
                        .foregroundColor(service.isBitrateReduced ? .black : .white)
                        .cornerRadius(4)
                    }

                    if service.isConnected && service.viewerCount > 0 {
                        HStack(spacing: 4) {
                            Image(systemName: "eye.fill")
                                .font(.caption2)
                            Text("\(service.viewerCount)")
                                .font(.caption.bold())
                        }
                        .foregroundColor(.white)
                        .padding(.horizontal, 8)
                        .padding(.vertical, 5)
                        .background(.ultraThinMaterial)
                        .cornerRadius(4)
                    }

                    if !service.isConnected && !service.isPaused && service.error == nil && !isStopping {
                        Text("Ansluter...")
                            .font(.caption)
                            .foregroundColor(.white.opacity(0.7))
                    }

                    Spacer()

                    // Highlight clip button
                    if service.isConnected && !service.isPaused {
                        Button {
                            createHighlight()
                        } label: {
                            Image(systemName: isClipping ? "hourglass" : "star.fill")
                                .font(.title2)
                                .foregroundColor(clipCooldown ? .gray : club.accent)
                                .padding(10)
                                .background(.ultraThinMaterial)
                                .clipShape(Circle())
                        }
                        .disabled(isClipping || clipCooldown)
                    }

                    // Mute toggle
                    Button {
                        Task { await service.toggleMute() }
                    } label: {
                        Image(systemName: service.isMuted ? "mic.slash.fill" : "mic.fill")
                            .font(.title2)
                            .foregroundColor(service.isMuted ? .red : .white)
                            .padding(10)
                            .background(.ultraThinMaterial)
                            .clipShape(Circle())
                    }

                    // Camera switch
                    Button {
                        Task { await service.switchCamera() }
                    } label: {
                        Image(systemName: "camera.rotate.fill")
                            .font(.title2)
                            .foregroundColor(.white)
                            .padding(10)
                            .background(.ultraThinMaterial)
                            .clipShape(Circle())
                    }
                }
                .padding(.horizontal, 20)
                .padding(.top, 8)

                Spacer()

                // Zoom controls (right side)
                HStack {
                    Spacer()
                    VStack(spacing: 8) {
                        Button {
                            service.zoomIn()
                        } label: {
                            Image(systemName: "plus")
                                .font(.title2.bold())
                                .foregroundColor(.white)
                                .frame(width: 44, height: 44)
                                .background(.ultraThinMaterial)
                                .clipShape(Circle())
                        }

                        if service.currentZoom > 1.05 {
                            Text(String(format: "%.1fx", service.currentZoom))
                                .font(.caption2.bold().monospacedDigit())
                                .foregroundColor(.white)
                                .padding(.horizontal, 6)
                                .padding(.vertical, 2)
                                .background(.ultraThinMaterial)
                                .cornerRadius(4)
                        }

                        Button {
                            service.zoomOut()
                        } label: {
                            Image(systemName: "minus")
                                .font(.title2.bold())
                                .foregroundColor(service.currentZoom > 1.05 ? .white : .white.opacity(0.4))
                                .frame(width: 44, height: 44)
                                .background(.ultraThinMaterial)
                                .clipShape(Circle())
                        }
                        .disabled(service.currentZoom <= 1.05)
                    }
                    .padding(.trailing, 20)
                }

                Spacer()

                // Highlight clip confirmation toast
                if let clipConfirmation {
                    Text(clipConfirmation)
                        .lineLimit(1)
                        .minimumScaleFactor(0.7)
                        .font(.headline)
                        .padding(.horizontal, 16)
                        .padding(.vertical, 10)
                        .background(club.accent.opacity(0.9))
                        .foregroundColor(club.onAccent)
                        .cornerRadius(8)
                }

                // Error/reconnect message
                if let error = service.error {
                    Text(error)
                        .font(.caption)
                        .foregroundColor(.white)
                        .padding(10)
                        .background(Color.red.opacity(0.8))
                        .cornerRadius(8)
                        .padding(.horizontal, 20)
                }

                // Bottom buttons: Period break + Timeout (or Resume) + Stop.
                // One row in landscape; in portrait three are too narrow, so Stop
                // gets a row of its own.
                let buttonLayout = isCompact
                    ? AnyLayout(HStackLayout(spacing: 12))
                    : AnyLayout(VStackLayout(spacing: 12))
                buttonLayout {
                    HStack(spacing: 12) {
                        if service.isPaused {
                            Button {
                                resumeRecording()
                            } label: {
                                HStack(spacing: 8) {
                                    if isResuming {
                                        ProgressView()
                                            .tint(.white)
                                    }
                                    Image(systemName: "play.fill")
                                    Text(isResuming ? "Återupptar..." : "Återuppta")
                                        .fontWeight(.semibold)
                                }
                                .frame(maxWidth: .infinity, minHeight: 44)
                                .padding(.horizontal, 14)
                                .padding(.vertical, 2)
                                .background(Color.green)
                                .foregroundColor(.white)
                                .cornerRadius(8)
                            }
                            .disabled(isResuming || isStopping)
                        } else {
                            pauseButton(.period, icon: "pause.fill", title: PauseType.period.label(in: club.sport))
                            pauseButton(.timeout, icon: "hand.raised.fill", title: PauseType.timeout.label(in: club.sport))
                        }
                    }

                    // Stop button
                    Button { showStopConfirmation = true } label: {
                        HStack(spacing: 8) {
                            if isStopping {
                                ProgressView()
                                    .tint(.white)
                            }
                            Image(systemName: "stop.fill")
                            Text(isStopping ? "Stoppar..." : "Stopp")
                                .fontWeight(.semibold)
                        }
                        .frame(maxWidth: .infinity, minHeight: 44)
                        .padding(.horizontal, 14)
                        .padding(.vertical, 2)
                        .background(Color.red)
                        .foregroundColor(.white)
                        .cornerRadius(8)
                    }
                    .disabled(isStopping)
                    .frame(maxWidth: isCompact ? 160 : .infinity)
                }
                .padding(.horizontal, isCompact ? 20 : 32)
                .padding(.bottom, isCompact ? 16 : 40)
            }

            if let pendingClip {
                teamChoice(pendingClip)
                    .transition(.opacity.combined(with: .scale(scale: 0.95)))
            }
        }
        .onAppear {
            Pairing.shared.broadcastStarted()
            elapsedTime = 0
            UIApplication.shared.isIdleTimerDisabled = true
            OrientationManager.shared.lockLandscape()
            Task {
                await service.prepare()
                await service.start(rtmpUrl: streamInfo.rtmpUrl, streamId: streamInfo.id)
            }
        }
        .onDisappear {
            UIApplication.shared.isIdleTimerDisabled = false
            OrientationManager.shared.lockPortrait()
            Task { await service.cleanup() }
            Pairing.shared.broadcastEnded()
        }
        .confirmationDialog("Avsluta sändning?", isPresented: $showStopConfirmation) {
            Button("Stoppa sändning", role: .destructive) {
                stopStream()
            }
            Button("Avbryt", role: .cancel) {}
        } message: {
            Text("Sändningen avslutas och kan inte återupptas")
        }
        .onChange(of: scenePhase) { newPhase in
            switch newPhase {
            case .background:
                Task { await service.pauseVideo() }
            case .active:
                // Restore both video AND audio — iOS deactivates AVAudioSession
                // while the app is backgrounded, and without an explicit
                // re-activation the microphone produces no samples, which
                // silently strips audio from the next RTMP publish.
                Task {
                    await service.resumeVideo()
                    await service.resumeAudio()
                }
            default:
                break
            }
        }
        .onChange(of: service.isConnected) { connected in
            if connected && !timerStartedOnce {
                // Start the timer only once — on first connection.
                // It keeps running through pauses and reconnects.
                timerStartedOnce = true
                elapsedTime = 0
                timerTask = Task {
                    while !Task.isCancelled {
                        try? await Task.sleep(for: .seconds(1))
                        guard !Task.isCancelled else { return }
                        elapsedTime += 1
                    }
                }
            }
        }
    }

    private func formatElapsed(_ seconds: TimeInterval) -> String {
        let totalSeconds = Int(seconds)
        let h = totalSeconds / 3600
        let m = (totalSeconds % 3600) / 60
        let s = totalSeconds % 60
        if h > 0 {
            return String(format: "%d:%02d:%02d", h, m, s)
        } else {
            return String(format: "%02d:%02d", m, s)
        }
    }

    /// How long the team choice waits before the clip is saved for our team.
    private static let clipChoiceSeconds: Double = 4

    /// A star press whose team is not chosen yet. The timestamp is the press.
    struct PendingClip: Equatable {
        let id = UUID()
        let timestamp: String
    }

    private var ownTeamName: String {
        Self.nonEmpty(streamInfo.homeTeam)
            ?? Self.nonEmpty(UserDefaults.standard.string(forKey: "courtside_last_team"))
            ?? club.homeTeam
    }

    private var opponentTeamName: String {
        Self.nonEmpty(streamInfo.awayTeam)
            ?? Self.nonEmpty(UserDefaults.standard.string(forKey: "courtside_last_opponent"))
            ?? "Motståndare"
    }

    private static func nonEmpty(_ s: String?) -> String? {
        guard let s = s?.trimmingCharacters(in: .whitespaces), !s.isEmpty else { return nil }
        return s
    }

    /// The star press. The clip's moment is now; on a platform with guest spaces
    /// the team is chosen afterwards, and our team is assumed if nobody chooses.
    private func createHighlight() {
        isClipping = true
        clipCooldown = true
        let generator = UIImpactFeedbackGenerator(style: .medium)
        generator.impactOccurred()

        let timestamp = ISO8601DateFormatter().string(from: Date())

        guard club.supportsGuestSpaces else {
            Task { await sendClip(timestamp: timestamp, team: nil) }
            return
        }

        let pending = PendingClip(timestamp: timestamp)
        withAnimation(.easeOut(duration: 0.15)) { pendingClip = pending }
        Task {
            try? await Task.sleep(for: .seconds(Self.clipChoiceSeconds))
            if pendingClip == pending { chooseTeam(.own) }
        }
    }

    private func chooseTeam(_ team: APIService.ClipTeam) {
        guard let pending = pendingClip else { return }
        withAnimation(.easeIn(duration: 0.15)) { pendingClip = nil }
        Task { await sendClip(timestamp: pending.timestamp, team: team) }
    }

    /// Sends the clip, shows where it went, and holds the star for the
    /// cooldown (the platform takes one clip per five seconds).
    private func sendClip(timestamp: String, team: APIService.ClipTeam?) async {
        do {
            let clip = try await APIService.shared.createClip(
                streamId: streamInfo.id,
                timestamp: timestamp,
                team: team
            )
            let message: String
            switch team {
            case .none: message = "⭐ Höjdpunkt sparad!"
            case .own: message = "⭐ Sparat för \(ownTeamName)"
            case .opponent: message = "⭐ Sparat för \(Self.nonEmpty(clip.teamName) ?? opponentTeamName)"
            }
            withAnimation { clipConfirmation = message }
            Task {
                try? await Task.sleep(for: .seconds(2))
                if clipConfirmation == message {
                    withAnimation { clipConfirmation = nil }
                }
            }
        } catch {
            service.error = "Klipp misslyckades: \(error.localizedDescription)"
        }
        isClipping = false
        // Cooldown: prevent spam. Not awaited, so stopping need not wait for it.
        Task {
            try? await Task.sleep(for: .seconds(5))
            clipCooldown = false
        }
    }

    /// Two big buttons in the middle of the screen, away from the edges and
    /// their system gestures, with a bar that runs out when our team is assumed.
    private func teamChoice(_ pending: PendingClip) -> some View {
        VStack(spacing: 14) {
            Text("Vems höjdpunkt?")
                .font(.headline)
                .foregroundColor(.white)
                .shadow(radius: 3)

            let layout = isCompact
                ? AnyLayout(HStackLayout(spacing: 20))
                : AnyLayout(VStackLayout(spacing: 16))
            layout {
                teamButton(ownTeamName, background: club.accent, foreground: club.onAccent) {
                    chooseTeam(.own)
                }
                teamButton(opponentTeamName, background: Color.white, foreground: .black) {
                    chooseTeam(.opponent)
                }
            }

            ClipChoiceCountdown(seconds: Self.clipChoiceSeconds)
                .id(pending.id)
                .frame(maxWidth: isCompact ? 460 : 280)
        }
        .padding(20)
        .background(Color.black.opacity(0.55))
        .cornerRadius(20)
        .padding(.horizontal, 60)
    }

    private func teamButton(_ name: String, background: Color, foreground: Color, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Text(name)
                .font(.title2.bold())
                .lineLimit(2)
                .minimumScaleFactor(0.6)
                .multilineTextAlignment(.center)
                .padding(.horizontal, 16)
                .frame(width: isCompact ? 220 : 260, height: isCompact ? 110 : 90)
                .background(background)
                .foregroundColor(foreground)
                .cornerRadius(16)
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }

    private func stopStream() {
        isStopping = true

        Task {
            // A star press still waiting for its team is saved for our team
            // before the stream goes away.
            if let pending = pendingClip {
                pendingClip = nil
                await sendClip(timestamp: pending.timestamp, team: .own)
            }

            // 1. Delete on backend FIRST — this updates the website immediately
            //    and works even if Restreamer is shutting down.
            try? await APIService.shared.deleteStream(id: streamInfo.id)

            // 2. Lock portrait BEFORE view transition so UIKit processes it.
            OrientationManager.shared.lockPortrait()

            // 3. Navigate back. RTMP cleanup happens via onDisappear → cleanup()
            //    which has a 3-second timeout so it won't hang. The result is
            //    asked for after that, on the start screen in portrait.
            isStopping = false
            onStop(finishedMatch())
        }
    }

    /// The match to ask the result for, or nil when there is no point: the
    /// platform cannot keep one, or the recording is too short to be listed.
    private func finishedMatch() -> FinishedMatch? {
        guard club.supportsMatchResult, elapsedTime >= 10 else { return nil }
        return FinishedMatch(id: streamInfo.id, homeTeam: ownTeamName, awayTeam: opponentTeamName)
    }

    private func pauseColor(_ type: PauseType) -> Color {
        switch type {
        case .period: return .orange
        case .timeout: return Color(red: 0.11, green: 0.40, blue: 0.82)
        }
    }

    private func pauseTextColor(_ type: PauseType) -> Color {
        type == .period ? .black : .white
    }

    private func pauseButton(_ type: PauseType, icon: String, title: String) -> some View {
        Button {
            pauseRecording(type)
        } label: {
            HStack(spacing: 8) {
                if pausing == type {
                    ProgressView()
                        .tint(pauseTextColor(type))
                }
                Image(systemName: icon)
                Text(pausing == type ? "Pausar..." : title)
                    .fontWeight(.semibold)
                    .lineLimit(1)
                    .minimumScaleFactor(0.8)
            }
            .frame(maxWidth: .infinity, minHeight: 44)
            .padding(.horizontal, 14)
            .padding(.vertical, 2)
            .background(pauseColor(type))
            .foregroundColor(pauseTextColor(type))
            .cornerRadius(8)
        }
        .disabled(pausing != nil || isStopping || !service.isConnected)
    }

    private func pauseRecording(_ type: PauseType) {
        pausing = type
        Task {
            do {
                let response = try await APIService.shared.pauseStream(id: streamInfo.id, type: type)
                // An older backend ignores the type and pauses for a period.
                await service.pauseStream(type: PauseType(rawValue: response.pauseType ?? "") ?? .period)
            } catch {
                service.error = "Kunde inte pausa: \(error.localizedDescription)"
            }
            pausing = nil
        }
    }

    private func resumeRecording() {
        isResuming = true
        Task {
            do {
                let response = try await APIService.shared.resumeStream(id: streamInfo.id)
                await service.resumeStream(rtmpUrl: response.rtmpUrl)
            } catch {
                service.error = "Kunde inte återuppta: \(error.localizedDescription)"
            }
            isResuming = false
        }
    }
}

/// A bar that empties over `seconds`, showing how long the team choice stays open.
private struct ClipChoiceCountdown: View {
    let seconds: Double
    @State private var remaining: CGFloat = 1

    var body: some View {
        GeometryReader { geo in
            Capsule()
                .fill(Color.white.opacity(0.25))
                .overlay(alignment: .leading) {
                    Capsule()
                        .fill(Color.white)
                        .frame(width: geo.size.width * remaining)
                }
        }
        .frame(height: 6)
        .onAppear {
            withAnimation(.linear(duration: seconds)) { remaining = 0 }
        }
    }
}
