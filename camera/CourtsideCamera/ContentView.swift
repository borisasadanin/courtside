import SwiftUI

struct ContentView: View {
    @State private var streamInfo: StreamInfo?
    @State private var returningFromStream = false

    var body: some View {
        if let info = streamInfo {
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
