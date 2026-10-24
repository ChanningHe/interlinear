import { originPattern, validateProvider, type Provider } from "../core/settings";
import { adapterOf, type OptionValue } from "../providers/adapters";
import type { ModelInfo } from "../providers/models";
import { h } from "../shared/h";
import type { Translate } from "../shared/i18n";
import type { BackgroundRequest } from "../shared/messages";
import { ICONS, field, icon, secretInput, segmented, showStatus, textInput } from "../shared/ui";
import { SIGN_IN_ORIGINS, signInWithChatGPT } from "./chatgpt-signin";
import { optionRows } from "./fields";

// The setup drawer, shared by "add" and "edit": connect → model → options, then test and save.

export interface DrawerHost {
  readonly t: Translate;
  /** Stores the service; called synchronously in the Save click so permission prompts work. */
  save(p: Provider, activate: boolean): void;
  /** After closing: drops host access and sign-ins that nothing saved uses. */
  tidy(): void;
}

const PENCIL = [
  "M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497z",
  "m15 5 4 4",
];
/** Rendering more rows than this makes the list sluggish; search narrows it instead. */
const MAX_ROWS = 200;

function send<T>(msg: BackgroundRequest): Promise<T> {
  return chrome.runtime.sendMessage<BackgroundRequest, T>(msg);
}

const hostOf = (url: string) => {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
};

const formatSize = (bytes: number) => `${(bytes / 1e9).toFixed(1)} GB`;
const formatContext = (tokens: number) => (tokens >= 1e6 ? `${Math.round(tokens / 1e5) / 10}M` : `${Math.round(tokens / 1e3)}K`);

export function openServiceDrawer(host: DrawerHost, initial: Provider, opts: { readonly isNew: boolean }): void {
  const { t } = host;
  const spec = adapterOf(initial.adapter);
  let p: Provider = initial;
  /** undefined: not connected yet; []: connected but the service has no list. */
  let models: readonly ModelInfo[] | undefined;
  let connectError = "";
  let account: string | undefined;
  /** Cancels a sign-in still waiting when the drawer closes. */
  const signInAbort = new AbortController();
  /** Save tidies after storing; tidying here as well would race it with the old settings. */
  let saving = false;
  let query = "";
  let freeOnly = false;

  const dialog = h("dialog", { class: "sheet drawer", "aria-label": p.name });
  const body = h("div", { class: "drawer-body" });
  const status = h("span", { class: "status", role: "status" });
  const patch = (next: Partial<Provider>) => {
    p = { ...p, ...next };
  };

  // ---- header: the service's own name, editable in place --------------------------------------
  const nameInput = textInput(p.name, (v) => patch({ name: v }), { class: "name-input", type: "text", "aria-label": t("rename") });
  const head = h(
    "header",
    { class: "sheet-head" },
    h("span", { class: `logo lg l-${spec.id}`, "aria-hidden": "true" }, spec.mark),
    h("div", { style: "flex: 1; min-width: 0" }, h("label", { class: "name-edit" }, nameInput, icon(PENCIL, 14)), h("div", { class: "kind" }, t(spec.label))),
    h("button", { class: "ghost icon", title: t("close"), "aria-label": t("close"), onClick: () => dialog.close() }, "✕"),
  );

  const stepHead = (n: number, title: string, done: boolean, aside?: Node | string | null) =>
    h("div", { class: "step-head" }, h("span", { class: done ? "num done" : "num" }, done ? "✓" : String(n)), h("h3", {}, title), aside ?? null);

  // ---- 1. connect -------------------------------------------------------------------------
  async function loadModels(): Promise<void> {
    connectError = "";
    const res = await send<{ ok: boolean; models?: ModelInfo[]; error?: string }>({ type: "list-models", provider: p });
    if (res.ok) models = res.models ?? [];
    else connectError = res.error ?? t("unknownError");
    render();
  }

  /** In the click: request access to this service's host, then list its models. */
  function connect(button: HTMLButtonElement): void {
    let granted: Promise<boolean>;
    try {
      granted = chrome.permissions.request({ origins: [originPattern(p.endpoint)] });
    } catch {
      connectError = t("endpointInvalid");
      return render();
    }
    button.disabled = true;
    button.textContent = t("connecting");
    granted
      .then((ok) => {
        if (ok) return loadModels();
        connectError = t("hostDenied");
        render();
      })
      .catch((e: unknown) => {
        connectError = e instanceof Error ? e.message : String(e);
        render();
      });
  }

  function signIn(button: HTMLButtonElement): void {
    const granted = chrome.permissions.request({ origins: [...SIGN_IN_ORIGINS] });
    button.disabled = true;
    button.textContent = t("signingIn");
    void (async () => {
      if (!(await granted)) throw new Error(t("hostDenied"));
      const cred = await signInWithChatGPT(p.id, signInAbort.signal);
      account = cred.email;
      await loadModels();
    })().catch((e: unknown) => {
      if (signInAbort.signal.aborted) return;
      connectError = e instanceof Error ? e.message : String(e);
      render();
    });
  }

  /** A changed address or key invalidates what "Connected" and the model list said. */
  const resetConnection = () => {
    if (models === undefined) return;
    models = undefined;
    render();
  };

  function signOut(): void {
    void send({ type: "chatgpt-sign-out", providerId: p.id }).then(() => {
      account = undefined;
      models = undefined;
      render();
    });
  }

  function connectStep(): HTMLElement {
    if (spec.auth === "oauth") {
      const signedIn = account !== undefined;
      const content = signedIn
        ? h(
            "div",
            { class: "account" },
            h("span", { class: "avatar", "aria-hidden": "true" }),
            h("span", { class: "account-email" }, account || t("connected")),
            h("button", { class: "ghost danger", onClick: signOut }, t("signOut")),
          )
        : h(
            "div",
            { class: "signin" },
            h("button", { class: "chatgpt", onClick: (e: Event) => signIn(e.currentTarget as HTMLButtonElement) }, t("signInChatgpt")),
            h("span", { class: "hint" }, t("signInHint")),
            h("ul", { class: "signin-points" }, h("li", {}, t("signInPlan")), h("li", {}, t("signInCap")), h("li", {}, t("signInScope"))),
          );
      return h(
        "section",
        { class: "step" },
        stepHead(1, t("stepConnect"), signedIn),
        content,
        signedIn ? h("a", { class: "hint", href: "https://chatgpt.com/settings/usage", target: "_blank", rel: "noopener" }, t("manageUsage")) : null,
        connectError ? h("span", { class: "status error" }, connectError) : null,
      );
    }
    const connected = models !== undefined;
    const endpoint = spec.editableEndpoint
      ? field(t("fieldEndpoint"), textInput(p.endpoint, (v) => patch({ endpoint: v.trim() }), { type: "url", spellcheck: false, placeholder: spec.endpoint || "https://…/v1/chat/completions", onChange: resetConnection }))
      : null;
    const key =
      spec.auth === "none"
        ? null
        : field(
            t("fieldApiKey"),
            secretInput(p.apiKey, (v) => patch({ apiKey: v.trim() }), { show: t("showKey"), hide: t("hideKey") }, {
              autocomplete: "new-password",
              onChange: resetConnection,
              placeholder: spec.auth === "optionalKey" ? t("apiKeyPlaceholder") : "",
            }),
          );
    const keyHint = spec.keyUrl
      ? h("span", { class: "hint" }, h("a", { href: spec.keyUrl, target: "_blank", rel: "noopener" }, t("getKey", { host: hostOf(spec.keyUrl) })), " · ", t("keyStaysLocal"))
      : null;
    return h(
      "section",
      { class: "step" },
      stepHead(1, t("stepConnect"), connected, connected ? h("span", { class: "muted" }, t("connected")) : null),
      endpoint,
      key,
      keyHint,
      h("div", { class: "row" }, h("button", { onClick: (e: Event) => connect(e.currentTarget as HTMLButtonElement) }, t("connect"))),
      connectError ? h("span", { class: "status error" }, t("connectFailed", { error: connectError })) : null,
    );
  }

  // ---- 2. model -----------------------------------------------------------------------------
  const selectedModel = () => models?.find((m) => m.id === p.model);

  function columns(m: ModelInfo): Node[] {
    if (spec.models === "openrouter") {
      return [
        h("span", { class: "num" }, m.context ? formatContext(m.context) : "—"),
        h("span", { class: "num" }, m.priceIn === undefined ? "—" : `${m.priceIn} / ${m.priceOut ?? "—"}`),
        m.reasoning === "none" || !m.reasoning
          ? h("span", { class: "num" }, "—")
          : h("span", { class: "tag" }, t(m.reasoning === "mandatory" ? "reasoningMandatory" : "reasoningOptional")),
      ];
    }
    if (m.size !== undefined) return [h("span", { class: "num" }, formatSize(m.size))];
    if (m.context !== undefined) return [h("span", { class: "num" }, formatContext(m.context))];
    return [];
  }

  function modelRows(list: HTMLElement): void {
    const q = query.toLowerCase();
    const rows = (models ?? []).filter(
      (m) => (!freeOnly || m.priceIn === 0) && (!q || m.id.toLowerCase().includes(q) || (m.name ?? "").toLowerCase().includes(q)),
    );
    list.replaceChildren(
      ...rows.slice(0, MAX_ROWS).map((m) => {
        const extra = columns(m);
        const radio = h("input", { type: "radio", name: "model", checked: m.id === p.model, "aria-label": m.id });
        radio.addEventListener("change", () => {
          patch({ model: m.id });
          render();
        });
        return h(
          "label",
          { class: m.id === p.model ? "model-row selected" : "model-row" },
          radio,
          h("span", { class: "id", title: m.name ?? m.id }, m.id),
          ...extra,
        );
      }),
    );
  }

  function modelStep(): HTMLElement {
    const aside = models && models.length > 0 ? h("span", { class: "muted" }, t("modelsCount", { count: models.length })) : null;
    const head = stepHead(2, t("stepModel"), p.model !== "", aside);
    if (!models || models.length === 0) {
      const manual = field(t("modelId"), textInput(p.model, (v) => patch({ model: v.trim() }), { spellcheck: false, placeholder: "model id" }));
      const hint = models ? t("modelsUnavailable") : spec.auth === "oauth" ? t("signInFirst") : t("connectFirst");
      return h("section", { class: "step" }, head, manual, h("span", { class: "hint" }, hint));
    }
    const list = h("div", { class: "models", role: "radiogroup", "aria-label": t("stepModel") });
    const search = h("input", { type: "search", value: query, placeholder: t("searchModels"), "aria-label": t("searchModels") });
    search.addEventListener("input", () => {
      query = search.value;
      modelRows(list);
    });
    let filters: HTMLElement | null = null;
    if (spec.models === "openrouter") {
      const choices = [
        { value: "all", label: t("filterAll") },
        { value: "free", label: t("filterFree") },
      ];
      filters = segmented(freeOnly ? "free" : "all", choices, (v) => {
        freeOnly = v === "free";
        modelRows(list);
      }, t("stepModel"));
      filters.classList.add("small");
    }
    modelRows(list);
    return h("section", { class: "step" }, head, h("div", { class: "inline" }, h("label", { class: "search" }, icon(ICONS.search, 15), search), filters), list);
  }

  // ---- 3. options ---------------------------------------------------------------------------
  function optionsStep(): HTMLElement | null {
    if (spec.options.length === 0) return null;
    const onChange = (key: string, v: OptionValue) => patch({ options: { ...p.options, [key]: v } });
    return h(
      "section",
      { class: "step" },
      stepHead(3, t("stepOptions"), false, h("span", { class: "muted" }, t("optionsHint"))),
      optionRows(t, spec.options, p.options, onChange, selectedModel()),
    );
  }

  function render(): void {
    body.replaceChildren(connectStep(), modelStep(), ...[optionsStep()].filter((n): n is HTMLElement => n !== null));
  }

  // ---- footer: test and save ------------------------------------------------------------------
  const problems = () => validateProvider(p).map((k) => t(k));

  function test(): void {
    const issues = problems();
    if (issues.length > 0) return showStatus(status, issues.join("; "), "error");
    showStatus(status, t("testing"));
    const started = performance.now();
    void send<{ ok: boolean; text?: string; error?: string }>({ type: "test-provider", provider: p })
      .then((res) => {
        const seconds = ((performance.now() - started) / 1000).toFixed(1);
        if (res.ok) showStatus(status, `✓ ${t("testPassed", { seconds })} — ${res.text ?? ""}`, "ok");
        else showStatus(status, res.error ?? t("unknownError"), "error");
      })
      .catch((e: unknown) => showStatus(status, String(e), "error"));
  }

  function save(): void {
    const issues = problems();
    if (issues.length > 0) return showStatus(status, issues.join("; "), "error");
    saving = true;
    host.save({ ...p, name: p.name.trim() || t(spec.label) }, opts.isNew);
    dialog.close();
  }

  const foot = h(
    "footer",
    { class: "drawer-foot" },
    status,
    h("span", { class: "spacer" }),
    h("button", { onClick: test }, t("test")),
    h("button", { class: "primary", onClick: save }, t(opts.isNew ? "saveAndUse" : "save")),
  );

  dialog.append(head, body, foot);
  dialog.addEventListener("close", () => {
    signInAbort.abort();
    dialog.remove();
    // Access granted by Connect or sign-in, and a sign-in for a service never saved, must not linger.
    if (!saving) host.tidy();
  });
  document.body.append(dialog);
  render();
  dialog.showModal();
  // Start where the work is (the key or the sign-in button), not on the name.
  body.querySelector<HTMLElement>("input, button")?.focus();

  // Existing and local services connect by themselves when access is already granted.
  void (async () => {
    if (spec.auth === "oauth") {
      const res = await send<{ signedIn: boolean; email?: string }>({ type: "chatgpt-account", providerId: p.id });
      if (!res.signedIn) return;
      account = res.email ?? "";
      render();
    } else if (!p.endpoint || (opts.isNew && spec.auth !== "none")) {
      return;
    }
    if (await chrome.permissions.contains({ origins: [originPattern(p.endpoint)] })) await loadModels();
  })().catch(() => {});
}
