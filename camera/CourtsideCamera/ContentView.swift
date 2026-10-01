import SwiftUI

struct ContentView: View {
    @StateObject private var pairing = Pairing.shared
    @State private var streamInfo: StreamInfo?
    @State private var returningFromStream = false

    var body: some View {
        if !pairing.isPaired {
            // Nothing can be done before the camera knows which club it serves.
            PairingView()
                .transition(.opacity)
        } else if let info = streamInfo {
            StreamView(streamInfo: info) {
                returningFromStream = true
                streamInfo = nil
            }
            .transition(.move(edge: .trailing))
        } else {
            StartView(streamInfo: $streamInfo, autoStartRestreamer: !returningFromStream)
                .transition(.move(edge: .leading))
        }
    }
}
