#if os(iOS)
import Foundation
import Security

struct RefreshKeychain: Sendable {
    private let account: String

    init(configuration: OAuthConfiguration) {
        self.account = [configuration.issuer.absoluteString, configuration.clientID, configuration.resource.absoluteString]
            .map { "\($0.utf8.count):\($0)" }.joined()
    }

    private var query: [String: Any] {
        [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: "jp.yohn.codexia.native.oauth",
            kSecAttrAccount as String: account,
            kSecAttrSynchronizable as String: false,
        ]
    }

    func read() throws -> String? {
        var lookup = query
        lookup[kSecReturnData as String] = true
        lookup[kSecMatchLimit as String] = kSecMatchLimitOne
        var item: CFTypeRef?
        let status = SecItemCopyMatching(lookup as CFDictionary, &item)
        if status == errSecItemNotFound { return nil }
        guard status == errSecSuccess else { throw OAuthError.keychain(status: status) }
        guard let data = item as? Data, let value = String(data: data, encoding: .utf8), validBearer(value) else {
            throw OAuthError.invalidToken
        }
        return value
    }

    func write(_ token: String) throws {
        let updates = [
            kSecValueData as String: Data(token.utf8),
            kSecAttrAccessible as String: kSecAttrAccessibleWhenUnlockedThisDeviceOnly,
        ] as [String: Any]
        let updated = SecItemUpdate(query as CFDictionary, updates as CFDictionary)
        if updated == errSecItemNotFound {
            var entry = query
            entry.merge(updates) { _, new in new }
            let inserted = SecItemAdd(entry as CFDictionary, nil)
            guard inserted == errSecSuccess else { throw OAuthError.keychain(status: inserted) }
        } else if updated != errSecSuccess {
            throw OAuthError.keychain(status: updated)
        }
    }

    func delete() throws {
        let status = SecItemDelete(query as CFDictionary)
        guard status == errSecSuccess || status == errSecItemNotFound else {
            throw OAuthError.keychain(status: status)
        }
    }
}
#endif
