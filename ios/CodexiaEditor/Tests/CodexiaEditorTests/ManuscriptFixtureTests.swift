import XCTest
@testable import CodexiaEditor

final class ManuscriptFixtureTests: XCTestCase {
    func testFixtureSizesAndMixedContent() {
        for size in [10_000, 100_000, 500_000] {
            let text = manuscriptFixture(characterCount: size)
            XCTAssertEqual(text.count, size)
            XCTAssertTrue(text.contains("《"))
            XCTAssertTrue(text.contains("😀"))
            XCTAssertTrue(text.contains("\r\n"))
        }
    }
}
