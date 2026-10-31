import SwiftUI

struct ContentView: View {
    @StateObject private var pairing = Pairing.shared
    @State private var streamInfo: StreamInfo?

    var body: some View {
        screen
            .alert(
                "Parningskoden användes inte",
                isPresented: Binding(
                    get: { pairing.linkNotice != nil },
                    set: { if !$0 { pairing.linkNotice = nil } }
                )
            ) {
                Button("OK", role: .cancel) {}
            } message: {
                Text(pairing.linkNotice ?? "")
            }
    }

    @ViewBuilder
    private var screen: some View {
        if !pairing.isPaired {
            // Nothing can be done before the camera knows which club it serves.
            PairingView()
                .transition(.opacity)
        } else if let info = streamInfo {
            StreamView(streamInfo: info) {
                streamInfo = nil
            }
            .transition(.move(edge: .trailing))
        } else {
            StartView(streamInfo: $streamInfo)
                .transition(.move(edge: .leading))
        }
    }
}
