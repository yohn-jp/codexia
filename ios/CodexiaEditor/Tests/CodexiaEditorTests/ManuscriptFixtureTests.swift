import XCTest

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

/// Deterministic source text for simulator and device measurement, not a benchmark result.
func manuscriptFixture(characterCount: Int) -> String {
    let sample = "長い場面名——夏の終わりに見た夢。｜東京《とうきょう》で😀を書く。\r\n次の行。\n"
    return String(String(repeating: sample, count: characterCount / sample.count + 1).prefix(characterCount))
}
