import type { useLocation, useNavigate } from "../../../app/test-support/router";

// The test-source TypeScript check compiles this function without running it.
export function checkRouterTypes(navigate: ReturnType<typeof useNavigate>, location: ReturnType<typeof useLocation>): void {
  navigate(location.pathname);

  // @ts-expect-error A browser input event is not a history delta or a destination.
  navigate(new Event("popstate"));
  // @ts-expect-error The browser location's search component is a string.
  location.search.toFixed();
}
