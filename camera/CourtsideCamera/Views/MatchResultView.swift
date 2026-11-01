import SwiftUI

/// A match that has just been stopped, waiting for its result.
struct FinishedMatch: Identifiable {
    /// The stream id, which is also the recording's id.
    let id: String
    /// The club's own team, entered first.
    let homeTeam: String
    let awayTeam: String
}

/// Asked once the broadcast has ended: how did the match finish?
///
/// The result shows on the recording's card on the website. Skipping is always
/// fine — plenty of youth matches keep no score, and the club's admin can set it
/// in Hantera afterwards.
struct MatchResultView: View {
    let match: FinishedMatch
    let onDone: () -> Void

    private enum Field { case home, away }

    @State private var home = ""
    @State private var away = ""
    @State private var isSaving = false
    @State private var saved = false
    @State private var errorMessage: String?
    @FocusState private var focus: Field?
    @StateObject private var club = Club.shared

    private var canSave: Bool {
        Self.isScore(home) && Self.isScore(away) && !isSaving && !saved
    }

    var body: some View {
        NavigationStack {
            VStack(alignment: .leading, spacing: 20) {
                Text("Hur slutade matchen? Resultatet syns på matchkortet.")
                    .font(.subheadline)
                    .foregroundColor(.white.opacity(0.7))

                VStack(spacing: 12) {
                    scoreRow(match.homeTeam, text: $home, field: .home)
                    scoreRow(match.awayTeam, text: $away, field: .away)
                }

                if let errorMessage {
                    Text(errorMessage)
                        .font(.footnote)
                        .foregroundColor(.red)
                        .fixedSize(horizontal: false, vertical: true)
                }

                Button(action: save) {
                    HStack(spacing: 8) {
                        if isSaving {
                            ProgressView().tint(club.onAccent)
                        } else if saved {
                            Image(systemName: "checkmark")
                        }
                        Text(saved ? "Sparat" : (errorMessage == nil ? "Spara" : "Försök igen"))
                            .fontWeight(.semibold)
                    }
                    .frame(maxWidth: .infinity, minHeight: 50)
                    .background(club.accent.opacity(canSave || saved ? 1 : 0.4))
                    .foregroundColor(club.onAccent)
                    .cornerRadius(10)
                }
                .disabled(!canSave)

                Spacer(minLength: 0)
            }
            .padding(20)
            .navigationTitle("Resultat")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Hoppa över", action: onDone)
                        .disabled(isSaving || saved)
                }
                ToolbarItemGroup(placement: .keyboard) {
                    Spacer()
                    if focus == .home {
                        Button("Nästa") { focus = .away }
                    } else {
                        Button("Spara", action: save).disabled(!canSave)
                    }
                }
            }
        }
        .interactiveDismissDisabled(isSaving)
        .onAppear {
            // Straight into the own team's score.
            focus = .home
        }
    }

    private func scoreRow(_ team: String, text: Binding<String>, field: Field) -> some View {
        HStack(spacing: 12) {
            Text(team)
                .font(.headline)
                .foregroundColor(.white)
                .lineLimit(2)
                .frame(maxWidth: .infinity, alignment: .leading)
            TextField("0", text: text)
                .keyboardType(.numberPad)
                .multilineTextAlignment(.center)
                .font(.title.bold().monospacedDigit())
                .frame(width: 96, height: 56)
                .background(Color(white: 0.12))
                .cornerRadius(10)
                .overlay(
                    RoundedRectangle(cornerRadius: 10)
                        .stroke(focus == field ? club.accent : Color.clear, lineWidth: 2)
                )
                .focused($focus, equals: field)
                .accessibilityLabel("Poäng för \(team)")
                .onChange(of: text.wrappedValue) { value in
                    // Digits only, at most three: what the club accepts.
                    let digits = String(value.filter(\.isNumber).prefix(3))
                    if digits != value { text.wrappedValue = digits }
                }
        }
    }

    private func save() {
        guard canSave, let h = Int(home), let a = Int(away) else { return }
        isSaving = true
        errorMessage = nil
        Task {
            do {
                try await APIService.shared.setResult(streamId: match.id, home: h, away: a)
                isSaving = false
                saved = true
                focus = nil
                try? await Task.sleep(for: .seconds(1))
                onDone()
            } catch {
                isSaving = false
                errorMessage = "Kunde inte spara (\(error.localizedDescription)). Försök igen, eller hoppa över – admin kan sätta resultatet i Hantera."
            }
        }
    }

    private static func isScore(_ s: String) -> Bool {
        !s.isEmpty && s.count <= 3 && s.allSatisfy(\.isNumber)
    }
}
