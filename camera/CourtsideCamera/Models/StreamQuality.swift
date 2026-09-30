import AVFoundation
import HaishinKit
import VideoToolbox

enum StreamQuality: String, CaseIterable, Identifiable {
    case low
    case medium
    case high

    var id: String { rawValue }

    var label: String {
        switch self {
        case .low: return "Låg"
        case .medium: return "Medium"
        case .high: return "Hög"
        }
    }

    var shortLabel: String {
        switch self {
        case .low: return "720p"
        case .medium: return "1080p"
        case .high: return "1080p HQ"
        }
    }

    var bitrateLabel: String {
        switch self {
        case .low: return "1 Mbps"
        case .medium: return "3 Mbps"
        case .high: return "5 Mbps"
        }
    }

    var videoSize: CGSize {
        switch self {
        case .low: return CGSize(width: 1280, height: 720)
        case .medium, .high: return CGSize(width: 1920, height: 1080)
        }
    }

    var videoBitRate: Int {
        switch self {
        case .low: return 1_000_000
        case .medium: return 3_000_000
        case .high: return 5_000_000
        }
    }

    var audioBitRate: Int {
        switch self {
        case .low: return 96_000
        case .medium, .high: return 128_000
        }
    }

    var requires1080p: Bool {
        self != .low
    }

    var videoCodecSettings: VideoCodecSettings {
        VideoCodecSettings(
            videoSize: videoSize,
            bitRate: videoBitRate,
            profileLevel: kVTProfileLevel_H264_Main_AutoLevel as String,
            maxKeyFrameIntervalDuration: 2,
            expectedFrameRate: 30
        )
    }

    var audioCodecSettings: AudioCodecSettings {
        AudioCodecSettings(bitRate: audioBitRate)
    }

    // MARK: - Device capability

    static var deviceSupports1080p: Bool {
        guard let camera = AVCaptureDevice.default(
            .builtInWideAngleCamera, for: .video, position: .back
        ) else {
            return false
        }
        return camera.formats.contains { format in
            let dims = CMVideoFormatDescriptionGetDimensions(format.formatDescription)
            return dims.height >= 1080
        }
    }

    // MARK: - Persistence

    private static let userDefaultsKey = "courtside_stream_quality"

    static var saved: StreamQuality {
        guard let raw = UserDefaults.standard.string(forKey: userDefaultsKey),
              let quality = StreamQuality(rawValue: raw) else {
            return .low
        }
        if quality.requires1080p && !deviceSupports1080p {
            return .low
        }
        return quality
    }

    func save() {
        UserDefaults.standard.set(rawValue, forKey: StreamQuality.userDefaultsKey)
    }
}
