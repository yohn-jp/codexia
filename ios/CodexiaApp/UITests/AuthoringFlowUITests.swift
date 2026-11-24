import XCTest

final class AuthoringFlowUITests: XCTestCase {
    private func openFixture(_ app: XCUIApplication) {
        app.launchArguments += ["--codexia-fixture-editor"]
        app.launchArguments += ["-AppleLanguages", "(en)", "-AppleLocale", "en_US"]
        app.launch()
        app.buttons["サンプル作品"].tap()
        app.buttons["構成と原稿"].tap()
        app.buttons["CTRL-OUT-01.B.fixture.10000"].tap()
    }

    func testSignedOutShellOffersSystemAccountEntryAndHidesFixture() {
        let app = XCUIApplication()
        app.launchArguments += ["-AppleLanguages", "(en)", "-AppleLocale", "en_US"]
        app.launch()

        XCTAssertTrue(app.navigationBars["ライブラリ"].waitForExistence(timeout: 15))
        XCTAssertTrue(app.buttons["account.signIn"].waitForExistence(timeout: 15))
        XCTAssertTrue(app.buttons["account.entry"].exists)
        XCTAssertFalse(app.buttons["サンプル作品"].exists)

        app.buttons["account.entry"].tap()
        XCTAssertTrue(app.navigationBars["アカウント"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.staticTexts["サインインしていません"].exists)
    }

    func testNativeCopyAndPasteAcrossFixtureReopen() {
        let app = XCUIApplication()
        app.launchArguments += ["--codexia-test-clipboard"]
        openFixture(app)

        let editor = app.textViews["原稿本文"]
        XCTAssertTrue(editor.waitForExistence(timeout: 15))
        let before = editor.value as? String ?? ""
        XCTAssertFalse(before.isEmpty)
        editor.tap()
        app.buttons["fixture.clipboard.copy"].tap()

        app.buttons["戻る"].tap()
        let scene = app.buttons["CTRL-OUT-01.B.fixture.10000"]
        XCTAssertTrue(scene.waitForExistence(timeout: 10))
        scene.tap()
        XCTAssertTrue(editor.waitForExistence(timeout: 15))
        XCTAssertEqual(editor.value as? String, before)

        editor.tap()
        app.buttons["fixture.clipboard.paste"].tap()
        let pasted = NSPredicate { _, _ in
            guard let after = editor.value as? String else { return false }
            return after.utf16.count == before.utf16.count * 2 && after.contains(before)
        }
        let expectation = XCTNSPredicateExpectation(predicate: pasted, object: editor)
        XCTAssertEqual(XCTWaiter.wait(for: [expectation], timeout: 15), .completed)
    }

    func testUnprotectedTextSurvivesBackGuardAndHomeRoundTrip() {
        let app = XCUIApplication()
        openFixture(app)
        let editor = app.textViews["原稿本文"]
        XCTAssertTrue(editor.waitForExistence(timeout: 15))
        editor.tap()
        editor.typeText("SceneProof")
        XCTAssertTrue((editor.value as? String ?? "").contains("SceneProof"))
        app.buttons["戻る"].tap()
        let guardAlert = app.alerts["原稿はまだ保護されていません"]
        XCTAssertTrue(guardAlert.waitForExistence(timeout: 5))
        guardAlert.buttons["編集を続ける"].tap()
        XCTAssertTrue((editor.value as? String ?? "").contains("SceneProof"))
        XCUIDevice.shared.press(.home)
        app.activate()
        XCTAssertTrue(editor.waitForExistence(timeout: 15))
        XCTAssertTrue((editor.value as? String ?? "").contains("SceneProof"))
    }
}
