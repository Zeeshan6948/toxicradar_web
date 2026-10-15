import SwiftUI

@main
struct ToxicRadarWatchApp: App {
    @StateObject private var manager = BiometricsManager()

    var body: some Scene {
        WindowGroup {
            ContentView()
                .environmentObject(manager)
        }
    }
}
