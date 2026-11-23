# iOS native writing interactions

**Accepted SwiftUI target; implementation and physical-device acceptance unverified.** This document supersedes Ionic React Mobile Web interactions. See [Native iOS architecture](IOS-SWIFTUI-ARCHITECTURE.md), [User flows](../design/USER-SCREEN-FLOW.md) and [UX contract](../design/UX-CONTRACT.md).

| Step | Native interaction and outcome |
| --- | --- |
| Resume | Load authorized project/document and reconcile the protected native journal with server Revision/receipt |
| Write | UIKit UITextView/TextKit 2 owns Japanese marked text, caret, selection, undo, layout and scrolling. SwiftUI updates do not replace pending composition |
| Refer | Native SwiftUI sheet/popover displays Outline/Knowledge/Save details without destroying the editor buffer; leaving the document requires the protection guard |
| Return | Back/dismiss preserves the work context and safe focus; closing an animation does not prove save |
| Change scene | Protect pending local edits first; refuse navigation when protection fails |
| Background/relaunch | Recover local draft and unknown operation identity, distinguish unsaved from confirmed PostgreSQL revision |
| Conflict | Preserve draft, base revision and operation identity; explicit author decision, never force-overwrite |

SwiftUI owns presentation, the native authoring coordinator owns client recovery, and the Fastify/Core/API owns authorization, mutation and canonical storage. Verify physical-iPhone Japanese IME, keyboard, safe area, VoiceOver, long-text typing latency, memory and scroll hitches. Mobile React viewport/Ionic/WKWebView E2E is not accepted native evidence or a future release gate. Retire those legacy tests at the code cutover.
