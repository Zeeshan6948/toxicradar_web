import Foundation
import Security

/// Stores the upload token in the Keychain (not UserDefaults).
enum TokenStore {
    private static let service = "com.toxicradar.watch"
    private static let account = "uploadToken"

    static func save(_ token: String) {
        delete()
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
            kSecValueData as String: Data(token.utf8),
            kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlock
        ]
        SecItemAdd(query as CFDictionary, nil)
    }

    static func load() -> String? {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
            kSecReturnData as String: true,
            kSecMatchLimit as String: kSecMatchLimitOne
        ]
        var item: CFTypeRef?
        guard SecItemCopyMatching(query as CFDictionary, &item) == errSecSuccess,
              let data = item as? Data else { return nil }
        return String(data: data, encoding: .utf8)
    }

    static func delete() {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account
        ]
        SecItemDelete(query as CFDictionary)
    }
}

enum APIError: LocalizedError {
    case invalidURL
    case server(String)
    case unauthorized

    var errorDescription: String? {
        switch self {
        case .invalidURL: return "Server address is invalid."
        case .server(let message): return message
        case .unauthorized: return "Session expired. Pair again."
        }
    }
}

struct SamplePayload: Encodable {
    let bpm: Double
    let hrv: Double?
    let restingBpm: Double?
    let isStationary: Bool
    let timestamp: Double
}

private struct PairResponse: Decodable { let token: String }
private struct ErrorResponse: Decodable { let error: String }

enum APIClient {
    private static func url(_ path: String) throws -> URL {
        guard let url = URL(string: Config.serverURL + path), url.scheme == "https" else {
            throw APIError.invalidURL
        }
        return url
    }

    /// Exchanges the 6-digit code shown in the ToxicRadar web app for an upload token.
    static func pair(code: String) async throws {
        var request = URLRequest(url: try url("/api/biometrics/pair/confirm"))
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try JSONEncoder().encode(["code": code])

        let (data, response) = try await URLSession.shared.data(for: request)
        guard let http = response as? HTTPURLResponse else { throw APIError.server("No response.") }
        guard http.statusCode == 200 else {
            let message = (try? JSONDecoder().decode(ErrorResponse.self, from: data))?.error
            throw APIError.server(message ?? "Pairing failed (\(http.statusCode)).")
        }
        let decoded = try JSONDecoder().decode(PairResponse.self, from: data)
        TokenStore.save(decoded.token)
    }

    static func send(_ sample: SamplePayload) async throws {
        guard let token = TokenStore.load() else { throw APIError.unauthorized }
        var request = URLRequest(url: try url("/api/biometrics"))
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        request.httpBody = try JSONEncoder().encode(sample)

        let (data, response) = try await URLSession.shared.data(for: request)
        guard let http = response as? HTTPURLResponse else { throw APIError.server("No response.") }
        if http.statusCode == 401 {
            TokenStore.delete()
            throw APIError.unauthorized
        }
        guard http.statusCode == 200 else {
            let message = (try? JSONDecoder().decode(ErrorResponse.self, from: data))?.error
            throw APIError.server(message ?? "Upload failed (\(http.statusCode)).")
        }
    }
}
