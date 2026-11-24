#if DEBUG
/// Deterministic synthetic text; it contains no author data.
public func manuscriptFixture(characterCount: Int) -> String {
    precondition(characterCount >= 0)
    let sample = "長い場面名——夏の終わりに見た夢。｜東京《とうきょう》で😀を書く。\r\n次の行。\n"
    return String(String(repeating: sample, count: characterCount / sample.count + 1).prefix(characterCount))
}

#endif
