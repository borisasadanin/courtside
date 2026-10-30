import SwiftUI

class AppDelegate: NSObject, UIApplicationDelegate {
    func application(
        _ application: UIApplication,
        supportedInterfaceOrientationsFor window: UIWindow?
    ) -> UIInterfaceOrientationMask {
        OrientationManager.shared.supportedOrientations
    }
}

@main
struct CourtsideCameraApp: App {
    @UIApplicationDelegateAdaptor(AppDelegate.self) var appDelegate

    var body: some Scene {
        WindowGroup {
            ContentView()
                // Every screen is drawn on black; in light mode the system's
                // secondary text turns dark grey and all but disappears.
                .preferredColorScheme(.dark)
                // A pairing QR scanned with the phone's own camera.
                .onOpenURL { Pairing.shared.open($0) }
        }
    }
}
