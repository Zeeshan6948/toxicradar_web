import SwiftUI

struct ContentView: View {
    @EnvironmentObject private var manager: BiometricsManager
    @State private var code = ""

    var body: some View {
        ScrollView {
            if manager.needsPairing {
                pairingView
            } else {
                monitorView
            }
        }
        .navigationTitle("ToxicRadar")
    }

    private var pairingView: some View {
        VStack(spacing: 8) {
            Text("Enter the 6-digit code shown in ToxicRadar")
                .font(.footnote)
                .multilineTextAlignment(.center)
            TextField("123456", text: $code)
                .multilineTextAlignment(.center)
            Button("Pair") {
                Task { await manager.pair(code: code) }
            }
            .disabled(code.trimmingCharacters(in: .whitespaces).count != 6)
            Text(manager.statusMessage)
                .font(.caption2)
                .foregroundStyle(.secondary)
        }
        .padding(.horizontal)
    }

    private var monitorView: some View {
        VStack(spacing: 6) {
            HStack(spacing: 4) {
                Image(systemName: "heart.fill")
                    .foregroundStyle(.red)
                Text(manager.currentBPM > 0 ? "\(Int(manager.currentBPM))" : "--")
                    .font(.system(size: 40, weight: .bold, design: .rounded))
                Text("BPM").font(.caption2)
            }

            Text(manager.isStationary ? "Still" : "Moving")
                .font(.caption2)
                .foregroundStyle(.secondary)

            if manager.isRunning {
                Button("Stop", role: .destructive) { manager.stop() }
            } else {
                Button("Start monitoring") {
                    Task { await manager.start() }
                }
            }

            Label(manager.statusMessage,
                  systemImage: manager.lastUploadOK ? "checkmark.circle" : "circle.dashed")
                .font(.caption2)
                .foregroundStyle(manager.lastUploadOK ? Color.green : Color.secondary)

            Button("Unpair") { manager.unpair() }
                .font(.caption2)
                .buttonStyle(.plain)
                .foregroundStyle(.secondary)
        }
        .padding(.horizontal)
    }
}
