# UI/UX modernization screenshots

These screenshots compare `origin/main` at `daa3b958ab28e9f530e310ac24c0c1bab1dcbc60` with this branch. They were captured in Chromium from the local PostgreSQL application using the same generated Japanese manuscript fixture.

| Surface | Viewport | Before | After |
| --- | ---: | --- | --- |
| Desktop writing | 1440 × 900 | [Screenshot](before/desktop-writing.png) | [Screenshot](after/desktop-writing.png) |
| Desktop research | 1440 × 900 | [Screenshot](before/desktop-research.png) | [Screenshot](after/desktop-research.png) |
| Desktop review | 1440 × 900 | [Screenshot](before/desktop-review.png) | [Screenshot](after/desktop-review.png) |
| Mobile writing | 390 × 844 | [Screenshot](before/mobile-writing.png) | [Screenshot](after/mobile-writing.png) |

The sample manuscript is synthetic. The screenshots contain no author content or credentials.

The implementation follows the accepted **Editing desk** composition in `VISUAL-SYSTEM.md`: keep the manuscript and current scene primary, with navigation and supporting context available beside it. The accepted **Reference room** option would place a catalog step between daily navigation and editing, so it was not selected. The visible difference in this change is the Mobile writing route: account, theme, and workspace-layout controls stay available from Settings while the writing view keeps its first screen for the scene and manuscript.
