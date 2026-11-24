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

    private func menuAction(_ label: String, in app: XCUIApplication) -> XCUIElement {
        app.descendants(matching: .any).matching(identifier: label).firstMatch
    }

    func testCopyAndPasteWithinTheAppChangesManuscript() {
        let app = XCUIApplication()
        openFixture(app)
        let editor = app.textViews["原稿本文"]
        XCTAssertTrue(editor.waitForExistence(timeout: 15))
        editor.tap()
        let before = editor.value as? String ?? ""
        XCTAssertFalse(before.isEmpty)
        editor.press(forDuration: 1.2)
        let selectAll = menuAction("Select All", in: app)
        XCTAssertTrue(selectAll.waitForExistence(timeout: 5))
        selectAll.tap()
        let copy = menuAction("Copy", in: app)
        XCTAssertTrue(copy.waitForExistence(timeout: 5))
        copy.tap()
        // Copy leaves a full-document selection. Reopen the same sample so the
        // Paste gesture starts in a fresh editor while retaining the app clipboard.
        app.buttons["戻る"].tap()
        let sample = app.buttons["CTRL-OUT-01.B.fixture.10000"]
        XCTAssertTrue(sample.waitForExistence(timeout: 10))
        sample.tap()
        XCTAssertTrue(editor.waitForExistence(timeout: 15))
        XCTAssertEqual(editor.value as? String, before)
        editor.tap()
        editor.press(forDuration: 1.2)
        let paste = menuAction("Paste", in: app)
        guard paste.waitForExistence(timeout: 5) else {
            XCTFail("Paste menu is unavailable after same-app Copy. UI: \(app.debugDescription)")
            return
        }
        paste.tap()
        let after = editor.value as? String ?? ""
        XCTAssertGreaterThan(after.utf16.count, before.utf16.count)
        XCTAssertNotEqual(after, before)
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
