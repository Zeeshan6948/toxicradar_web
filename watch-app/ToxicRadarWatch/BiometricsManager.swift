import Foundation
import HealthKit

/// Reads live heart rate through a HealthKit workout session (the only way watchOS
/// delivers continuous readings), plus HRV and resting heart rate, and uploads them.
/// The workout is discarded when stopped, so nothing is written to the Health app.
@MainActor
final class BiometricsManager: NSObject, ObservableObject {
    @Published private(set) var isRunning = false
    @Published private(set) var currentBPM: Double = 0
    @Published private(set) var hrv: Double?
    @Published private(set) var restingBPM: Double?
    @Published private(set) var isStationary = true
    @Published private(set) var lastUploadOK = false
    @Published var statusMessage = "Ready"
    @Published var needsPairing = TokenStore.load() == nil

    private let healthStore = HKHealthStore()
    private let motion = MotionMonitor()
    private var session: HKWorkoutSession?
    private var builder: HKLiveWorkoutBuilder?
    private var uploadTask: Task<Void, Never>?
    private var lastSlowRefresh = Date.distantPast

    private let heartRateType = HKQuantityType(.heartRate)
    private let hrvType = HKQuantityType(.heartRateVariabilitySDNN)
    private let restingType = HKQuantityType(.restingHeartRate)

    // MARK: Pairing

    func pair(code: String) async {
        statusMessage = "Pairing..."
        do {
            try await APIClient.pair(code: code.trimmingCharacters(in: .whitespaces))
            needsPairing = false
            statusMessage = "Paired"
        } catch {
            statusMessage = error.localizedDescription
        }
    }

    func unpair() {
        stop()
        TokenStore.delete()
        needsPairing = true
        statusMessage = "Unpaired"
    }

    // MARK: Authorization

    private func requestAuthorization() async -> Bool {
        guard HKHealthStore.isHealthDataAvailable() else {
            statusMessage = "Health data unavailable"
            return false
        }
        let toShare: Set<HKSampleType> = [HKObjectType.workoutType()]
        let toRead: Set<HKObjectType> = [heartRateType, hrvType, restingType]
        do {
            try await healthStore.requestAuthorization(toShare: toShare, read: toRead)
            return true
        } catch {
            statusMessage = "Health access denied"
            return false
        }
    }

    // MARK: Start / Stop

    func start() async {
        guard !isRunning else { return }
        guard await requestAuthorization() else { return }

        let configuration = HKWorkoutConfiguration()
        configuration.activityType = .mindAndBody
        configuration.locationType = .indoor

        do {
            let session = try HKWorkoutSession(healthStore: healthStore, configuration: configuration)
            let builder = session.associatedWorkoutBuilder()
            builder.dataSource = HKLiveWorkoutDataSource(healthStore: healthStore, workoutConfiguration: configuration)
            session.delegate = self
            builder.delegate = self
            self.session = session
            self.builder = builder

            let startDate = Date()
            session.startActivity(with: startDate)
            try await builder.beginCollection(at: startDate)
        } catch {
            statusMessage = "Could not start: \(error.localizedDescription)"
            return
        }

        motion.start()
        isRunning = true
        statusMessage = "Monitoring"
        lastSlowRefresh = .distantPast
        startUploadLoop()
    }

    func stop() {
        uploadTask?.cancel()
        uploadTask = nil
        motion.stop()
        session?.end()
        let builder = self.builder
        Task {
            try? await builder?.endCollection(at: Date())
            builder?.discardWorkout() // keep Health data clean: do not save a workout
        }
        session = nil
        self.builder = nil
        isRunning = false
        currentBPM = 0
        if !needsPairing { statusMessage = "Stopped" }
    }

    // MARK: Upload loop

    private func startUploadLoop() {
        uploadTask?.cancel()
        uploadTask = Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(nanoseconds: Config.uploadIntervalSeconds * 1_000_000_000)
                guard let self, !Task.isCancelled else { return }
                await self.tick()
            }
        }
    }

    private func tick() async {
        if Date().timeIntervalSince(lastSlowRefresh) > Config.slowMetricsRefreshSeconds {
            lastSlowRefresh = Date()
            hrv = await latestValue(for: hrvType, unit: HKUnit.secondUnit(with: .milli))
            restingBPM = await latestValue(for: restingType, unit: HKUnit.count().unitDivided(by: .minute()))
        }

        isStationary = motion.isStationary
        guard currentBPM > 0 else { return } // no reading yet

        let payload = SamplePayload(
            bpm: currentBPM,
            hrv: hrv,
            restingBpm: restingBPM,
            isStationary: isStationary,
            timestamp: Date().timeIntervalSince1970
        )
        do {
            try await APIClient.send(payload)
            lastUploadOK = true
            statusMessage = "Monitoring"
        } catch let error as APIError {
            lastUploadOK = false
            if case .unauthorized = error {
                needsPairing = true
                stop()
            }
            statusMessage = error.localizedDescription
        } catch {
            lastUploadOK = false
            statusMessage = "Offline - retrying"
        }
    }

    private func latestValue(for type: HKQuantityType, unit: HKUnit) async -> Double? {
        await withCheckedContinuation { continuation in
            let sort = NSSortDescriptor(key: HKSampleSortIdentifierEndDate, ascending: false)
            let query = HKSampleQuery(sampleType: type, predicate: nil, limit: 1, sortDescriptors: [sort]) { _, samples, _ in
                let value = (samples?.first as? HKQuantitySample)?.quantity.doubleValue(for: unit)
                continuation.resume(returning: value)
            }
            healthStore.execute(query)
        }
    }
}

// MARK: - HealthKit delegates

extension BiometricsManager: HKWorkoutSessionDelegate {
    nonisolated func workoutSession(_ workoutSession: HKWorkoutSession,
                                    didChangeTo toState: HKWorkoutSessionState,
                                    from fromState: HKWorkoutSessionState,
                                    date: Date) {}

    nonisolated func workoutSession(_ workoutSession: HKWorkoutSession, didFailWithError error: Error) {
        let message = error.localizedDescription
        Task { @MainActor in
            self.statusMessage = "Session error: \(message)"
            self.stop()
        }
    }
}

extension BiometricsManager: HKLiveWorkoutBuilderDelegate {
    nonisolated func workoutBuilderDidCollectEvent(_ workoutBuilder: HKLiveWorkoutBuilder) {}

    nonisolated func workoutBuilder(_ workoutBuilder: HKLiveWorkoutBuilder,
                                    didCollectDataOf collectedTypes: Set<HKSampleType>) {
        let type = HKQuantityType(.heartRate)
        guard collectedTypes.contains(type),
              let quantity = workoutBuilder.statistics(for: type)?.mostRecentQuantity() else { return }
        let bpm = quantity.doubleValue(for: HKUnit.count().unitDivided(by: .minute()))
        Task { @MainActor in
            self.currentBPM = bpm
        }
    }
}
