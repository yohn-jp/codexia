import XCTest
@testable import CodexiaTransport

final class APITransportTests: XCTestCase {
    func testRequiresHTTPSAndOriginWithoutCredentials() throws {
        for text in ["http://api.example.test", "https://u:p@api.example.test", "https://api.example.test/other", "https://api.example.test/?x=1"] {
            XCTAssertThrowsError(try APITransport(origin: XCTUnwrap(URL(string: text))))
        }
        XCTAssertNoThrow(try APITransport(origin: XCTUnwrap(URL(string: "https://api.example.test"))))
    }

    func testRejectsUntrustedPathsBeforeNetwork() async throws {
        let transport = try APITransport(origin: XCTUnwrap(URL(string: "https://api.example.test")))
        for path in ["https://evil.test/api/projects", "//evil.test/api/projects", "/api/../admin", "/api/a?redirect=https://evil.test", "/mcp", "/api/a\\b"] {
            do {
                _ = try await transport.send(method: "GET", path: path, bearer: nil)
                XCTFail("Unexpected accepted path: \(path)")
            } catch APITransport.Failure.invalidPath { } catch {
                XCTFail("Unexpected error for \(path): \(error)")
            }
        }
    }

    func testRejectsInvalidMethodAndToken() async throws {
        let transport = try APITransport(origin: XCTUnwrap(URL(string: "https://api.example.test")))
        do {
            _ = try await transport.send(method: "GET\r\n", path: "/api/projects", bearer: nil)
            XCTFail("Invalid method accepted")
        } catch APITransport.Failure.invalidMethod { }
        do {
            _ = try await transport.send(method: "GET", path: "/api/projects", bearer: "bad\r\nheader")
            XCTFail("Invalid token accepted")
        } catch APITransport.Failure.insecureRequest { }
    }
}
