import SwiftUI
import AVFoundation

/// First run: connect this phone to a club.
///
/// The club's admin view shows a QR code holding its address and a short-lived
/// code. Scanning it is the whole setup — no URL to type, no key to copy, and
/// nothing about the club compiled into the app.
struct PairingView: View {
    @StateObject private var pairing = Pairing.shared

    @State private var showManualEntry = false
    @State private var manualUrl = ""
    @State private var manualCode = ""
    @State private var isPairing = false
    @State private var error: String?
    @State private var scannerAuthorised: Bool?

    var body: some View {
        ZStack {
            Color.black.ignoresSafeArea()

            VStack(spacing: 24) {
                header

                if showManualEntry {
                    manualForm
                } else {
                    scanner
                }

                if let error {
                    Text(error)
                        .font(.footnote)
                        .foregroundStyle(.red)
                        .multilineTextAlignment(.center)
                        .padding(.horizontal, 32)
                }

                Button(showManualEntry ? "Skanna i stället" : "Skriv in koden manuellt") {
                    withAnimation { showManualEntry.toggle() }
                    error = nil
                }
                .font(.subheadline)
                .foregroundStyle(.secondary)

                Spacer(minLength: 0)
            }
            .padding(.top, 48)

            if isPairing {
                Color.black.opacity(0.6).ignoresSafeArea()
                ProgressView("Parar…").tint(.white).foregroundStyle(.white)
            }
        }
    }

    private var header: some View {
        VStack(spacing: 8) {
            Text("Anslut till din klubb")
                .font(.title2.bold())
                .foregroundStyle(.white)
            Text("Öppna klubbens adminvy och välj \u{201C}Lägg till kamera\u{201D}.")
                .font(.subheadline)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
                .padding(.horizontal, 32)
            // The app does nothing on its own, so say what it belongs to and
            // where to start — for a new user and for App Review alike.
            Link("Har ni ingen Courtside än? Starta en på courtside.apps.osaas.io",
                 destination: URL(string: "https://courtside.apps.osaas.io")!)
                .font(.footnote)
                .multilineTextAlignment(.center)
                .padding(.horizontal, 32)
        }
    }

    private var scanner: some View {
        Group {
            if scannerAuthorised == false {
                VStack(spacing: 12) {
                    Text("Kameratillstånd krävs för att skanna.")
                        .foregroundStyle(.secondary)
                    Button("Skriv in koden manuellt") { showManualEntry = true }
                        .buttonStyle(.borderedProminent)
                }
                .frame(maxWidth: .infinity, minHeight: 280)
            } else {
                QRScannerView { payload in
                    handleScan(payload)
                }
                .frame(width: 280, height: 280)
                .clipShape(RoundedRectangle(cornerRadius: 16))
                .overlay(
                    RoundedRectangle(cornerRadius: 16)
                        .stroke(Color.white.opacity(0.3), lineWidth: 2)
                )
            }
        }
        .task {
            if scannerAuthorised == nil {
                scannerAuthorised = await QRScannerView.requestAccess()
            }
        }
    }

    private var manualForm: some View {
        VStack(spacing: 16) {
            VStack(alignment: .leading, spacing: 6) {
                Text("Klubbens adress").font(.caption).foregroundStyle(.secondary)
                TextField("https://...", text: $manualUrl)
                    .textContentType(.URL)
                    .keyboardType(.URL)
                    .autocapitalization(.none)
                    .disableAutocorrection(true)
                    .textFieldStyle(.roundedBorder)
            }
            VStack(alignment: .leading, spacing: 6) {
                Text("Parningskod").font(.caption).foregroundStyle(.secondary)
                TextField("ABCD-2345", text: $manualCode)
                    .autocapitalization(.allCharacters)
                    .disableAutocorrection(true)
                    .textFieldStyle(.roundedBorder)
            }
            Button("Anslut") {
                Task { await pair(url: manualUrl, code: manualCode) }
            }
            .buttonStyle(.borderedProminent)
            .disabled(manualUrl.isEmpty || manualCode.isEmpty || isPairing)
            .frame(minHeight: 44)
        }
        .padding(.horizontal, 32)
    }

    private func handleScan(_ payload: String) {
        guard !isPairing else { return }
        guard let parsed = Pairing.parse(payload: payload) else {
            error = "Det där var inte en parningskod."
            return
        }
        Task { await pair(url: parsed.apiUrl, code: parsed.code) }
    }

    private func pair(url: String, code: String) async {
        isPairing = true
        error = nil
        defer { isPairing = false }
        do {
            try await pairing.pair(apiUrl: url, code: code, deviceName: "")
        } catch {
            self.error = error.localizedDescription
        }
    }
}

// MARK: - QR scanner

/// Thin wrapper over AVCaptureMetadataOutput. Reports each distinct payload once.
struct QRScannerView: UIViewControllerRepresentable {
    let onFound: (String) -> Void

    static func requestAccess() async -> Bool {
        switch AVCaptureDevice.authorizationStatus(for: .video) {
        case .authorized: return true
        case .notDetermined: return await AVCaptureDevice.requestAccess(for: .video)
        default: return false
        }
    }

    func makeUIViewController(context: Context) -> ScannerController {
        let controller = ScannerController()
        controller.onFound = onFound
        return controller
    }

    func updateUIViewController(_ controller: ScannerController, context: Context) {}

    final class ScannerController: UIViewController, AVCaptureMetadataOutputObjectsDelegate {
        var onFound: ((String) -> Void)?

        private let session = AVCaptureSession()
        private var preview: AVCaptureVideoPreviewLayer?
        private var lastPayload: String?

        override func viewDidLoad() {
            super.viewDidLoad()
            view.backgroundColor = .black

            guard let device = AVCaptureDevice.default(for: .video),
                  let input = try? AVCaptureDeviceInput(device: device),
                  session.canAddInput(input)
            else { return }
            session.addInput(input)

            let output = AVCaptureMetadataOutput()
            guard session.canAddOutput(output) else { return }
            session.addOutput(output)
            output.setMetadataObjectsDelegate(self, queue: .main)
            output.metadataObjectTypes = [.qr]

            let layer = AVCaptureVideoPreviewLayer(session: session)
            layer.videoGravity = .resizeAspectFill
            view.layer.addSublayer(layer)
            preview = layer
        }

        override func viewDidLayoutSubviews() {
            super.viewDidLayoutSubviews()
            preview?.frame = view.bounds
        }

        override func viewWillAppear(_ animated: Bool) {
            super.viewWillAppear(animated)
            guard !session.isRunning else { return }
            // startRunning blocks; keep it off the main thread.
            Task.detached { [session] in session.startRunning() }
        }

        override func viewWillDisappear(_ animated: Bool) {
            super.viewWillDisappear(animated)
            if session.isRunning { session.stopRunning() }
        }

        func metadataOutput(
            _ output: AVCaptureMetadataOutput,
            didOutput metadataObjects: [AVMetadataObject],
            from connection: AVCaptureConnection
        ) {
            guard let object = metadataObjects.first as? AVMetadataMachineReadableCodeObject,
                  let payload = object.stringValue,
                  payload != lastPayload
            else { return }
            lastPayload = payload
            onFound?(payload)
        }
    }
}
