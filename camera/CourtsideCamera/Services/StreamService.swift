import AVFoundation
import HaishinKit
import RTMPHaishinKit
import Network
import UIKit

@MainActor
final class StreamService: ObservableObject {
    @Published var isConnected = false
    @Published var error: String?
    @Published var viewerCount = 0
    @Published var isMuted = false
    @Published var selectedQuality: StreamQuality = StreamQuality.saved
    @Published var isBitrateReduced = false
    @Published var isPaused = false
    @Published var currentZoom: CGFloat = 1.0
    @Published var maxZoom: CGFloat = 1.0

    let mixer = MediaMixer()
    private var connection: RTMPConnection?
    private var stream: RTMPStream?
    private var currentPosition: AVCaptureDevice.Position = .back
    private var isMixerReady = false
    private var pendingView: MTHKView?

    // Reconnect state
    private var currentRtmpUrl: String?
    private var shouldReconnect = false
    private var reconnectTask: Task<Void, Never>?
    private var networkMonitor: NWPathMonitor?
    private var wasConnected = false

    // Viewer count polling
    private var viewerPollTask: Task<Void, Never>?
    private var currentStreamId: String?

    // Bitrate monitoring
    private var bitrateMonitorTask: Task<Void, Never>?

    // Audio interruption observer (phone calls, alarms, etc.)
    private var interruptionObserver: NSObjectProtocol?

    func prepare() async {
        // Check camera permission
        let videoStatus = AVCaptureDevice.authorizationStatus(for: .video)
        switch videoStatus {
        case .notDetermined:
            let granted = await AVCaptureDevice.requestAccess(for: .video)
            if !granted {
                error = "Kameraåtkomst nekad. Gå till Inställningar för att tillåta kameraanvändning."
                return
            }
        case .denied, .restricted:
            error = "Kameraåtkomst nekad. Gå till Inställningar för att tillåta kameraanvändning."
            return
        case .authorized:
            break
        @unknown default:
            break
        }

        // Check microphone permission
        let audioStatus = AVCaptureDevice.authorizationStatus(for: .audio)
        switch audioStatus {
        case .notDetermined:
            let granted = await AVCaptureDevice.requestAccess(for: .audio)
            if !granted {
                error = "Mikrofonåtkomst nekad. Gå till Inställningar för att tillåta mikrofonanvändning."
                return
            }
        case .denied, .restricted:
            error = "Mikrofonåtkomst nekad. Gå till Inställningar för att tillåta mikrofonanvändning."
            return
        case .authorized:
            break
        @unknown default:
            break
        }

        let session = AVAudioSession.sharedInstance()
        try? session.setCategory(.playAndRecord, options: [.defaultToSpeaker, .allowBluetoothA2DP])
        try? session.setActive(true)

        let camera = AVCaptureDevice.default(.builtInWideAngleCamera, for: .video, position: .back)
        try? await mixer.attachVideo(camera, track: 0)
        try? await mixer.attachAudio(AVCaptureDevice.default(for: .audio))

        // Always use landscape orientation (locked in StreamView)
        Task { await mixer.setVideoOrientation(.landscapeRight) }

        await mixer.startRunning()

        // Capture zoom limits for the initial camera
        if let camera {
            maxZoom = min(camera.activeFormat.videoMaxZoomFactor, 10.0)
            currentZoom = 1.0
        }

        isMixerReady = true
        if let pendingView {
            await mixer.addOutput(pendingView)
            self.pendingView = nil
        }

        // Handle audio interruptions (phone calls, alarms, Siri, etc.)
        interruptionObserver = NotificationCenter.default.addObserver(
            forName: AVAudioSession.interruptionNotification,
            object: nil,
            queue: .main
        ) { [weak self] notification in
            Task { @MainActor in
                self?.handleAudioInterruption(notification)
            }
        }
    }

    // MARK: - Audio interruption handling

    private func handleAudioInterruption(_ notification: Notification) {
        guard let userInfo = notification.userInfo,
              let typeValue = userInfo[AVAudioSessionInterruptionTypeKey] as? UInt,
              let type = AVAudioSession.InterruptionType(rawValue: typeValue) else { return }

        switch type {
        case .began:
            // Audio interrupted (incoming call, alarm, etc.)
            // The RTMP stream may lose audio but HaishinKit keeps the connection alive.
            print("[StreamService] Audio interrupted")
        case .ended:
            // Interruption ended (call declined/ended, alarm dismissed)
            // Reactivate audio session so recording continues.
            let session = AVAudioSession.sharedInstance()
            try? session.setActive(true, options: .notifyOthersOnDeactivation)
            print("[StreamService] Audio interruption ended — session reactivated")

            // If the RTMP connection was lost during the interruption, reconnect
            if !isConnected, let rtmpUrl = currentRtmpUrl, shouldReconnect {
                Task { await connect(rtmpUrl: rtmpUrl) }
            }
        @unknown default:
            break
        }
    }

    func connectPreview(_ view: MTHKView) {
        if isMixerReady {
            Task { await mixer.addOutput(view) }
        } else {
            pendingView = view
        }
    }

    func start(rtmpUrl: String, streamId: String) async {
        selectedQuality = StreamQuality.saved
        currentRtmpUrl = rtmpUrl
        currentStreamId = streamId
        shouldReconnect = true
        startNetworkMonitor()
        startViewerPolling(streamId: streamId)
        await connect(rtmpUrl: rtmpUrl)
        startBitrateMonitoring()
    }

    private func connect(rtmpUrl: String) async {
        guard let url = URL(string: rtmpUrl),
              let host = url.host,
              let port = url.port else {
            error = "Ogiltig RTMP-URL"
            return
        }

        let path = url.path
        let pathParts = path.split(separator: "/", maxSplits: 2)
        let publishName: String
        let appPath: String

        if pathParts.count >= 2 {
            appPath = String(pathParts.first!)
            publishName = String(pathParts.last!)
        } else {
            appPath = "live"
            publishName = String(path.dropFirst())
        }

        let connectUrl = "rtmp://\(host):\(port)/\(appPath)"

        // Clean up previous connection
        if let stream {
            await mixer.removeOutput(stream)
            _ = try? await stream.close()
        }
        try? await connection?.close()

        let conn = RTMPConnection(
            fourCcList: nil,
            videoFourCcInfoMap: nil,
            audioFourCcInfoMap: nil,
            capsEx: 0
        )
        let str = RTMPStream(connection: conn)
        connection = conn
        stream = str

        // Apply quality settings and adaptive bitrate
        try? await str.setVideoSettings(selectedQuality.videoCodecSettings)
        try? await str.setAudioSettings(selectedQuality.audioCodecSettings)
        let abr = StreamVideoAdaptiveBitRateStrategy(mamimumVideoBitrate: selectedQuality.videoBitRate)
        await str.setBitRateStrategy(abr)

        await mixer.addOutput(str)

        do {
            _ = try await conn.connect(connectUrl)
            _ = try await str.publish(publishName)
            isConnected = true
            wasConnected = true
            error = nil
        } catch {
            self.error = "Anslutningsfel: \(error.localizedDescription)"
            isConnected = false
            scheduleReconnect()
        }
    }

    private func scheduleReconnect() {
        guard shouldReconnect, let rtmpUrl = currentRtmpUrl else { return }
        reconnectTask?.cancel()
        reconnectTask = Task {
            for delay in [2, 4, 8, 15, 30] {
                guard shouldReconnect, !Task.isCancelled else { return }
                error = "Återansluter om \(delay)s..."
                try? await Task.sleep(for: .seconds(delay))
                guard shouldReconnect, !Task.isCancelled else { return }
                error = "Återansluter..."
                await connect(rtmpUrl: rtmpUrl)
                if isConnected { return }
            }
            if shouldReconnect {
                error = "Kunde inte återansluta"
            }
        }
    }

    private func startNetworkMonitor() {
        networkMonitor?.cancel()
        let monitor = NWPathMonitor()
        networkMonitor = monitor
        monitor.pathUpdateHandler = { [weak self] path in
            Task { @MainActor [weak self] in
                guard let self, self.shouldReconnect else { return }
                if path.status == .satisfied && !self.isConnected && self.wasConnected {
                    self.reconnectTask?.cancel()
                    if let url = self.currentRtmpUrl {
                        self.error = "Nätverket tillbaka — återansluter..."
                        await self.connect(rtmpUrl: url)
                    }
                } else if path.status != .satisfied && self.isConnected {
                    self.isConnected = false
                    self.error = "Nätverksanslutning förlorad"
                }
            }
        }
        monitor.start(queue: DispatchQueue(label: "network-monitor"))
    }

    private func startViewerPolling(streamId: String) {
        viewerPollTask?.cancel()
        viewerPollTask = Task {
            while !Task.isCancelled {
                if let status = try? await APIService.shared.getStream(id: streamId) {
                    viewerCount = status.viewers
                }
                try? await Task.sleep(for: .seconds(10))
            }
        }
    }

    func stop() async {
        shouldReconnect = false
        reconnectTask?.cancel()
        reconnectTask = nil
        viewerPollTask?.cancel()
        viewerPollTask = nil
        bitrateMonitorTask?.cancel()
        bitrateMonitorTask = nil
        isBitrateReduced = false
        networkMonitor?.cancel()
        networkMonitor = nil

        // Mark disconnected immediately for UI
        isConnected = false

        // Detach stream from mixer first
        if let stream {
            await mixer.removeOutput(stream)
        }

        // Close RTMP with a 3-second timeout to prevent hanging
        let streamToClose = stream
        let connectionToClose = connection
        await withTaskGroup(of: Void.self) { group in
            group.addTask {
                if let s = streamToClose {
                    _ = try? await s.close()
                }
                if let c = connectionToClose {
                    try? await c.close()
                }
            }
            group.addTask {
                try? await Task.sleep(for: .seconds(3))
            }
            // Whichever finishes first wins
            await group.next()
            group.cancelAll()
        }

        connection = nil
        stream = nil
    }

    /// Pause the RTMP stream while keeping the camera mixer alive.
    /// The camera preview stays active so the user can see what the camera sees.
    func pauseStream() async {
        shouldReconnect = false
        reconnectTask?.cancel()
        reconnectTask = nil
        bitrateMonitorTask?.cancel()
        bitrateMonitorTask = nil
        isBitrateReduced = false

        isConnected = false
        isPaused = true

        // Detach stream from mixer
        if let stream {
            await mixer.removeOutput(stream)
        }

        // Close RTMP with a 3-second timeout
        let streamToClose = stream
        let connectionToClose = connection
        await withTaskGroup(of: Void.self) { group in
            group.addTask {
                if let s = streamToClose {
                    _ = try? await s.close()
                }
                if let c = connectionToClose {
                    try? await c.close()
                }
            }
            group.addTask {
                try? await Task.sleep(for: .seconds(3))
            }
            await group.next()
            group.cancelAll()
        }

        connection = nil
        stream = nil
        // Note: mixer stays running (camera stays warm), viewer polling continues
    }

    /// Resume the RTMP stream after a pause, reconnecting with a new RTMP URL.
    func resumeStream(rtmpUrl: String) async {
        isPaused = false
        currentRtmpUrl = rtmpUrl
        shouldReconnect = true
        // Defensive: if the app was backgrounded during the pause, the audio
        // session and microphone route may be inactive. Re-activate BEFORE the
        // RTMP publish so the first segments contain audio. If the scenePhase
        // handler already re-attached audio this is a safe no-op.
        await resumeAudio()
        await connect(rtmpUrl: rtmpUrl)
        startBitrateMonitoring()
    }

    private func startBitrateMonitoring() {
        bitrateMonitorTask?.cancel()
        bitrateMonitorTask = Task {
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(3))
                guard !Task.isCancelled, let stream else { continue }
                let currentBitRate = await stream.videoSettings.bitRate
                isBitrateReduced = currentBitRate < selectedQuality.videoBitRate
            }
        }
    }

    func toggleMute() async {
        isMuted.toggle()
        var settings = await mixer.audioMixerSettings
        var track = settings.tracks[0] ?? .init()
        track.isMuted = isMuted
        settings.tracks[0] = track
        await mixer.setAudioMixerSettings(settings)
    }

    func switchCamera() async {
        let newPosition: AVCaptureDevice.Position = currentPosition == .back ? .front : .back
        currentPosition = newPosition
        let device = AVCaptureDevice.default(.builtInWideAngleCamera, for: .video, position: newPosition)
        try? await mixer.attachVideo(device, track: 0)
        // Reset zoom for new camera
        if let device {
            maxZoom = min(device.activeFormat.videoMaxZoomFactor, 10.0)
            currentZoom = 1.0
        }
    }

    // MARK: - Zoom

    func setZoom(_ factor: CGFloat) {
        guard let device = AVCaptureDevice.default(.builtInWideAngleCamera, for: .video, position: currentPosition) else { return }
        let clamped = min(max(factor, 1.0), maxZoom)
        do {
            try device.lockForConfiguration()
            device.videoZoomFactor = clamped
            device.unlockForConfiguration()
            currentZoom = clamped
        } catch {
            print("[StreamService] Zoom error: \(error)")
        }
    }

    func zoomIn() {
        setZoom(currentZoom * 1.25)
    }

    func zoomOut() {
        setZoom(currentZoom / 1.25)
    }

    func pauseVideo() async {
        try? await mixer.attachVideo(nil, track: 0)
    }

    func resumeVideo() async {
        let device = AVCaptureDevice.default(.builtInWideAngleCamera, for: .video, position: currentPosition)
        try? await mixer.attachVideo(device, track: 0)
        // Re-apply zoom — attaching resets the device to 1.0x
        if currentZoom > 1.0 {
            setZoom(currentZoom)
        }
    }

    /// Reactivate the audio session and re-attach the microphone to the mixer.
    /// iOS deactivates AVAudioSession and releases the capture audio route when the
    /// app is backgrounded. Unlike real interruptions (calls, Siri) this does NOT
    /// fire AVAudioSession.interruptionNotification, so we must handle it ourselves
    /// from the scenePhase .active transition and defensively before resuming RTMP.
    func resumeAudio() async {
        let session = AVAudioSession.sharedInstance()
        try? session.setCategory(.playAndRecord, options: [.defaultToSpeaker, .allowBluetoothA2DP])
        try? session.setActive(true, options: .notifyOthersOnDeactivation)
        // Re-attach the microphone. Safe to call even if still attached — HaishinKit
        // swaps the input device if one was already set.
        try? await mixer.attachAudio(AVCaptureDevice.default(for: .audio))
    }

    func cleanup() async {
        if let observer = interruptionObserver {
            NotificationCenter.default.removeObserver(observer)
            interruptionObserver = nil
        }
        await stop()
        await mixer.stopRunning()
    }
}
