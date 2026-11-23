import type { BrowserModuleContext, BrowserModuleDefinition } from "@codexia/contracts";

type Cleanup = Array<() => void>;
type RecordValue = Record<string, unknown>;

function element<K extends keyof HTMLElementTagNameMap>(tag: K, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  return node;
}

function button(text: string): HTMLButtonElement {
  const node = element("button", text);
  node.type = "button";
  return node;
}

function input(placeholder: string): HTMLInputElement {
  const node = element("input");
  node.placeholder = placeholder;
  return node;
}

function field(label: string, control: HTMLElement): HTMLLabelElement {
  const node = element("label");
  node.style.display = "grid";
  node.style.gap = "0.35rem";
  node.append(element("span", label), control);
  return node;
}

function section(title: string): HTMLElement {
  const node = element("section");
  node.style.display = "grid";
  node.style.gap = "0.5rem";
  node.style.marginBlock = "0.75rem";
  node.append(element("h4", title));
  return node;
}

function bind(
  node: HTMLElement,
  handler: () => void,
  cleanup: Cleanup,
): void {
  node.addEventListener("click", handler);
  cleanup.push(() => node.removeEventListener("click", handler));
}

function status(): HTMLOutputElement {
  const node = element("output");
  node.setAttribute("aria-live", "polite");
  node.style.display = "block";
  return node;
}

async function runAction(
  context: BrowserModuleContext,
  name: string,
  args: RecordValue,
  trigger: HTMLButtonElement,
  outcome: HTMLOutputElement,
  result: HTMLElement,
  onSuccess?: (data: RecordValue) => void,
  stillCurrent?: () => boolean,
): Promise<void> {
  trigger.disabled = true;
  outcome.textContent = "処理しています…";
  result.replaceChildren();
  try {
    const response = await context.invoke(name, args);
    if (context.signal.aborted || (stillCurrent && !stillCurrent())) return;
    if (!response.ok) throw new Error(response.error.message);
    const data = response.data !== null && typeof response.data === "object" && !Array.isArray(response.data)
      ? response.data as RecordValue : {};
    result.append(element("pre", JSON.stringify(data, null, 2)));
    outcome.textContent = "完了しました。";
    onSuccess?.(data);
  } catch (error) {
    if (!context.signal.aborted) outcome.textContent = error instanceof Error ? error.message : "処理できませんでした。";
  } finally {
    if (!context.signal.aborted) trigger.disabled = false;
  }
}

function mountRewrite(root: HTMLElement, context: BrowserModuleContext, cleanup: Cleanup): void {
  root.append(element("p", "ローカルのヒューリスティックで文章候補を作ります。外部の生成AIへ原稿を送信しません。"));
  const scene = input("scene ID");
  const selected = element("textarea");
  selected.rows = 3;
  selected.placeholder = "対象文（任意。未指定なら文番号0）";
  const run = button("ローカル候補を表示");
  const message = status();
  const result = element("div");
  const proposals = section("変更案として提案");
  proposals.hidden = true;
  let generation = 0;
  const invalidate = () => {
    generation++;
    proposals.hidden = true;
    proposals.replaceChildren();
    result.replaceChildren();
    message.textContent = "";
  };
  scene.addEventListener("input", invalidate);
  selected.addEventListener("input", invalidate);
  cleanup.push(() => scene.removeEventListener("input", invalidate), () => selected.removeEventListener("input", invalidate));
  bind(run, () => {
    const request = ++generation;
    const sceneId = scene.value.trim();
    const selection = selected.value;
    proposals.hidden = true;
    proposals.replaceChildren();
    void runAction(context, "assistant.rewrite", {
      sceneId,
      ...(selection ? { selectedText: selection } : {}),
    }, run, message, result, (value) => {
      proposals.replaceChildren(element("h4", "候補から選ぶ"));
      proposals.hidden = false;
      const suggestions = Array.isArray(value.suggestions) ? value.suggestions : [];
      for (const candidate of suggestions) {
        if (!candidate || typeof candidate !== "object") continue;
        const rewrite = (candidate as RecordValue).text;
        if (typeof rewrite !== "string" || !rewrite) continue;
        const propose = button("この候補をレビューへ送る");
        const proposeStatus = status();
        const proposeResult = element("div");
        bind(propose, () => {
          void runAction(context, "assistant.rewrite.propose", {
            sceneId,
            selectedText: String(value.text ?? ""),
            replacementText: rewrite,
            ...(typeof value.sentenceIndex === "number" ? { sentenceIndex: value.sentenceIndex } : {}),
          }, propose, proposeStatus, proposeResult);
        }, cleanup);
        proposals.append(element("p", rewrite), propose, proposeStatus, proposeResult);
      }
    }, () => generation === request && scene.value.trim() === sceneId && selected.value === selection);
  }, cleanup);
  root.append(field("シーンID", scene), field("対象文", selected), run, message, result, proposals);
}

function mountAspect(root: HTMLElement, context: BrowserModuleContext, cleanup: Cleanup): void {
  root.append(element("p", "決定的なローカル解析で章のテンポ、視点移動、説明の重なりを確認します。"));
  const chapter = input("chapter ID");
  const labels = [["tempo", "テンポ"], ["pov-shift", "視点移動"], ["over-explain", "説明過多"]] as const;
  const checkboxes = labels.map(([value, label]) => {
    const node = element("input");
    node.type = "checkbox";
    node.value = value;
    node.checked = true;
    return { node, label: field(label, node) };
  });
  const selected = () => checkboxes.filter(({ node }) => node.checked).map(({ node }) => node.value);
  const analyze = button("章をレビュー");
  const preview = button("プロンプトを表示");
  const outcome = status(), previewStatus = status();
  const result = element("div"), prompt = element("div");
  bind(analyze, () => void runAction(context, "assistant.aspect.review", {
    chapterId: chapter.value.trim(), aspects: selected(),
  }, analyze, outcome, result), cleanup);
  bind(preview, () => void runAction(context, "assistant.aspect.review.preview", {
    chapterId: chapter.value.trim(), aspects: selected(),
  }, preview, previewStatus, prompt), cleanup);
  const options = section("観点");
  for (const item of checkboxes) options.append(item.label);
  root.append(field("章ID", chapter), options, analyze, outcome, result, preview, previewStatus, prompt);
}

function mountContext(root: HTMLElement, context: BrowserModuleContext, cleanup: Cleanup): void {
  root.append(element("p", "同一スナップショットのStoryコンテキストを準備します。生成は外部MCPクライアント側で実行します。"));
  const scene = input("scene ID"), question = input("質問・用途"), character = input("character ID");
  const scope = element("select");
  for (const value of ["author", "character", "reader"]) {
    const option = element("option", value);
    option.value = value;
    scope.append(option);
  }
  const purpose = element("select");
  for (const value of ["setting-qa", "continuation-options", "first-read-reaction"]) {
    const option = element("option", value);
    option.value = value;
    purpose.append(option);
  }
  const view = button("コンテキストを表示");
  const prompt = button("プロンプトを表示");
  const outcome = status(), promptStatus = status();
  const result = element("div"), promptResult = element("div");
  const request = () => ({
    sceneId: scene.value.trim(),
    scope: scope.value,
    ...(scope.value === "character" ? { characterId: character.value.trim() } : {}),
  });
  bind(view, () => void runAction(context, "assistant.context.preview", {
    ...request(), budget: 12000,
  }, view, outcome, result), cleanup);
  bind(prompt, () => void runAction(context, "assistant.context.prompt.preview", {
    ...request(), purpose: purpose.value, question: question.value.trim(), maxTokens: 4096,
  }, prompt, promptStatus, promptResult), cleanup);
  root.append(field("シーンID", scene), field("範囲", scope), field("キャラクターID（characterのみ）", character),
    field("用途", purpose), field("質問", question), view, outcome, result, prompt, promptStatus, promptResult);
}

const contributions: Record<string, { title: string; mount: (root: HTMLElement, context: BrowserModuleContext, cleanup: Cleanup) => void }> = {
  "assistant.rewrite": { title: "ローカル言い換え", mount: mountRewrite },
  "assistant.aspect-review": { title: "章のローカルレビュー", mount: mountAspect },
  "assistant.context": { title: "外部AI向けコンテキスト", mount: mountContext },
};

export const browserModule: BrowserModuleDefinition = {
  async mount(id, root, context) {
    const contribution = contributions[id];
    if (!contribution) throw new Error("Unknown assistant contribution: " + id);
    const cleanup: Cleanup = [];
    root.replaceChildren(element("h3", contribution.title));
    contribution.mount(root, context, cleanup);
    const abort = () => {
      for (const dispose of cleanup.splice(0)) dispose();
      root.replaceChildren();
    };
    context.signal.addEventListener("abort", abort, { once: true });
    return () => {
      context.signal.removeEventListener("abort", abort);
      abort();
    };
  },
};
