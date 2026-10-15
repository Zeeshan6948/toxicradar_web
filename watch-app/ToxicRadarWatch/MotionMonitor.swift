import Foundation
import CoreMotion

/// Decides whether the wearer is sitting still, so a high heart rate from
/// walking or climbing stairs is not mistaken for stress or anger.
final class MotionMonitor {
    private let manager = CMMotionManager()
    private var magnitudes: [Double] = []
    private let windowSize = 50            // ~5 seconds at 10 Hz
    private let stationaryThreshold = 0.06 // g, std-dev of acceleration magnitude

    private(set) var isStationary = true

    func start() {
        guard manager.isAccelerometerAvailable, !manager.isAccelerometerActive else { return }
        manager.accelerometerUpdateInterval = 0.1
        manager.startAccelerometerUpdates(to: OperationQueue()) { [weak self] data, _ in
            guard let self, let a = data?.acceleration else { return }
            let magnitude = (a.x * a.x + a.y * a.y + a.z * a.z).squareRoot()
            self.magnitudes.append(magnitude)
            if self.magnitudes.count > self.windowSize {
                self.magnitudes.removeFirst(self.magnitudes.count - self.windowSize)
            }
            guard self.magnitudes.count == self.windowSize else { return }
            let mean = self.magnitudes.reduce(0, +) / Double(self.windowSize)
            let variance = self.magnitudes.reduce(0) { $0 + ($1 - mean) * ($1 - mean) } / Double(self.windowSize)
            self.isStationary = variance.squareRoot() < self.stationaryThreshold
        }
    }

    func stop() {
        manager.stopAccelerometerUpdates()
        magnitudes.removeAll()
        isStationary = true
    }
}
