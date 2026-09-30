import UIKit

/// Controls which orientations the app allows at any given time.
/// StartView is always portrait; StreamView is always landscape.
@MainActor
final class OrientationManager {
    static let shared = OrientationManager()

    /// The orientations currently allowed. Defaults to portrait (start screen).
    var supportedOrientations: UIInterfaceOrientationMask = .portrait

    private init() {}

    /// Lock to landscape and force-rotate the device (for StreamView).
    func lockLandscape() {
        supportedOrientations = .landscape
        applyOrientation(.landscapeRight)
    }

    /// Lock to portrait and force-rotate the device (for StartView).
    func lockPortrait() {
        supportedOrientations = .portrait
        applyOrientation(.portrait)
    }

    /// Uses multiple mechanisms to force-rotate the device.
    /// requestGeometryUpdate alone is unreliable in SwiftUI apps —
    /// combining it with UIDevice.setValue is the proven workaround.
    private func applyOrientation(_ orientation: UIInterfaceOrientation) {
        guard let windowScene = UIApplication.shared.connectedScenes
            .compactMap({ $0 as? UIWindowScene })
            .first else { return }

        // 1. Tell ALL window root VCs that supported orientations changed.
        //    This causes UIKit to re-query the AppDelegate.
        for window in windowScene.windows {
            window.rootViewController?.setNeedsUpdateOfSupportedInterfaceOrientations()
        }

        // 2. Request geometry update (iOS 16+ API).
        let mask: UIInterfaceOrientationMask = orientation.isLandscape ? .landscape : .portrait
        let geometryPreferences = UIWindowScene.GeometryPreferences.iOS(
            interfaceOrientations: mask
        )
        windowScene.requestGeometryUpdate(geometryPreferences) { error in
            print("[OrientationManager] Geometry update error: \(error.localizedDescription)")
        }

        // 3. Force-set device orientation (deprecated but still functional).
        //    This is the most reliable mechanism for actually triggering the rotation
        //    in SwiftUI apps using @main/WindowGroup lifecycle.
        UIDevice.current.setValue(orientation.rawValue, forKey: "orientation")
    }
}
