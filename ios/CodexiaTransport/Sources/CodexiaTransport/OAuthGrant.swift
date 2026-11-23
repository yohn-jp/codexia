#if canImport(CryptoKit)
import CryptoKit
import Foundation

func base64URL(_ bytes: some DataProtocol) -> String {
    Data(bytes).base64EncodedString()
        .replacingOccurrences(of: "+", with: "-")
        .replacingOccurrences(of: "/", with: "_")
        .replacingOccurrences(of: "=", with: "")
}

private func dataFromBase64URL(_ value: Substring) throws -> Data {
    guard !value.isEmpty, value.utf8.allSatisfy({
        (65...90).contains($0) || (97...122).contains($0) || (48...57).contains($0) || $0 == 45 || $0 == 95
    }) else { throw OAuthError.invalidToken }
    let text = value.replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
    let padding = String(repeating: "=", count: (4 - text.count % 4) % 4)
    guard let decoded = Data(base64Encoded: text + padding) else { throw OAuthError.invalidToken }
    return decoded
}

struct OAuthTokenResponse: Decodable, Sendable {
    let access_token: String
    let refresh_token: String?
    let id_token: String?
    let token_type: String
    let scope: String
    let expires_in: Double
}

struct OAuthSigningKeys: Decodable, Sendable {
    struct Key: Decodable, Sendable {
        let kid: String
        let alg: String?
        let use: String?
        let kty: String
        let crv: String?
        let x: String?
        let y: String?
    }

    let keys: [Key]
}

struct OAuthGrant: Sendable {
    let accessToken: String
    let subject: String
    let expiresAt: Date

    init(
        response: OAuthTokenResponse, keys: OAuthSigningKeys, config: OAuthConfiguration,
        nonce: String?, now: Date = Date()
    ) throws {
        let scopes = Set(response.scope.split(separator: " ").map(String.init))
        guard response.token_type.lowercased() == "bearer", response.expires_in > 0,
              response.expires_in.isFinite, scopes.contains("codexia:api"),
              OAuthConfiguration.scopes.isSuperset(of: scopes) else { throw OAuthError.invalidToken }
        let access = try Self.verifiedClaims(response.access_token, keys: keys)
        let resource = config.resource.absoluteString
        let userInfo = config.issuer.appending(path: "oauth2/userinfo").absoluteString
        let audiences = Set(access.claims.audiences)
        // Better Auth adds its own UserInfo audience when the original
        // authorization request includes openid, even if API scopes are narrowed.
        guard access.header.typ == "at+jwt", audiences.count == access.claims.audiences.count,
              audiences.contains(resource), audiences.isSubset(of: [resource, userInfo]),
              access.claims.client_id == config.clientID, access.claims.jti?.isEmpty == false,
              Set(access.claims.scope?.split(separator: " ").map(String.init) ?? []) == scopes,
              access.claims.valid(for: config, now: now) else { throw OAuthError.invalidToken }

        // The configured API resource filters out the OIDC scope. When the
        // provider issues an ID token, bind it to this grant and login nonce.
        if let token = response.id_token {
            let identity = try Self.verifiedClaims(token, keys: keys)
            let hash = base64URL(Data(SHA256.hash(data: Data(response.access_token.utf8)).prefix(16)))
            guard identity.header.typ != "at+jwt",
                  identity.claims.audiences == [config.clientID],
                  identity.claims.azp == nil || identity.claims.azp == config.clientID,
                  identity.claims.sub == access.claims.sub,
                  identity.claims.nonce == nonce,
                  identity.claims.at_hash == hash,
                  identity.claims.valid(for: config, now: now) else { throw OAuthError.invalidToken }
        } else if scopes.contains("openid"), nonce != nil {
            throw OAuthError.invalidToken
        }
        self.accessToken = response.access_token
        self.subject = access.claims.sub
        self.expiresAt = min(Date(timeIntervalSince1970: access.claims.exp), now.addingTimeInterval(response.expires_in))
    }

    private struct Header: Decodable {
        let alg: String
        let kid: String
        let typ: String?
        let crit: [String]?
    }

    private struct Claims: Decodable {
        let iss: String
        let sub: String
        let aud: Audience
        let exp: Double
        let iat: Double
        let nbf: Double?
        let client_id: String?
        let azp: String?
        let jti: String?
        let scope: String?
        let nonce: String?
        let at_hash: String?

        var audiences: [String] { aud.values }

        func valid(for config: OAuthConfiguration, now: Date) -> Bool {
            let time = now.timeIntervalSince1970
            return iss == config.issuer.absoluteString && !sub.isEmpty && exp > time
                && iat <= time + 30 && iat < exp && (nbf ?? iat) <= time + 30
        }

        struct Audience: Decodable {
            let values: [String]
            init(from decoder: any Decoder) throws {
                let value = try decoder.singleValueContainer()
                if let single = try? value.decode(String.self) { values = [single] }
                else { values = try value.decode([String].self) }
            }
        }
    }

    private static func verifiedClaims(
        _ token: String, keys: OAuthSigningKeys
    ) throws -> (header: Header, claims: Claims) {
        guard validBearer(token), token.utf8.count <= 16_384 else { throw OAuthError.invalidToken }
        let parts = token.split(separator: ".", omittingEmptySubsequences: false)
        guard parts.count == 3 else { throw OAuthError.invalidToken }
        let decoder = JSONDecoder()
        do {
            let header = try decoder.decode(Header.self, from: dataFromBase64URL(parts[0]))
            let matches = keys.keys.filter { $0.kid == header.kid }
            guard header.alg == "ES256", header.crit == nil, !header.kid.isEmpty,
                  matches.count == 1, let key = matches.first, key.kty == "EC", key.crv == "P-256",
                  key.alg == nil || key.alg == "ES256", key.use == nil || key.use == "sig",
                  let x = key.x, let y = key.y else { throw OAuthError.invalidToken }
            let xBytes = try dataFromBase64URL(x[...])
            let yBytes = try dataFromBase64URL(y[...])
            guard xBytes.count == 32, yBytes.count == 32 else { throw OAuthError.invalidToken }
            let publicKey = try P256.Signing.PublicKey(x963Representation: Data([4]) + xBytes + yBytes)
            let signature = try P256.Signing.ECDSASignature(rawRepresentation: dataFromBase64URL(parts[2]))
            let signed = Data("\(parts[0]).\(parts[1])".utf8)
            guard publicKey.isValidSignature(signature, for: signed) else { throw OAuthError.invalidToken }
            return (header, try decoder.decode(Claims.self, from: dataFromBase64URL(parts[1])))
        } catch {
            throw OAuthError.invalidToken
        }
    }
}
#endif
